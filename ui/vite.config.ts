import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3333",
    },
  },
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        // E5 S7 — vendor chunk split for Lighthouse perf. Pre-split bundle
        // was 765KB single chunk; HTTP/2 multiplexing benefits from
        // smaller parallel-loadable vendor chunks.
        manualChunks: {
          three: ["three"],
          d3: ["d3-force"],
          react: ["react", "react-dom"],
        },
      },
    },
  },
});
