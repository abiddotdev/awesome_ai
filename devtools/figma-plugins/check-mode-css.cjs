#!/usr/bin/env node
// Checks that token-export's CSS resolves mode attributes correctly in a real
// browser.
//
// Runs token-export's built code.js against a small sample design (a stand-in
// for the figma API), loads the generated CSS into Chromium, and reads the
// computed background of a button styled with a component token for several
// arrangements of data-theme and data-color, including nested ones, and for
// token overrides placed where skill.md says they are supported.
//
// Usage: node check-mode-css.cjs   (after `npm run build` in token-export;
//        needs Playwright: npm i -g playwright && npx playwright install chromium)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("Playwright not found. Install it with: npm i -g playwright && npx playwright install chromium");
  process.exit(2);
}

// ── Sample design: Primitives → Color (brand/error) ← Theme (light/dark) ← Button
const hex = (h) => ({
  r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255,
  b: parseInt(h.slice(5, 7), 16) / 255, a: 1,
});
const alias = (id) => ({ type: "VARIABLE_ALIAS", id });
const collections = [
  { id: "c:prim", name: "Primitives", modes: [{ modeId: "p", name: "Value" }] },
  { id: "c:color", name: "Color", modes: [{ modeId: "brand", name: "Brand" }, { modeId: "error", name: "Error" }] },
  { id: "c:theme", name: "Theme", modes: [{ modeId: "light", name: "Light" }, { modeId: "dark", name: "Dark" }] },
  { id: "c:button", name: "Button", modes: [{ modeId: "b", name: "Default" }] },
].map((c) => ({ ...c, defaultModeId: c.modes[0].modeId, hiddenFromPublishing: false, variableIds: [] }));
const variables = [];
function variable(id, col, name, values) {
  const c = collections.find((x) => x.id === col);
  const valuesByMode = {};
  c.modes.forEach((m, i) => { valuesByMode[m.modeId] = values[i] ?? values[0]; });
  variables.push({
    id, name, variableCollectionId: col, resolvedType: "COLOR", valuesByMode,
    description: "", scopes: ["ALL_SCOPES"], codeSyntax: {}, hiddenFromPublishing: false,
  });
  c.variableIds.push(id);
}
variable("v:o500", "c:prim", "colors/orange/500", [hex("#c2410c")]);
variable("v:o600", "c:prim", "colors/orange/600", [hex("#a85a0a")]);
variable("v:r500", "c:prim", "colors/red/500", [hex("#dc2626")]);
variable("v:r600", "c:prim", "colors/red/600", [hex("#b91c1c")]);
variable("v:cs500", "c:color", "color-scale/500", [alias("v:o500"), alias("v:r500")]);
variable("v:cs600", "c:color", "color-scale/600", [alias("v:o600"), alias("v:r600")]);
variable("v:accent", "c:theme", "accent/fill", [alias("v:cs600"), alias("v:cs500")]);
variable("v:btn", "c:button", "button/primary/background", [alias("v:accent")]);

// ── Run token-export's code.js against it
async function exportCSS() {
  const codeJs = path.join(__dirname, "token-export", "code.js");
  if (!fs.existsSync(codeJs)) throw new Error("token-export/code.js missing: run npm run build in token-export");
  const messages = [];
  const figma = {
    root: { name: "Mode check" }, showUI() {},
    ui: { postMessage: (m) => messages.push(m), onmessage: null },
    variables: {
      getLocalVariableCollectionsAsync: async () => collections,
      getLocalVariablesAsync: async () => variables,
    },
    getLocalTextStylesAsync: async () => [],
  };
  vm.runInContext(fs.readFileSync(codeJs, "utf8"), vm.createContext({ figma, __html__: "", console, setTimeout }));
  await figma.ui.onmessage({
    type: "export", collectionIds: collections.map((c) => c.id), output: "css-md", cascadeMode: "layered",
  });
  const result = messages.find((m) => m.type === "export-data");
  const byName = Object.fromEntries(result.files.map((f) => [f.name, f.content]));
  // index.css @imports the rest; inline them in its order for a single <style>.
  const order = [...byName["index.css"].matchAll(/@import '\.\/([^']+)';/g)].map((m) => m[1]);
  const layers = (byName["index.css"].match(/^@layer [^;]+;/m) || [""])[0];
  return layers + "\n" + order.map((f) => byName[f]).join("\n");
}

// ── Arrangements and the colour each should produce
const RGB = {
  "rgb(185, 28, 28)": "red-600", "rgb(220, 38, 38)": "red-500",
  "rgb(168, 90, 10)": "orange-600", "rgb(194, 65, 12)": "orange-500",
  "rgb(0, 128, 0)": "override",
};
const button = `<button style="background: var(--button-primary-background)">x</button>`;
// A page's own (unlayered) override of a theme token.
const override = `<style>.accent-override { --accent-fill: rgb(0, 128, 0); }</style>`;
const cases = [
  ["both attributes on one wrapper", `<div data-theme="light" data-color="error">${button}</div>`, "red-600"],
  ["theme on ancestor, colour on wrapper", `<div data-theme="light"><div data-color="error">${button}</div></div>`, "red-600"],
  ["colour on ancestor, theme on wrapper", `<div data-color="error"><div data-theme="light">${button}</div></div>`, "red-600"],
  ["colour on the button itself", `<div data-theme="light"><button data-color="error" style="background: var(--button-primary-background)">x</button></div>`, "red-600"],
  ["nested colour: brand inside error", `<div data-theme="light" data-color="error"><div data-color="brand">${button}</div></div>`, "orange-600"],
  ["nested theme: dark inside light", `<div data-theme="light"><div data-theme="dark" data-color="error">${button}</div></div>`, "red-500"],
  ["dark theme, colour on inner wrapper", `<div data-theme="dark"><div data-color="error">${button}</div></div>`, "red-500"],
  ["no attributes: defaults", button, "orange-600"],
  ["override on the component itself", `<div data-theme="light" data-color="error"><button style="--button-primary-background: rgb(0, 128, 0); background: var(--button-primary-background)">x</button></div>`, "override"],
  ["override on the element with the modes", `${override}<div data-theme="light" data-color="error" class="accent-override">${button}</div>`, "override"],
];

(async () => {
  const css = await exportCSS();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let failures = 0;
  console.log(`Chromium ${browser.version()}`);
  for (const [label, html, want] of cases) {
    await page.setContent(`<style>${css}</style>${html}`);
    const rgb = await page.$eval("button", (e) => getComputedStyle(e).backgroundColor);
    const got = RGB[rgb] || rgb;
    if (got !== want) failures++;
    console.log(`${got === want ? "ok  " : "FAIL"}  ${label.padEnd(40)} got ${got.padEnd(10)} want ${want}`);
  }
  await browser.close();
  console.log(failures ? `\n${failures} of ${cases.length} cases failed` : `\nall ${cases.length} cases match`);
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
