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

// 1. Verify build outputs exist
for (const f of REQUIRED) {
  if (!fs.existsSync(f)) {
    console.error(`✗ Missing ${f} — run \`npm run build\` first.`);
    process.exit(1);
  }
}

// 2. Derive a friendly filename from the manifest
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const slug = String(manifest.name || "plugin")
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, "-")
  .replace(/^-|-$/g, "");
const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const zipName = `${slug}-${date}.zip`;

// 3. Ensure dist/ exists and the target file is clear
if (!fs.existsSync(DIST)) fs.mkdirSync(DIST);
const zipPath = path.join(DIST, zipName);
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

// 4. Pack using the best-available platform tool
const isWindows = os.platform() === "win32";
try {
  if (isWindows) {
    // PowerShell: -Force overwrites; single-quoted strings avoid space issues
    const list = REQUIRED.map((f) => `'${f}'`).join(",");
    const cmd = `powershell -NoProfile -Command "Compress-Archive -Path ${list} -DestinationPath '${zipPath}' -Force"`;
    execSync(cmd, { stdio: "inherit" });
  } else {
    // Unix: requires `zip` CLI (present on macOS and most Linux distros)
    execSync(`zip -j -q "${zipPath}" ${REQUIRED.map((f) => `"${f}"`).join(" ")}`, { stdio: "inherit" });
  }
} catch (err) {
  console.error("✗ Packaging failed:", err.message);
  process.exit(1);
}

// 5. Report
const size = (fs.statSync(zipPath).size / 1024).toFixed(1);
console.log(`✓ ${zipPath} (${size} KB)`);
console.log("  Contains: " + REQUIRED.join(", "));
