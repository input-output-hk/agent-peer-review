import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "ui/src/**/*.test.{ts,tsx}"],
    environment: "node",
    environmentMatchGlobs: [["ui/**", "jsdom"]],
    setupFiles: ["ui/src/test-setup.ts"],
  },
});
