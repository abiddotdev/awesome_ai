#!/usr/bin/env node
// Checks that both plugins name things identically.
//
// token-export defines the CSS variables, mode attributes and typography
// classes, and design-export-ai refers to them, so their cssVarName, slugify
// and textStyleClassName functions must agree. Each plugin is a single script
// file (Figma's sandbox rejects modules), so the functions are duplicated
// rather than shared; this loads both copies of each from source and compares
// them.
//
// Usage: node check-naming-sync.cjs   (after `npm ci` in either plugin)

const fs = require("fs");
const path = require("path");

const root = __dirname;
const ts = require(require.resolve("typescript", {
  paths: ["token-export", "design-export-ai"].map((p) => path.join(root, p)),
}));

function load(plugin, name) {
  const file = path.join(root, plugin, "code.ts");
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2020, true);
  const fn = sf.statements.find(
    (s) => ts.isFunctionDeclaration(s) && s.name && s.name.text === name
  );
  if (!fn) throw new Error(`${plugin}/code.ts has no ${name}`);
  const js = ts.transpileModule(fn.getText(sf), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return new Function(`${js}; return ${name};`)();
}

// [Figma variable name, Web code syntax or null, expected CSS variable]
const cases = [
  ["button/primary/background", null, "--button-primary-background"],
  ["Spacing 4", null, "--spacing-4"],
  ["Spacing/Large (L)", null, "--spacing-large-l"],
  ["UPPER/Case", null, "--upper-case"],
  ["color/50%", null, "--color-50"],
  ["ds.utils/gap", null, "--ds-utils-gap"],
  ["Brand/Primary_500", null, "--brand-primary-500"],
  ["/leading/slash/", null, "--leading-slash"],
  ["a--b", null, "--a-b"],
  ["Größe/Groß", null, "--gr-e-gro"],
  ["emoji/🔥hot", null, "--emoji-hot"],
  ["tab\tname", null, "--tab-name"],
  ["primaryColor/hover", null, "--primarycolor-hover"],
  ["radius/2", "var(--radius-sm)", "--radius-sm"],
  ["radius/2", "var(--radius-sm, 8px)", "--radius-sm"],
  ["radius/2", "var( --radius-sm )", "--radius-sm"],
  ["radius/3", "--radius-md", "--radius-md"],
  ["radius/4", "radius-lg", "--radius-4"],
];

// [collection or mode name, expected slug] for data-<collection>="<mode>"
const slugCases = [
  ["Theme", "theme"],
  ["Dark", "dark"],
  ["Light Mode", "light-mode"],
  ["High-Contrast", "high-contrast"],
  [" Brand  Colors ", "brand-colors"],
  ["ds.utils", "ds-utils"],
  ["Größe", "gr-e"],
];

let failures = 0;
let total = 0;
function check(label, a, b, expected) {
  total++;
  const ok = a === expected && b === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${JSON.stringify(label)}  token-export=${a}  design-export-ai=${b}  expected=${expected}`);
}

const varA = load("token-export", "cssVarName");
const varB = load("design-export-ai", "cssVarName");
console.log("cssVarName");
for (const [name, web, expected] of cases) {
  const v = { name, codeSyntax: web ? { WEB: web } : {} };
  check(web ? `${name} (code syntax ${web})` : name, varA(v), varB(v), expected);
}

const slugA = load("token-export", "slugify");
const slugB = load("design-export-ai", "slugify");
console.log("\nslugify");
for (const [name, expected] of slugCases) check(name, slugA(name), slugB(name), expected);

// [text style name, expected typography.css class]
const textCases = [
  ["Headline/1", "text-headline-1"],
  ["Body/Medium", "text-body-medium"],
  ["Label / Small Caps", "text-label-small-caps"],
  ["Display.XL", "text-display-xl"],
];
const classA = load("token-export", "textStyleClassName");
const classB = load("design-export-ai", "textStyleClassName");
console.log("\ntextStyleClassName");
for (const [name, expected] of textCases) check(name, classA(name), classB(name), expected);

console.log(failures ? `\n${failures} of ${total} cases failed` : `\nall ${total} cases match`);
process.exit(failures ? 1 : 0);
