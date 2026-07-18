import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests (tagged in the test name) spawn the real MCP server and
    // need a local DataHub. They are skipped unless RUN_INTEGRATION=1.
    environment: "node",
  },
});
