import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // In dev, proxy API calls to a local `pnpm --filter @sesame/api dev`.
    proxy: { "/api": "http://localhost:8080" },
  },
});
