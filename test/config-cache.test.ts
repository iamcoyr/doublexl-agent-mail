import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ALIASES_KEY, invalidateConfigCache, loadAliases } from "../workers/lib/config";
import type { Env } from "../workers/types";
import { makeEnv, resetStorage } from "./helpers/inbound";

/** An env whose R2 reads can be held open, to interleave a load with a write. */
function envWithGatedBucket() {
	let release!: () => void;
	const gate = new Promise<void>((r) => { release = r; });
	const bucket = {
		get: async (key: string) => {
			const obj = await env.BUCKET.get(key); // reads the old value now...
			await gate; // ...but returns it only after the test releases the gate
			return obj;
		},
	};
	return { env: { ...env, BUCKET: bucket } as unknown as Env, release };
}

beforeEach(resetStorage);

describe("config cache", () => {
	it("doesn't re-cache a value loaded before an invalidation", async () => {
		await env.BUCKET.put(ALIASES_KEY, JSON.stringify({ "old@double-xl.ai": "coy@roburatis.com" }));
		invalidateConfigCache();

		const slow = envWithGatedBucket();
		const inFlight = loadAliases(slow.env);

		// An admin write lands while that load is still in flight.
		await env.BUCKET.put(ALIASES_KEY, JSON.stringify({ "new@double-xl.ai": "coy@roburatis.com" }));
		invalidateConfigCache(ALIASES_KEY);

		slow.release();
		expect(await inFlight).toEqual({ "old@double-xl.ai": "coy@roburatis.com" });
		expect(await loadAliases(makeEnv().env)).toEqual({ "new@double-xl.ai": "coy@roburatis.com" });
	});

	it("serves cached values until invalidated", async () => {
		await env.BUCKET.put(ALIASES_KEY, JSON.stringify({ "a@double-xl.ai": "coy@roburatis.com" }));
		invalidateConfigCache();
		const e = makeEnv().env;
		expect(await loadAliases(e)).toEqual({ "a@double-xl.ai": "coy@roburatis.com" });
		await env.BUCKET.put(ALIASES_KEY, JSON.stringify({}));
		expect(await loadAliases(e)).toEqual({ "a@double-xl.ai": "coy@roburatis.com" });
		invalidateConfigCache(ALIASES_KEY);
		expect(await loadAliases(e)).toEqual({});
	});
});
