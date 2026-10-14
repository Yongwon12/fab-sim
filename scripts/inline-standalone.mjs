// Folds dist/standalone (index.html + one JS + one CSS) into a single
// self-contained file, dist/fab-sim.html, that opens straight from disk or any
// static host. Run after `vite build --mode standalone`.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = "dist/standalone";
let html = readFileSync(join(dir, "index.html"), "utf8");
const read = (href) => readFileSync(join(dir, href.replace(/^\.\//, "")), "utf8");

html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_, href) => `<style>\n${read(href)}\n</style>`);
html = html.replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_, src) => {
  // Keep the code from closing the inline <script> early.
  const js = read(src).replace(/<\/script/gi, "<\\/script");
  return `<script type="module">\n${js}\n</script>`;
});
if (/(href|src)="\.\/assets\//.test(html)) throw new Error("standalone build still references assets/ files");

writeFileSync("dist/fab-sim.html", html);
console.log(`dist/fab-sim.html  ${(html.length / 1024).toFixed(0)} kB`);
