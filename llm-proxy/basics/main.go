// llm-proxy-learn: a single-file, single-provider, single-key OpenAI-compatible
// reverse proxy with 2 proxy-attached tools and a proxy-side tool loop.
//
// Learning goal — dynamic tool injection, nothing else. Everything here serves
// it: buffer, probe, splice, intercept, execute, re-send. Errors (429/5xx) are
// forwarded as-is; the client SDK does its own retrying. Retrying on BOTH sides
// multiplies attempts (SDK 2 × proxy 3 = 6 upstream hits), so the proxy stays out.
//
//  1. buffer the request body so it can be replayed across tool rounds
//  2. probe the body (json.Unmarshal into a struct) to detect streaming
//  3. stream SSE back with a flush after every write
//  4. inject tool definitions into the request, intercept tool_calls,
//     execute tools locally, append messages, and go around again
//  5. json.RawMessage splicing: mutate JSON without corrupting numbers
//
// Run:
//
//	UPSTREAM_BASE_URL=https://api.openai.com UPSTREAM_API_KEY=sk-... go run main.go
//	# then point your OpenAI SDK at http://localhost:8080/v1
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"sort"
	"time"
)

// ---------------------------------------------------------------------------
// config: two env vars, no YAML
// ---------------------------------------------------------------------------

var (
	upstreamBase  = mustEnv("UPSTREAM_BASE_URL") // e.g. https://api.openai.com
	upstreamKey   = mustEnv("UPSTREAM_API_KEY")  // sent as Authorization: Bearer
	listenAddr    = envOr("LISTEN_ADDR", ":8080")
	maxToolRounds = 3 // proxy-side tool execution rounds per request
)

func mustEnv(name string) string {
	v := os.Getenv(name)
	if v == "" {
		fmt.Fprintf(os.Stderr, "required env var %s is not set\n", name)
		os.Exit(1)
	}
	return v
}

func envOr(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

// ---------------------------------------------------------------------------
// tools: two MCP-style tools the proxy attaches and executes itself
// ---------------------------------------------------------------------------

type Tool struct {
	Name        string
	Description string
	Schema      string // JSON Schema for the arguments
	Fn          func(json.RawMessage) (string, error)
}

// argString is a tiny helper: pull one string field out of the args object.
// Models send arguments as a JSON object; some send a JSON-encoded string.
func argString(args json.RawMessage, field string) (string, error) {
	trimmed := bytes.TrimSpace(args)
	if len(trimmed) > 0 && trimmed[0] == '"' { // string-encoded object (some models do this)
		var s string
		if err := json.Unmarshal(trimmed, &s); err != nil {
			return "", err
		}
		trimmed = []byte(s)
	}
	if len(trimmed) == 0 {
		trimmed = []byte("{}")
	}
	var m map[string]string
	if err := json.Unmarshal(trimmed, &m); err != nil {
		return "", fmt.Errorf("args is not an object: %w", err)
	}
	return m[field], nil
}

var toolRegistry = map[string]Tool{
	"hello": {
		Name:        "hello",
		Description: "Say hello to someone. Use when the user wants a greeting.",
		Schema:      `{"type":"object","properties":{"name":{"type":"string","description":"Who to greet"}},"required":["name"]}`,
		Fn: func(args json.RawMessage) (string, error) {
			name, err := argString(args, "name")
			if err != nil {
				return "", err
			}
			if name == "" {
				return "", fmt.Errorf(`missing required argument "name"`)
			}
			return "Hello, " + name + "!", nil
		},
	},
	"byebye": {
		Name:        "byebye",
		Description: "Say goodbye. Use when the user is leaving or done.",
		Schema:      `{"type":"object","properties":{"name":{"type":"string","description":"Who to say goodbye to (optional)"}}}`,
		Fn: func(args json.RawMessage) (string, error) {
			name, err := argString(args, "name")
			if err != nil {
				return "", err
			}
			if name != "" {
				return "Bye bye, " + name + "! See you soon.", nil
			}
			return "Bye bye! See you soon.", nil
		},
	},
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

// upstreamClient is shared by every request: connection pooling (keep-alive
// reuse) lives in the Transport, not the client. MaxIdleConnsPerHost=100
// because the stdlib default of 2 silently churns TCP+TLS under concurrency.
var upstreamClient = &http.Client{
	Transport: &http.Transport{MaxIdleConnsPerHost: 100},
	// Proxy behavior: hand 3xx responses through instead of following them.
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/chat/completions", handleChat)
	mux.HandleFunc("/v1/models", handleModels)
	log.Printf("llm-proxy-learn listening on %s → %s (tools attached: hello, byebye)",
		listenAddr, upstreamBase)
	log.Fatal(http.ListenAndServe(listenAddr, mux))
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

// toolCall is one entry of choices[0].message.tool_calls.
type toolCall struct {
	ID   string
	Name string
	Args json.RawMessage
}

func handleChat(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	// (1) Buffer the body. We need the bytes in memory because we may send
	// them upstream several times (tool rounds).
	body, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		logAccess(r, start, http.StatusBadRequest, "body_read_error")
		http.Error(w, "cannot read body: "+err.Error(), http.StatusBadRequest)
		return
	}

	// (2) Probe: is this a streaming request? Any other JSON field we might
	// care about goes here. Non-JSON bodies just pass through (best effort).
	var probe struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	json.Unmarshal(body, &probe) // ignore error: non-JSON → stream=false, forward as-is
	detail := fmt.Sprintf("model=%q stream=%v", probe.Model, probe.Stream)
	if len(body) > 0 && probe.Model == "" && !probe.Stream {
		detail += " (body not JSON?)"
	}

	// (3) Inject our tool definitions (non-streaming only; streaming requests
	// carry the tools but tool_calls are passed straight to the client).
	if !probe.Stream {
		if nb, err := injectTools(body); err == nil {
			body = nb
		}
	}

	// (4) The round loop: send upstream, maybe intercept tool calls, repeat.
	toolRounds := 0 // proxy-executed tool rounds; >0 means the proxy worked on this answer
	for round := 0; ; round++ {
		resp, err := postUpstream(r, body)
		if err != nil {
			// Never retried: transport errors are usually client-cancel or dead network.
			logAccess(r, start, http.StatusBadGateway, detail+" upstream_unreachable")
			writeError(w, http.StatusBadGateway, "upstream transport error: "+err.Error())
			return
		}

		// No retry: error statuses (429/5xx) fall through to the buffered path,
		// where interceptToolCalls sees finish_reason != "tool_calls" and they
		// are delivered to the client as-is. The client SDK owns retrying.
		if probe.Stream {
			// Streaming path: pass bytes through with a flush per write.
			// No tool interception — tool_calls chunks stream to the client as-is.
			streamBack(w, resp)
			logAccess(r, start, resp.StatusCode, detail+" stream")
			return
		}

		// Non-streaming: buffer the whole response so we can inspect it.
		buf, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
		resp.Body.Close()
		if err != nil {
			logAccess(r, start, http.StatusBadGateway, detail+" upstream_body_error")
			writeError(w, http.StatusBadGateway, "reading upstream body: "+err.Error())
			return
		}

		// Tool loop: is this a tool_calls answer aimed at OUR tools?
		calls, ok := interceptToolCalls(buf)
		if !ok || round >= maxToolRounds {
			logAccess(r, start, resp.StatusCode, fmt.Sprintf("%s rounds=%d", detail, round))
			forwardBuffered(w, resp.StatusCode, buf, toolRounds > 0) // final answer (or budget spent)
			return
		}

		// Execute each tool, build assistant + tool-role messages, append
		// them to the conversation, and go around again.
		msgs := []json.RawMessage{}
		assistant := extractAssistantMessage(buf)
		msgs = append(msgs, assistant)
		for _, c := range calls {
			result := runTool(c)
			log.Printf("round %d: tool %s → %q", round+1, c.Name, result)
			msgs = append(msgs, toolMessage(c.ID, result))
		}
		toolRounds++
		body, err = appendMessages(body, msgs...)
		if err != nil {
			logAccess(r, start, resp.StatusCode, fmt.Sprintf("%s rounds=%d append_failed", detail, round+1))
			forwardBuffered(w, resp.StatusCode, buf, toolRounds > 0) // can't continue; deliver as-is
			return
		}
	}
}

// handleModels passes GET /v1/models through to the upstream.
func handleModels(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	resp, err := postUpstream(r, nil)
	if err != nil {
		logAccess(r, start, http.StatusBadGateway, "upstream_unreachable")
		writeError(w, http.StatusBadGateway, "upstream transport error: "+err.Error())
		return
	}
	streamBack(w, resp)
	logAccess(r, start, resp.StatusCode, "passthrough")
}

// ---------------------------------------------------------------------------
// upstream plumbing
// ---------------------------------------------------------------------------

// postUpstream builds and sends one request to the upstream, attaching the
// API key and cleaning client credentials.
func postUpstream(r *http.Request, body []byte) (*http.Response, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, upstreamBase+r.URL.Path, rd)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.ContentLength = int64(len(body))
	}
	req.Header = r.Header.Clone()
	req.Header.Del("Connection")
	req.Header.Del("Authorization") // client credentials never travel upstream
	req.Header.Set("Authorization", "Bearer "+upstreamKey)
	req.Header.Set("Accept-Encoding", "identity") // plain bytes so tool-loop parsing works
	return upstreamClient.Do(req)
}

// streamBack copies the upstream response to the client, flushing after
// every write so SSE events arrive the moment they do upstream.
func streamBack(w http.ResponseWriter, resp *http.Response) {
	defer resp.Body.Close()
	copyHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return // client went away; nothing else to do
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if rerr != nil {
			return // EOF or error; either way we're done
		}
	}
}

// forwardBuffered replays a response we already have fully in memory. When
// the proxy executed tools on the way to this answer, it stamps the response:
// an X-Llm-Proxy-Tools header, plus a top-level x_llm_proxy field inside the
// JSON — so clients can tell "the proxy worked on this" from "pure upstream".
func forwardBuffered(w http.ResponseWriter, status int, buf []byte, toolLooped bool) {
	if toolLooped {
		w.Header().Set("X-Llm-Proxy-Tools", "executed")
		// RawMessage splice: add x_llm_proxy without disturbing any other byte.
		var m map[string]json.RawMessage
		if json.Unmarshal(buf, &m) == nil && m != nil {
			stamp, _ := json.Marshal(map[string]any{"tools_executed": true})
			m["x_llm_proxy"] = stamp
			if nb, err := json.Marshal(m); err == nil {
				buf = nb
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(buf)
}

func copyHeaders(dst, src http.Header) {
	for k, vv := range src {
		for _, v := range vv {
			dst.Add(k, v)
		}
	}
}

// logAccess emits ONE line when a request is finished — never mid-flight, so
// a line always means "this request is done". Kept crude on purpose: no
// levels, no JSON, no request IDs. Never log bodies, never log keys.
func logAccess(r *http.Request, start time.Time, status int, detail string) {
	log.Printf("access %s %s client=%s status=%d %s duration=%dms",
		r.Method, r.URL.Path, clientIP(r), status, detail, time.Since(start).Milliseconds())
}

// clientIP is the remote peer; behind a local proxy chain that is the
// immediate hop, which is all a learning proxy needs.
func clientIP(r *http.Request) string {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// ---------------------------------------------------------------------------
// JSON surgery — the interesting part
// ---------------------------------------------------------------------------

// injectTools splices our tool definitions into the request's "tools" array
// using map[string]json.RawMessage: every field we don't touch stays
// byte-exact (a map[string]any round-trip would funnel all numbers through
// float64 and corrupt big ints like seeds).
func injectTools(body []byte) ([]byte, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(body, &m); err != nil {
		return body, err
	}
	// Only chat requests make sense to equip.
	if _, ok := m["messages"]; !ok {
		return body, nil
	}
	// Build the OpenAI function-tool wire format. Sorted name order on
	// purpose: tools sit at the FRONT of the prompt-cache prefix, and Go map
	// iteration is randomized per iteration — unsorted would shuffle the
	// request bytes and break upstream prompt caching request-to-request.
	names := make([]string, 0, len(toolRegistry))
	for name := range toolRegistry {
		names = append(names, name)
	}
	sort.Strings(names)
	add := make([]json.RawMessage, 0, len(toolRegistry))
	for _, name := range names {
		t := toolRegistry[name]
		add = append(add, json.RawMessage(fmt.Sprintf(
			`{"type":"function","function":{"name":%q,"description":%q,"parameters":%s}}`,
			t.Name, t.Description, t.Schema)))
	}
	m["tools"] = appendToArray(m["tools"], add)
	return json.Marshal(m)
}

// appendToArray parses raw as an array (empty if absent), appends, re-marshals.
func appendToArray(raw json.RawMessage, add []json.RawMessage) json.RawMessage {
	var arr []json.RawMessage
	if len(raw) > 0 && string(raw) != "null" {
		json.Unmarshal(raw, &arr) // if it's not an array we quietly start fresh
	}
	arr = append(arr, add...)
	b, _ := json.Marshal(arr)
	return b
}

// interceptToolCalls decides whether a buffered response is a tool_calls
// answer the proxy can answer entirely itself: exactly one choice,
// finish_reason "tool_calls", every called tool in our registry.
func interceptToolCalls(buf []byte) ([]toolCall, bool) {
	var v struct {
		Choices []struct {
			FinishReason string `json:"finish_reason"`
			Message      struct {
				ToolCalls []struct {
					ID       string `json:"id"`
					Function struct {
						Name      string          `json:"name"`
						Arguments json.RawMessage `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(buf, &v) != nil || len(v.Choices) != 1 ||
		v.Choices[0].FinishReason != "tool_calls" {
		return nil, false
	}
	tcs := v.Choices[0].Message.ToolCalls
	if len(tcs) == 0 {
		return nil, false
	}
	var calls []toolCall
	for _, tc := range tcs {
		if _, managed := toolRegistry[tc.Function.Name]; !managed {
			return nil, false // foreign tool: only the client can answer it
		}
		calls = append(calls, toolCall{ID: tc.ID, Name: tc.Function.Name, Args: tc.Function.Arguments})
	}
	return calls, true
}

// extractAssistantMessage pulls choices[0].message out as raw JSON so it can
// be appended back into the conversation verbatim.
func extractAssistantMessage(buf []byte) json.RawMessage {
	var v struct {
		Choices []struct {
			Message json.RawMessage `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(buf, &v) != nil || len(v.Choices) == 0 {
		return json.RawMessage(`{}`)
	}
	return v.Choices[0].Message
}

// runTool executes one call; execution errors become the tool message
// content so the model can recover instead of the request dying.
func runTool(c toolCall) string {
	t, ok := toolRegistry[c.Name]
	if !ok {
		return "tool " + c.Name + " is not attached"
	}
	res, err := t.Fn(c.Args)
	if err != nil {
		return fmt.Sprintf("tool %s failed: %v", c.Name, err)
	}
	return res
}

// toolMessage builds the tool-role message for one executed call.
func toolMessage(id, content string) json.RawMessage {
	b, _ := json.Marshal(map[string]string{
		"role":         "tool",
		"tool_call_id": id,
		"content":      content,
	})
	return b
}

// appendMessages splices messages onto the end of the request's messages array.
func appendMessages(body []byte, msgs ...json.RawMessage) ([]byte, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(body, &m); err != nil {
		return body, err
	}
	m["messages"] = appendToArray(m["messages"], msgs)
	return json.Marshal(m)
}

// writeError answers with an OpenAI-style error envelope so client SDKs
// parse proxy failures natively.
func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"message": msg, "type": "proxy_error"},
	})
}
