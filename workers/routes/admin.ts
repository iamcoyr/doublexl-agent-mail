// doublexl: admin-only endpoints for the R2 config objects, so they never
// need hand-editing. Each PUT validates the whole document and writes it in
// a single R2 put, then drops the config cache.

import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { AccessContext } from "../lib/access";
import { canAdminister } from "../lib/authz";
import {
	ALIASES_KEY,
	AliasesSchema,
	PRINCIPALS_KEY,
	PrincipalsSchema,
	invalidateConfigCache,
	loadAliases,
	loadPrincipals,
	type PrincipalsConfig,
} from "../lib/config";
import { describeZodError } from "../lib/settings";

const requireAdmin = createMiddleware<AccessContext>(async (c, next) => {
	if (!canAdminister(c.var.principal)) return c.json({ error: "Forbidden" }, 403);
	await next();
});

/** Duplicate ids, emails, or client IDs would make principal lookup ambiguous. */
function findDuplicate(principals: PrincipalsConfig): string | null {
	const seen = new Set<string>();
	for (const p of principals) {
		const keys = [`id:${p.id}`, p.kind === "human" ? `email:${p.email}` : `client:${p.serviceTokenClientId}`];
		for (const key of keys) {
			if (seen.has(key)) return key;
			seen.add(key);
		}
	}
	return null;
}

export const adminApp = new Hono<AccessContext>();
adminApp.use("/api/v1/admin/*", requireAdmin);

adminApp.get("/api/v1/admin/aliases", async (c) => c.json(await loadAliases(c.env)));

adminApp.put("/api/v1/admin/aliases", async (c) => {
	const parsed = AliasesSchema.safeParse(await c.req.json().catch(() => undefined));
	if (!parsed.success) return c.json({ error: describeZodError(parsed.error) }, 400);
	await c.env.BUCKET.put(ALIASES_KEY, JSON.stringify(parsed.data, null, 2), {
		httpMetadata: { contentType: "application/json" },
	});
	invalidateConfigCache(ALIASES_KEY);
	return c.json(parsed.data);
});

adminApp.get("/api/v1/admin/principals", async (c) => c.json(await loadPrincipals(c.env)));

adminApp.put("/api/v1/admin/principals", async (c) => {
	const parsed = PrincipalsSchema.safeParse(await c.req.json().catch(() => undefined));
	if (!parsed.success) return c.json({ error: describeZodError(parsed.error) }, 400);
	const duplicate = findDuplicate(parsed.data);
	if (duplicate) return c.json({ error: `Duplicate principal ${duplicate}` }, 400);
	await c.env.BUCKET.put(PRINCIPALS_KEY, JSON.stringify(parsed.data, null, 2), {
		httpMetadata: { contentType: "application/json" },
	});
	invalidateConfigCache(PRINCIPALS_KEY);
	return c.json(parsed.data);
});
