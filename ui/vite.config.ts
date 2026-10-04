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
        // react in its own chunk so the app chunk caches across releases.
        manualChunks: {
          react: ["react", "react-dom"],
        },
      },
    },
  },
});
