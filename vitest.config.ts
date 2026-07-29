import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["core/**/*.test.ts", "test/**/*.test.ts", "scripts/**/*.test.ts"], environment: "node" },
});
