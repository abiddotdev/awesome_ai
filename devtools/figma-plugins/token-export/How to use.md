# Token Export — How to use

A Figma plugin that exports variable collections as CSS custom properties, a token-reference skill file for AI agents, or raw JSON.

---

## 1. Install in Figma desktop

You need the **Figma desktop app** (browser Figma doesn't support development plugins).

1. Unzip this folder anywhere on your machine.
2. Open **Figma desktop**.
3. Open any Figma file that has variable collections.
4. Top menu → **Plugins → Development → Import plugin from manifest...**
5. Select the `manifest.json` file from the unzipped folder.

The plugin is now installed. It shows up under **Plugins → Development → Token Export**.

---

## 2. Run an export

1. Open a Figma file that contains variable collections.
2. Menu → **Plugins → Development → Token Export**.
3. The plugin loads all local variable collections automatically.
4. Use the **filter** to narrow the list (supports regex — see below).
5. Check the collections you want to export.
6. Click **Continue**.
7. Pick an export format.
8. Click **Export** — a file downloads to your browser's default download location.

---

## 3. Filter

The filter input above the collection list supports regex:

| Pattern | What it does |
|---|---|
| `color` | Show collections whose name contains "color" (case-insensitive) |
| `color\|brand` | Show collections matching "color" **or** "brand" |
| `^prim` | Show collections whose name starts with "prim" |
| `!color` | **Exclude** collections containing "color" (invert match) |
| `!^(brand\|theme)` | Exclude collections starting with "brand" or "theme" |

The **Select all** checkbox and the count only apply to visible (filtered) collections.

---

## 4. Export formats

| Format | Output | Best for |
|---|---|---|
| **CSS Tokens + Skill.md** (default) | ZIP containing one `.css` file per collection, an `index.css` barrel import, and a `skill.md` | AI-assisted component building — paste the `.md` into Claude, Cursor, etc. as context |
| **Raw JSON (per mode)** | ZIP with one `.tokens.json` per mode | Feeding into a custom token pipeline or Style Dictionary |
| **Raw JSON (single file)** | One `.tokens.json` with all collections and modes merged | Quick inspection or small projects |

The downloaded file is prefixed with the Figma file name (e.g. `my-design-system-tokens.zip`).

---

## 5. Using the CSS Tokens + Skill.md output

The ZIP contains:

- **`<collection>.css`** — CSS custom properties with scope comments and `data-*` attribute selectors for multi-mode collections.
- **`index.css`** — barrel `@import` of all collection files.
- **`skill.md`** — a structured reference document covering architecture layers, usage rules, mode co-location rules, and a per-collection token inventory.

### Feed it to an AI

> Here is our design system token reference (attach `skill.md`).
> Build a card component using these tokens. Use `var(--token-name)` for all values.

### Drop it into your project

Copy the CSS files into your project and import `index.css`. Switch modes with data attributes:

```html
<div data-theme="dark" data-style="color-fill" data-color="brand">
  <button class="btn">Action</button>
</div>
```

---

## Troubleshooting

- **"Plugin not compatible..."** — make sure you're in the Figma **desktop app**, not the browser.
- **No collections shown** — the file has no local variable collections. Published library variables don't appear unless they are also defined locally.
- **Filter shows red border** — the regex is invalid. Fix the pattern or clear it.
- **Export button does nothing** — re-import the manifest; the iframe may not have loaded.
- **ZIP is empty** — you selected collections that have no variables. Check that the collections contain at least one variable.

---

## What's in this package

Three files Figma needs at runtime:

- `manifest.json` — plugin metadata
- `code.js` — sandbox code (compiled from `code.ts`)
- `ui.html` — UI with all JS inlined (includes fflate for ZIP compression)

Plus this guide.
