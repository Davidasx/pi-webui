import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		hookTimeout: 30_000,
		testTimeout: 15_000,
		pool: "forks",
		maxWorkers: 4,
	},
});
