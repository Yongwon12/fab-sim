import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { WebSocketServer } from "ws";
import type { Scenario } from "./scenario";
import { FabCore, HttpError, type ScenarioStorage } from "./core";

export interface AppOptions {
  /** Where the scenario is saved; null = no persistence. */
  scenarioFile: string | null;
  seed?: number;
  autostart?: boolean;
}

function fileStorage(file: string): ScenarioStorage {
  return {
    load: () => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Scenario) : null),
    save: (s) => {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(s, null, 2));
      renameSync(tmp, file);
    },
  };
}

/** The fab served over HTTP (REST under /api) and a WebSocket at /ws. */
export class FabApp extends FabCore {
  private wss: WebSocketServer | null = null;

  constructor(opts: AppOptions) {
    super({ storage: opts.scenarioFile ? fileStorage(opts.scenarioFile) : null, seed: opts.seed, autostart: opts.autostart });
  }

  stop() {
    super.stop();
    this.wss?.close();
  }

  /** Returns false when the request is not an API call (static files take it). */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return false;
    try {
      if (req.method === "GET") {
        const text = this.exportText(url.pathname, url.searchParams);
        if (text) {
          res.writeHead(200, {
            "Content-Type": `${text.type}; charset=utf-8`,
            "Content-Disposition": `attachment; filename="${text.name}"`,
          });
          res.end(text.body);
          return true;
        }
      }
      const method = req.method ?? "GET";
      const body = method === "GET" || method === "DELETE" ? {} : await readJson(req);
      const { status, data } = await this.dispatch(method, url.pathname + url.search, body);
      sendJson(res, status, data);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error("[fab-sim]", err);
      sendJson(res, status, { error: (err as Error).message });
    }
    return true;
  }

  // ---------------------------------------------------------- websocket

  attachWebSocket(server: Server) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.wss = wss;
    server.on("upgrade", (req, socket, head) => {
      if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") return;
      wss.handleUpgrade(req, socket, head, (ws) => {
        const feed = this.openFeed((data) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
        });
        ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(String(raw));
            if (msg.type === "subscribe" && Array.isArray(msg.topics)) feed.setTopics(msg.topics);
          } catch {
            // ignore malformed client messages
          }
        });
        ws.on("close", () => feed.close());
      });
    });
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(new HttpError(413, "Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

