import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"],
    // Reconnect tests wait out the hook's real 2s reconnect delay.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
