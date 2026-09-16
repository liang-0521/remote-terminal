import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  build: {
    // Windows WebView2 supports logical assignment. Lowering xterm's mode-query
    // enum initialization to ES2020 with esbuild 0.25 drops its local binding
    // and stops terminal parsing when vi sends DECRQM (CSI ? ... $ p).
    target: "es2021",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
});
