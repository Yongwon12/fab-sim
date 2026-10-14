import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The packaged app loads the UI from disk (file://), so assets are relative
// and the page may only load its own files: no network at all.
const contentSecurityPolicy = (): Plugin => ({
  name: "fabsim-csp",
  apply: "build",
  transformIndexHtml: (html) =>
    html.replace(
      "<head>",
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" />`,
    ),
});

export default defineConfig({
  root: "src/client",
  base: "./",
  plugins: [react(), contentSecurityPolicy()],
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
  server: {
    port: 5183,
    strictPort: true,
    host: "127.0.0.1",
  },
});
