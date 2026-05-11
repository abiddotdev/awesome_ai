# figma-vars

Figma plugin that exports local variable collections and text styles to CSS custom properties, design token JSON, and an AI-ready Markdown reference (`skill.md`).

---

## What it exports

### CSS + Markdown (recommended)
- One `.css` file per collection, each wrapped in a named `@layer`
- `index.css` — single entry point with `@layer` declaration and `@import` list in the correct cascade order
- `typography.css` — utility classes for every text style (`.text-headline-1`, `.text-body-medium`, etc.)
- `skill.md` — rules, architecture diagram, mode co-location guidance, and cascade strategy for AI-assisted component building
- `tokens.md` — full per-token catalog (names, aliases, scopes, descriptions); kept separate so `skill.md` stays small enough to load as agent context
- `_unresolved-aliases.md` — lists any `var()` references that point outside the exported set (would silently fail in the browser)
- `_duplicates.md` — lists CSS variable names declared more than once in the same selector block

### JSON (per-mode)
W3C Design Token format, one file per mode. Includes `$type`, `$value`, alias data, scopes, and code syntax extensions.

### JSON (single file)
All collections and modes merged into one file, keyed by collection name → mode name → token tree.

---

## Tier classification

The plugin classifies each collection into one of three tiers by reading the alias graph — no manual tagging required:

| Tier | Meaning | Rule |
|---|---|---|
| **Primitive** | Concrete values; never use directly in components | No outbound aliases into other selected collections |
| **Semantic** | Pass-through mappings | Aliases outward AND is aliased-into by other collections |
| **Component** | Top of the chain; use these in components | Aliases outward but nothing aliases back into it |

The tier controls the default import order in `index.css` (primitive → semantic → component, so component tokens win on specificity) and the Architecture section of `skill.md`.

### Overriding a tier

If the auto-classification is wrong (e.g. a utility collection references a component-layer collection, causing it to be demoted), click the tier badge on the collection selection screen to cycle it: `component → semantic → primitive → component`. Overridden badges show a dashed border. The override applies to the current export only — it is not persisted to the Figma file.

---

## Cascade modes (CSS + Markdown only)

| Mode | Behaviour |
|---|---|
| **Layered** | Each collection is wrapped in `@layer <name> { … }`. Priority is explicit and immune to bundler import-order changes. |
| **Flat** | No `@layer` wrapping. Last imported file wins for any shared variable name — order matters. |

Layered mode is recommended for any project with multiple collections that share variable names across tiers.

---

## Import order

On the second screen, collections are listed in default tier order (primitive → semantic → component). Drag the ↑ / ↓ buttons to change the order. The final order is reflected in both `index.css` and the cascade guidance in `skill.md`.

---

## Mode co-location rule

Tokens resolve via CSS `var()` chains across collections. Each hop resolves in the scope of the element that owns the defining `data-*` attribute. If mode attributes for different collections sit on different ancestor elements, intermediate hops seal to a concrete value at the wrong element, and the downstream `data-*` attribute is never consulted.

`skill.md` documents this rule in full, including which collections are coupled, correct/broken HTML examples, and a per-collection failure trace.

---

## Development

```bash
npm install       # install dependencies
npm run build     # compile code.ts → code.js
npm run watch     # watch mode
npm run pack      # zip for distribution
```

Requires Node.js and TypeScript. Open the project in VS Code and run `npm: watch` via **Terminal → Run Build Task** for live recompilation.
