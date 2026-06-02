import { defineConfig } from "vite";
import { resolve } from "node:path";
import preact from "@preact/preset-vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./src/manifest.json" with { type: "json" };

export default defineConfig({
  plugins: [preact(), crx({ manifest: manifest as any })],
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5174 },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // offscreen.html 不是 manifest 标准 entry (offscreen 走 chrome.offscreen.
    // createDocument runtime), 显式塞到 rollup input 让 vite 编 + transform
    // <script src> 指向编后的 .js.
    rollupOptions: {
      input: {
        offscreen: resolve(__dirname, "src/offscreen.html"),
        options: resolve(__dirname, "src/options.html"),
      },
    },
  },
});
