const fs = require("fs");

const js = fs.readFileSync("./ui.js", "utf8");
const template = fs.readFileSync("./ui.src.html", "utf8");
const output = template.replace(
  '<script src="ui.js"></script>',
  `<script>\n${js}\n</script>`
);
fs.writeFileSync("./ui.html", output);
console.log("ui.html generated with inlined script.");
