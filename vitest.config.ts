import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run inside workerd via Miniflare, using the bindings from wrangler.jsonc.
// No live-account calls: remote bindings (AI, send_email) are disabled.
export default defineConfig({
	plugins: [
		cloudflareTest({
			main: "./workers/app.ts",
			remoteBindings: false,
			wrangler: { configPath: "./wrangler.jsonc" },
		}),
	],
	resolve: {
		alias: {
			// The React Router server build only exists after `react-router build`.
			"virtual:react-router/server-build": fileURLToPath(
				new URL("./test/stubs/server-build.ts", import.meta.url),
			),
		},
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
