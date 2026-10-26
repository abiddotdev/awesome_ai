/* eslint-disable no-console */
// Packages the plugin's runtime files into a distributable zip.
// Uses PowerShell's Compress-Archive (no npm dependency) on Windows.
// On Unix, falls back to the `zip` CLI if available.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const REQUIRED = ["manifest.json", "code.js", "ui.html", "How to use.md"];
const DIST = "dist";

// 1. Build TypeScript → code.js
console.log("Building code.ts...");
execSync("npx tsc -p tsconfig.json", { stdio: "inherit" });

// 2. Verify build outputs exist
for (const f of REQUIRED) {
  if (!fs.existsSync(f)) {
    console.error(`✗ Missing ${f} — build may have failed.`);
    process.exit(1);
  }
}

// 3. Derive a friendly filename from the manifest
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const slug = String(manifest.name || "plugin")
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, "-")
  .replace(/^-|-$/g, "");
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const stamp =
  `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
  `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const zipName = `${slug}-${stamp}.zip`;

// 4. Ensure dist/ exists and the target file is clear
if (!fs.existsSync(DIST)) fs.mkdirSync(DIST);
const zipPath = path.join(DIST, zipName);
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

// 5. Pack using the best-available platform tool
const isWindows = os.platform() === "win32";
try {
  if (isWindows) {
    const list = REQUIRED.map((f) => `'${f}'`).join(",");
    const cmd = `powershell -NoProfile -Command "Compress-Archive -Path ${list} -DestinationPath '${zipPath}' -Force"`;
    execSync(cmd, { stdio: "inherit" });
  } else {
    execSync(`zip -j -q "${zipPath}" ${REQUIRED.map((f) => `"${f}"`).join(" ")}`, { stdio: "inherit" });
  }
} catch (err) {
  console.error("✗ Packaging failed:", err.message);
  process.exit(1);
}

// 6. Report
const size = (fs.statSync(zipPath).size / 1024).toFixed(1);
console.log(`✓ ${zipPath} (${size} KB)`);
console.log("  Contains: " + REQUIRED.join(", "));
