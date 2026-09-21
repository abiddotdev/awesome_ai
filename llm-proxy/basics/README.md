# llm-proxy-learn

A single-file (`main.go`, ~490 lines), single-provider, single-key OpenAI-compatible
reverse proxy with **proxy-attached tools and a proxy-side tool loop** — built
for one purpose: **learning dynamic tool injection**.

No frameworks, no dependencies — Go stdlib only. The client speaks normal
OpenAI protocol; the proxy attaches its own tools to every non-streaming chat
request, executes them itself when the model calls them, and the client sees
only the final answer.

## How to use

Bring it up with two env vars pointing at whatever OpenAI-compatible upstream
you want to proxy to:

```bash
export UPSTREAM_BASE_URL=https://api.openai.com   # or OpenRouter / vLLM / ...
export UPSTREAM_API_KEY=sk-...                    # your upstream key
go run main.go
# → llm-proxy-learn listening on :8080 → https://api.openai.com (tools attached: hello, byebye)
```

OpenRouter (e.g. for the `xiaomi/mimo-v2.5` model below): the proxy appends
`/v1/...` itself, so the base URL must **not** include `/v1`:

```bash
export UPSTREAM_BASE_URL=https://openrouter.ai/api   # not .../api/v1
export UPSTREAM_API_KEY=sk-or-...
```

(`LISTEN_ADDR` overrides the default `:8080`.) Point any OpenAI SDK or curl at
`http://localhost:8080/v1`; the client's own API key is discarded.

**List models** — plain passthrough to the upstream:

```bash
curl -s http://localhost:8080/v1/models | jq
```

**Chat with a proxy-attached tool** — the model calls `byebye`, the proxy
executes it, re-sends the conversation, and returns only the final answer:

```bash
curl -s http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "xiaomi/mimo-v2.5",
    "messages": [
      { "role": "user", "content": "use byebye tool" }
    ],
    "reasoning": { "enabled": false }
  }' | jq
```

```jsonc
// response — x_llm_proxy at the bottom is the proxy's stamp
{
  "choices": [
    {
      "message": { "role": "assistant", "content": "Bye bye! See you soon." },
      "finish_reason": "stop"
    }
  ],
  "x_llm_proxy": { "tools_executed": true }
}
```

**How to tell the proxy executed a tool** (vs. a plain upstream answer):

- response header `X-Llm-Proxy-Tools: executed`
- top-level `x_llm_proxy: {"tools_executed": true}` in the response body
- proxy log shows the round, e.g. `round 1: tool byebye → "Bye bye! See you soon."`
  followed by the closing `access ... rounds=1` line

Any OpenAI SDK works the same way:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8080/v1", api_key="anything")  # key discarded
r = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Greet Abidh using your greeting tool"}],
)
print(r.choices[0].message.content)   # → "Hello, Abidh!" — tool round never visible
```

## Tokens: what injection saves — and what it doesn't

**It saves tool management, not tokens.** The schemas are still sent to the
model on every request — by the proxy instead of the client — so upstream
billing is unchanged (and each tool round re-sends the full conversation,
exactly as a client-side loop would). What disappears is the client
machinery: schemas per request, parsing `tool_calls`, executing functions,
appending messages, looping, holding service credentials.

**Caching caveat:** providers prompt-cache by exact prefix, and `tools` sits
at the very front of that prefix (before system and messages). A stable tool
list keeps the whole request cache-warm; reshuffling tools per request
invalidates the cache for the *entire* conversation — often a net loss.
That is why `injectTools()` emits tools in **sorted name order** instead of
Go map order (which is randomized per iteration, so it would differ
request-to-request). If you do exercise #3, select per *stable traffic
class* (agent type, feature area), not per individual request.

## Architecture

One binary, one file. Six building blocks:

```
                ┌────────────────────────────────────────────────────┐
                │                    main.go                         │
                │                                                    │
 OpenAI client  │  ┌──────────┐   ┌─────────┐   ┌───────────────┐    │
 ──────────────►│  │  buffer  │──►│  probe  │──►│ injectTools() │    │
 POST /v1/chat/ │  │  body    │   │ stream? │   │ (JSON splice) │    │
 completions    │  └──────────┘   └─────────┘   └───────┬───────┘    │
                │                                        ▼            │
                │                               ┌────────────────┐    │
                │        ┌──────────────────────►│   ROUND LOOP   │    │
                │        │                       └───────┬────────┘    │
                │        │  append assistant+tool        ▼             │
                │        │  messages              ┌────────────┐       │
                │        └────────────────────────│ postUpstream│       │
                │                                 └──────┬─────┘       │
                │                          stream? ┌─────┴──────┐      │
                │                 yes ┌────────────┘      └─────┐      │
                │                     ▼                         ▼      │
                │              ┌────────────┐         ┌────────────────┐│
   SSE stream ◄─┼──────────────│ streamBack │         │ interceptTool  ││
                │              │ (flush per │         │ Calls + runTool││
                │              │  write)    │         └────────────────┘│
                │              └────────────┘                            │
                │   GET /v1/models ──► postUpstream ──► streamBack       │
                └────────────────────────────────────────────────────┘
                                                     │
                                                     ▼
                                          upstream (OpenAI / vLLM / ...)
```

| Block | Lines (approx) | Job |
|---|---|---|
| config | 25 | two env vars: `UPSTREAM_BASE_URL`, `UPSTREAM_API_KEY`, `LISTEN_ADDR` |
| tools | 70 | `Tool` struct + registry: `hello`, `byebye` (swap these for your service) |
| `handleChat` | 80 | the pipeline: buffer → probe → inject → round loop |
| `postUpstream` | 25 | build request, strip client `Authorization`, attach Bearer key |
| `streamBack` | 25 | copy + `Flush()` per write (SSE passthrough) |
| JSON surgery | 120 | `injectTools` / `interceptToolCalls` / `appendMessages` |

## Request flow

### Non-streaming request with tool call (the core scenario)

```
client                    proxy                              upstream
   │                         │                                   │
   │ POST chat/completions   │                                   │
   │ {messages:[...]}        │                                   │
   ├────────────────────────►│                                   │
   │                         │ buffer body                       │
   │                         │ probe: stream=false               │
   │                         │ injectTools: splice "tools":[...] │
   │                         │                                   │
   │                         │ POST (tools injected)             │
   │                         ├──────────────────────────────────►│
   │                         │                                   │ model wants
   │                         │   200 finish_reason:tool_calls    │ the hello tool
   │                         │◄──────────────────────────────────┤
   │                         │ buffer response                   │
   │                         │ interceptToolCalls → all tools    │
   │                         │   are ours? execute runTool()     │
   │                         │ appendMessages(assistant+tool)    │
   │                         │                                   │
   │                         │ POST (conversation + tool result) │
   │                         ├──────────────────────────────────►│
   │                         │   200 finish_reason:stop          │
   │                         │◄──────────────────────────────────┤
   │   200 final answer      │ not a tool_call → deliver         │
   │◄────────────────────────┤                                   │
```

The client never sees `tool_calls` and never needs to know the tools exist.
The only trace is a deliberate stamp — the `X-Llm-Proxy-Tools: executed`
header plus the top-level `x_llm_proxy.tools_executed` field — so *you* can
tell proxy-worked answers from pure upstream ones (see How to use).

### Streaming request

```
client                    proxy                              upstream
   ├─ POST stream:true ────►│                                   │
   │                        │ probe: stream=true → NO injection │
   │                        │ (interception needs the whole     │
   │                        │  body; streaming can't wait)      │
   │                        ├──────────────────────────────────►│
   │ ◄─ SSE chunk ◄─────────┤ copy + Flush per write, as they   │
   │ ◄─ SSE chunk ◄─────────┤ arrive; client disconnect kills   │
   │ ◄─ [DONE]              │ the upstream via request context  │
```

Tool definitions are *not* injected on streaming requests — if the model calls
a tool, `tool_calls` chunks stream to the client as-is. This is the documented
boundary of the technique.

### All other cases

| Path | Behavior |
|---|---|
| `GET /v1/models` | plain passthrough (SDKs probe this on init) |
| non-streaming plain answer | buffered, delivered as-is |
| non-streaming answer after proxy-executed tool rounds | stamped: `X-Llm-Proxy-Tools: executed` header + `x_llm_proxy.tools_executed:true` body field |
| `finish_reason:"tool_calls"` calling a **foreign** (client-registered) tool | delivered to client untouched — only the client can answer those |
| tool-call round but `maxToolRounds` (3) already spent | delivered as-is |
| tool execution error | becomes the tool-message content ("tool hello failed: …") so the model can recover |
| 429 / 5xx / transport error | forwarded as-is — **the client SDK owns retrying** (nested retries would multiply: SDK 2 × proxy 3 = 6 upstream hits) |

## The five ideas worth internalizing

1. **Buffer the body** — the proxy owns a `[]byte` of the request, which is
   what makes both re-sending (tool rounds) and mutation (injection) possible.
2. **Probe, don't parse** — one `json.Unmarshal` into a small struct extracts
   `stream`; everything else stays untouched bytes.
3. **Splice, don't reserialize** — all mutation goes through
   `map[string]json.RawMessage`. Fields the proxy never touches stay
   **byte-exact**; a `map[string]any` round-trip funnels numbers through
   float64 and silently corrupts values beyond 2^53 (e.g. `seed`).
   *Exercise: change one splice to `any` and send `seed: 9007199254740993`.*
4. **The round loop** — the whole proxy is one state machine:
   send → streaming? pass through : buffer → tool_calls for our tools? execute
   & append & loop : deliver. `maxToolRounds` is the termination guarantee.
5. **Flush semantics** — a streaming proxy that forgets `Flusher.Flush()`
   after every write produces SSE that arrives in one burst at the end.
   Client-disconnect cancellation is free via `NewRequestWithContext(r.Context(), …)`.

## What was deliberately left out (ideas for a fuller proxy)

| This learning version | A production proxy would add |
|---|---|
| 1 provider, 1 key, direct | multi-provider routing by model pattern, key pools with cooldowns |
| no retry (client SDK's job) | retry + Retry-After + cooldown policies |
| no token/usage accounting | SSE line-scanner + tee collectors, `/stats` endpoints |
| no hop-by-hop filtering beyond `Connection` | full RFC 7230 header hygiene |
| tools hardcoded in Go | validated tool registry, definitions loaded at startup |
| `/v1/models` passthrough | parallel fan-out, merge, dedupe, fail-open |

## Natural next exercises (in order of payoff)

1. **Real tools** — replace `hello`/`byebye` with functions that call your
   custom service over HTTP, holding server-side credentials.
2. **Dynamic definitions** — load tool definitions from a JSON file or HTTP
   endpoint at startup; this is what makes injection *dynamic* instead of
   compile-time.
3. **Per-class selection** — which tools get injected based on client/API
   key/path; the proxy becomes a policy point. Keep the selection **stable
   per traffic class**: per-request selection breaks the prompt-cache prefix
   (see Tokens above) and can cost more than it saves.
4. **Force `stream:false`** — when tools are attached, rewrite the flag in the
   body (3 lines with the splice machinery) so the loop always works.
5. **Usage across rounds** — sum `usage` tokens from every buffered round.

## Honest limits (fine for learning / POC, not for production)

- No client auth — anyone who can reach the port uses your upstream key.
- Unauthenticated `/v1/models`; no rate limiting; no metrics.
- Bodies/responses buffered up to 32 MiB in memory.
- Single upstream: its outage is your outage.
- OpenAI tool-call format only (Anthropic `tool_use` blocks would need translation).
