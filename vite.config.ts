import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `vite build --mode standalone` builds the UI with the fab running in the page
// (no Node server) as one chunk, which scripts/inline-standalone.mjs folds into
// a single self-contained HTML file.
export default defineConfig(({ mode }) => {
  const standalone = mode === "standalone";
  return {
    root: "src/client",
    base: standalone ? "./" : "/",
    plugins: [react()],
    build: {
      outDir: standalone ? "../../dist/standalone" : "../../dist/client",
      emptyOutDir: true,
      ...(standalone && {
        assetsInlineLimit: Number.MAX_SAFE_INTEGER,
        cssCodeSplit: false,
        modulePreload: false,
        rollupOptions: { output: { inlineDynamicImports: true } },
      }),
    },
  };
});
