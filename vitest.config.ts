import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["core/**/*.test.ts", "cli/**/*.test.ts", "mcp/**/*.test.ts", "test/**/*.test.ts", "scripts/**/*.test.ts"], environment: "node" },
});
