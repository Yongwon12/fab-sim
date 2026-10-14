import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { FabApp } from "./app";

// fab-sim server: one process runs the equipment simulator, the four fab
// systems, the REST/WebSocket API and serves the unified UI.
//   npm run dev     → UI through Vite (hot reload)
//   npm start       → UI from dist/client (run `npm run build` first)
// Options: --port 4870  --host 127.0.0.1  --data ./data  --no-persist  --paused  --seed 1234

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, d: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dev = flag("dev");
const port = Number(opt("port", process.env.PORT ?? "4870"));
const host = opt("host", process.env.HOST ?? "127.0.0.1");
const dataDir = resolve(opt("data", join(root, "data")));
const seed = flag("seed") ? Number(opt("seed", "20261014")) : undefined;

const app = new FabApp({
  scenarioFile: flag("no-persist") ? null : join(dataDir, "scenario.json"),
  seed,
  autostart: !flag("paused"),
});

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

async function main() {
  let vite: import("vite").ViteDevServer | null = null;
  if (dev) {
    const { createServer: createVite } = await import("vite");
    vite = await createVite({
      configFile: join(root, "vite.config.ts"),
      server: { middlewareMode: true, hmr: { port: port + 1 } },
      appType: "spa",
    });
  }
  const clientDir = join(root, "dist", "client");
  if (!dev && !existsSync(join(clientDir, "index.html"))) {
    console.error("[fab-sim] dist/client is missing: run `npm run build` first, or use `npm run dev`.");
    process.exit(1);
  }

  const server = createServer(async (req, res) => {
    if (await app.handle(req, res)) return;
    if (vite) {
      vite.middlewares(req, res, () => {
        res.statusCode = 404;
        res.end("Not found");
      });
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    let file = join(clientDir, rel);
    if (!file.startsWith(clientDir) || !existsSync(file) || statSync(file).isDirectory()) file = join(clientDir, "index.html");
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cache-Control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
    });
    createReadStream(file).pipe(res);
  });
  app.attachWebSocket(server);
  app.start();
  server.listen(port, host, () => {
    console.log(`[fab-sim] http://${host}:${port}  (${dev ? "dev" : "production"}, data: ${flag("no-persist") ? "not saved" : dataDir})`);
  });

  const shutdown = () => {
    app.stop();
    server.close();
    void vite?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
