import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5200,
    proxy: {
      "/api": "http://localhost:5201",
      "/outputs": "http://localhost:5201",
      "/viewer": "http://localhost:5201",
    },
  },
  build: { outDir: "../dist", emptyOutDir: true },
});
