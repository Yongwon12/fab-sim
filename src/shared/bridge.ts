// The only channel between the UI (renderer) and the simulator (Electron
// main process). Exposed by the preload script as window.fabsim.

export interface SaveResult {
  saved: boolean;
  path?: string;
  error?: string;
}

export interface FabBridge {
  /** One API call, e.g. request("GET", "/api/fdc/runs?eqpId=ETCH-01"). */
  request(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }>;
  /** Replace the live-feed topic subscription of this window. */
  subscribe(topics: string[]): void;
  /** Live feed: status pushes and message batches. Returns an unsubscribe function. */
  onPush(handler: (msg: unknown) => void): () => void;
  /** Ask the simulator for an export (CSV/JSON) and save it where the user chooses. */
  saveExport(path: string): Promise<SaveResult>;
  /** Save text the UI already has (e.g. a scenario) where the user chooses. */
  saveText(name: string, text: string): Promise<SaveResult>;
  appVersion: string;
  platform: string;
}

export const IPC = {
  request: "fab:request",
  subscribe: "fab:subscribe",
  push: "fab:push",
  saveExport: "fab:save-export",
  saveText: "fab:save-text",
} as const;
