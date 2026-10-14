// Development: Vite serves the UI with hot reload, esbuild rebuilds the main
// process, Electron opens the window. The packaged app needs none of this.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "vite";

const root = new URL("..", import.meta.url).pathname;
if (!existsSync(new URL("../node_modules/electron/dist", import.meta.url))) {
  await new Promise((r) => spawn(process.execPath, ["node_modules/electron/install.js"], { cwd: root, stdio: "inherit" }).on("exit", r));
}
const vite = await createServer({ configFile: `${root}vite.config.ts` });
await vite.listen();
const url = vite.resolvedUrls.local[0];
await new Promise((r) => spawn(process.execPath, ["scripts/build-desktop.mjs"], { cwd: root, stdio: "inherit" }).on("exit", r));
const bundler = spawn(process.execPath, ["scripts/build-desktop.mjs", "--watch"], { cwd: root, stdio: "inherit" });
const electron = (await import("electron")).default;
const app = spawn(electron, ["."], { cwd: root, stdio: "inherit", env: { ...process.env, FABSIM_DEV_URL: url } });
app.on("exit", async (code) => {
  bundler.kill();
  await vite.close();
  process.exit(code ?? 0);
});
