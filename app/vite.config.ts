import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: { outDir: "../../out/ui", emptyOutDir: true, chunkSizeWarningLimit: 2000 },
});
