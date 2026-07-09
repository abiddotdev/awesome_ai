# DesignExport AI

A Figma plugin that exports a selected node — or an entire component (all variants and variable modes) — as a single, compact JSON bundle built for AI coding agents.

Unlike a general-purpose Figma inspector, DesignExport AI only ever produces the minimal payload: pruned CSS, slim component context, and inline `var(--name, value)` tokens. There is no "full" or "verbose" mode to configure — this keeps the output small, predictable, and easy for an LLM to consume.

---

## What it produces

**Export selection** → one JSON bundle:

- `meta` — node id, name, type
- `context` — summary stats (is component, has text/vectors, child count)
- `tree` — the node hierarchy with pruned per-node CSS
- `assets.png_base64` / `assets.svg` — optional snapshots
- `aiMetadata` — any `AI Metadata:` notes found in component descriptions, hoisted once per component instead of repeated on every instance

**Export component** → one JSON bundle per component set:

- Every variant's tree
- The variant property matrix (e.g. `Size: [sm, md, lg]`)
- Every bound variable resolved across all of its modes (e.g. light/dark)

---

## Install

**From a packaged build:**

1. Unzip the distribution into any folder.
2. In Figma: **Plugins → Development → Import plugin from manifest…**
3. Select the extracted `manifest.json`.

**From source (developers):**

```bash
npm install
npm run build
```

Then import `manifest.json` as above.

---

## Use

1. Open any Figma file in **Figma** or **Dev Mode**.
2. Select a node (frame, component, instance, vector, etc.).
3. Run the plugin: **Plugins → DesignExport AI**.
4. Choose options and click **Export selection**, or **Export component** for a component/instance.
5. Review the preview, then **Copy** or **Download json**.

---

## Options

| Option | Default | What it does |
|---|---|---|
| **Include PNG** | Off | Adds a 2× raster snapshot to `assets.png_base64`. Best for AI vision models. |
| **Include SVG** | Off | Adds a vector snapshot to `assets.svg`. Use for icons. Component sets fall back to the first variant. |
| **Design token mode** | Off | Inlines `var(--name, value)` in place of raw CSS values for any property bound to a Figma variable. |
| **Tree depth** (toggle + stepper) | Off · 2 | When on, limits the exported tree to *N* levels (1–10). |

---

## Feed the output to an AI

Paste or attach the JSON (and the PNG, if included) to your AI coding tool. A prompt like:

> Here is a Figma export. Rebuild this component in React + Tailwind.
> Where a CSS value is `var(--name, value)`, prefer a matching CSS variable in this codebase if one exists — otherwise use the fallback value.

is usually enough.

---

## Dev Mode codegen

DesignExport AI also registers as a Dev Mode codegen provider — selecting any node in Dev Mode automatically shows the same JSON in the Code panel, with **PNG** and **Depth** preferences available from the codegen dropdowns.

---

## Scripts

| Command | What it runs |
|---|---|
| `npm run build` | Compiles TS → JS and inlines `ui.js` into `ui.html` |
| `npm run pack` | Build + zip runtime files to `dist/<slug>-<date>.zip` |
| `npm run lint` | ESLint check |

---

## Distribution

Only three files are needed at runtime:

- `manifest.json`
- `code.js`
- `ui.html`

`npm run pack` zips them together. Share the zip; the recipient imports `manifest.json` from the unzipped folder.
