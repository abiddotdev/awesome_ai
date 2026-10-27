# Figma plugins for AI-assisted UI work

Two small Figma plugins that turn a design file into context an AI coding agent can use without blowing its
context window.

| Plugin | What it exports | Use it for |
|---|---|---|
| [`token-export`](./token-export) | Figma variables and text styles as CSS custom properties (one `@layer` per collection), `typography.css`, a `skill.md` of rules for agents, a `tokens.md` catalog, and W3C token JSON | Giving an agent your design system: which tokens to use, how modes combine, what silently breaks |
| [`design-export-ai`](./design-export-ai) | A selected node or component as compact JSON: pruned CSS per node, tokens inlined as `var(--name, fallback)`, variants and variable modes, optional PNG/SVG. Also shows in Dev Mode's code panel | Handing an agent one component or screen to build |

They are designed to be used together: Token Export defines the CSS variables, mode attributes and typography
classes, and DesignExport AI refers to them by the same names, writing tokens as `var(--name, fallback)` so a
missing variable falls back to the raw value.

## Install

Both are development plugins for the **Figma desktop app**. Each plugin's `dist/` folder holds a ready-built copy
(`manifest.json`, `code.js`, `ui.html`, `How to use.md`): in Figma, choose **Plugins → Development → Import plugin
from manifest…** and pick `token-export/dist/manifest.json` or `design-export-ai/dist/manifest.json`.

To build from source instead:

```bash
cd token-export        # or design-export-ai
npm ci
npm run build          # writes code.js next to manifest.json; import that manifest
```

After changing a plugin, rebuild and copy `manifest.json`, `code.js`, `ui.html` and `How to use.md` into its
`dist/` so the ready-built copy stays current. `npm run pack` zips the same files into `dist/` (zips are not
committed). Each plugin's own README and `How to use.md` cover options and output in detail.

Neither plugin requests network access (`"allowedDomains": ["none"]`). Everything stays in the Figma file and on
your clipboard or downloads.

## Naming contract

DesignExport AI only helps if the names it writes are the ones Token Export defines. Both plugins therefore use
the same three naming functions, duplicated because each plugin is a single script file:

| What | Rule | Example |
|---|---|---|
| CSS variable | the variable's Web code syntax if set, otherwise the path lowercased with every character outside `a-z0-9-` turned into a dash | `ds.utils/gap` → `--ds-utils-gap` |
| Mode attribute | `data-<collection>="<mode>"`, both slugged the same way; multi-mode collections only | `Theme` / `Dark` → `data-theme="dark"` |
| Typography class | `text-` plus the slugged text style name | `Body/Medium` → `.text-body-medium` |

## Checks

Two scripts guard the parts that fail silently:

| Script | Checks | Needs |
|---|---|---|
| `check-naming-sync.cjs` | Both plugins' naming functions agree on 29 cases | `npm ci` in either plugin |
| `check-mode-css.cjs` | Token Export's CSS, loaded in Chromium, gives a component token the right colour for 8 arrangements of `data-theme` and `data-color` (including nested ones) and keeps token overrides placed where `skill.md` supports them | `npm run build` in token-export, and Playwright |

```bash
node check-naming-sync.cjs
node check-mode-css.cjs      # npm i -g playwright && npx playwright install chromium
```

The mode check runs Token Export's built `code.js` against a small sample design and reads computed styles,
so it tests what the browser actually does with the exported CSS rather than what the CSS looks like.

## Known gaps

- **camelCase is not split.** `primaryColor/hover` becomes `--primarycolor-hover`, where most kebab-case tools
  would give `--primary-color-hover`. Changing it would rename variables in projects already using Token Export's
  CSS.
- **Overrides belong on the element with the mode attributes, or on the component.** To follow modes set lower in
  the page, tokens are declared again on every element with a mode attribute, so an override set on an ancestor
  above one is replaced there. `skill.md` tells the agent this.
- **The browser check covers Chromium only.** `theme-scope.css` uses `@scope` (Chrome 118+, Safari 17.4+,
  Firefox 146+). Older browsers ignore it; keeping both attributes on one element still resolves correctly there.
- **`npm run lint` reports errors in both plugins.** They predate this import: ESLint scans compiled browser output
  without DOM globals and flags the Node build scripts' `require()`.

## Layout

```
figma-plugins/
├── check-naming-sync.cjs  fails if the two plugins name variables, modes or classes differently
├── check-mode-css.cjs     fails if token-export's CSS resolves mode attributes wrongly in Chromium
├── token-export/          variables → CSS layers, typography.css, skill.md, tokens.md, JSON
│   └── dist/              ready-built plugin to import into Figma
└── design-export-ai/      node / component → compact JSON for agents
    ├── dist/              ready-built plugin to import into Figma
    └── docs/              UI concept pages explored before the inspector redesign
```
