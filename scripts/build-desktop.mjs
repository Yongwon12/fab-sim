// Bundles the Electron main process (simulator + systems) and the preload
// script into dist/desktop. The UI is built separately by Vite.
import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
};
const entries = [
  { entryPoints: ["src/desktop/main.ts"], outfile: "dist/desktop/main.cjs" },
  { entryPoints: ["src/desktop/preload.ts"], outfile: "dist/desktop/preload.cjs" },
];

if (watch) {
  for (const e of entries) await (await context({ ...common, ...e })).watch();
} else {
  await Promise.all(entries.map((e) => build({ ...common, ...e })));
}
