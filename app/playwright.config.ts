import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "test/e2e", timeout: 90000, workers: 1, reporter: "line", use: { trace: "retain-on-failure" } });
