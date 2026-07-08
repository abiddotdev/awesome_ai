# DesignExport AI — How to use

A Figma plugin that exports a selected node — or a whole component with all its variants and modes — as a compact JSON bundle ready to paste into an AI coding agent.

---

## 1. Install in Figma desktop

You need the **Figma desktop app** (browser Figma doesn't support development plugins).

1. Unzip this folder anywhere on your machine.
2. Open **Figma desktop**.
3. Open any Figma file.
4. Top menu → **Plugins → Development → Import plugin from manifest…**
5. Select the `manifest.json` file from the unzipped folder.

The plugin is now installed. It shows up under **Plugins → Development → DesignExport AI**.

---

## 2. Run an export

1. Select any layer in your Figma file (frame, component, instance, icon — anything).
2. Menu → **Plugins → Development → DesignExport AI**.
3. Optional: adjust the options (see below).
4. Click **Export selection** — or **Export component** if you selected a component, instance, or component set and want every variant and variable mode included.
5. Review the preview.
6. Click **Copy JSON** (primary action) or **Download .json**.

If you selected a component set, a variant picker appears in the target row — choose one variant, or **All variants** to run the same export as the **Export component** button.

You can switch between **SVG** and **PNG** tabs to preview the rendered asset.

---

## 3. Options

| Option | Default | What it does |
|---|---|---|
| **Include PNG** | Off | Adds a 2× raster snapshot — best format for AI vision models. |
| **Include SVG** | Off | Adds a vector snapshot. Turn on when exporting icons. |
| **Design token mode** | Off | Inlines `var(--name, value)` wherever a CSS property is bound to a Figma variable, so the AI can match your codebase's CSS variables or fall back to the raw value. |
| **Tree depth** (toggle + stepper) | Off · 2 | When on, limits the node tree to the chosen depth (1–10). Useful for deeply nested components. |

---

## 4. Feed it to an AI

Paste the JSON (and optionally attach the PNG) into any AI coding tool — Claude, Cursor, ChatGPT, Gemini, etc.

### With design token mode on (when your codebase has matching CSS variables)

> Here is a Figma export. Rebuild this component in React + Tailwind.
> Where a value looks like `var(--name, value)`, use a matching CSS variable from this codebase if one exists — otherwise fall back to the value after the comma.

### With design token mode off (standalone / no design system)

> Here is a Figma export. Rebuild this component as a standalone React + Tailwind
> component using the raw values in `css` directly.

The JSON contains everything the AI needs: structure, layout, colors, typography, and optionally a rendered snapshot.

---

## Troubleshooting

- **"Plugin not compatible…"** — make sure you're in the Figma **desktop app**, not the browser.
- **"No node selected"** — click a layer first, then run the plugin.
- **Export button does nothing** — re-import the manifest; the iframe may not have loaded the bundled script.
- **"Use Export Node instead"** — you clicked **Export component** on a node that isn't a component, instance, or component set.
- **SVG is empty / null** — you likely selected a `COMPONENT_SET`; the plugin falls back to the first variant. If nothing renders, try enabling **Include SVG** and re-exporting.

---

## What's in this package

Just three files Figma needs at runtime:

- `manifest.json` — plugin metadata
- `code.js` — sandbox code
- `ui.html` — UI (with all JS inlined)

Plus this guide.
