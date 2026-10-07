import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("worker smoke test", () => {
	it("boots and serves GET /api/v1/config", async () => {
		const res = await exports.default.fetch("https://agent-mail.test/api/v1/config");
		expect(res.status).toBe(200);
		const body = await res.json<{ domains: string[] }>();
		expect(body.domains).toContain("double-xl.ai");
	});
});
