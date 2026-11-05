import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/engine/**/*.test.ts"], testTimeout: 30000, pool: "forks", poolOptions: { forks: { singleFork: true } } } });
