// doublexl: runtime configuration for the multi-domain mailbox.
//
// Static config comes from wrangler vars (DOMAINS, EMAIL_ADDRESSES, ADMIN_EMAILS).
// Config that names people, tokens, or private addresses lives in R2 under
// `config/` and is never committed to git.

import { z } from "zod";
import type { Env } from "../types";

export const ALIASES_KEY = "config/aliases.json";
export const PRINCIPALS_KEY = "config/principals.json";

/** How long R2 config objects are cached in module scope. */
export const CONFIG_TTL_MS = 30_000;

// -- Schemas --------------------------------------------------------

const EmailAddress = z
	.string()
	.trim()
	.toLowerCase()
	.email();

/** A mailbox pattern: an exact address, `*@domain`, or `*` (everything). */
const MailboxPattern = z
	.string()
	.trim()
	.toLowerCase()
	.refine(
		(p) => p === "*" || /^\*@[^@\s]+$/.test(p) || z.string().email().safeParse(p).success,
		{ message: "Expected an address, '*@domain', or '*'" },
	);

/** alias address -> canonical mailbox address */
export const AliasesSchema = z.record(EmailAddress, EmailAddress);
export type Aliases = z.infer<typeof AliasesSchema>;

const HumanPrincipalSchema = z.object({
	kind: z.literal("human"),
	id: z.string().min(1),
	email: EmailAddress,
	role: z.enum(["admin", "member"]),
	mailboxes: z.array(MailboxPattern),
});

const AgentPrincipalSchema = z.object({
	kind: z.literal("agent"),
	id: z.string().min(1),
	serviceTokenClientId: z.string().min(1),
	role: z.literal("member"),
	mailboxes: z.array(MailboxPattern),
});

export const PrincipalSchema = z.discriminatedUnion("kind", [
	HumanPrincipalSchema,
	AgentPrincipalSchema,
]);
export const PrincipalsSchema = z.array(PrincipalSchema);
export type Principal = z.infer<typeof PrincipalSchema>;
export type PrincipalsConfig = z.infer<typeof PrincipalsSchema>;

// -- Static (vars) config -------------------------------------------

function splitList(value: unknown): string[] {
	if (Array.isArray(value)) return value.map(String);
	if (typeof value === "string") return value.split(",");
	return [];
}

function normalizeList(value: unknown): string[] {
	return splitList(value)
		.map((v) => v.trim().toLowerCase())
		.filter(Boolean);
}

/** Domains mailboxes may be created on; also the inbound allowlist. */
export function getDomains(env: Env): string[] {
	return normalizeList(env.DOMAINS);
}

/** Upstream's optional hard allowlist of mailbox addresses. Empty means no restriction. */
export function getAllowedAddresses(env: Env): string[] {
	return normalizeList(env.EMAIL_ADDRESSES);
}

/** Bootstrap admins, so a missing or broken principals.json can't lock Coy out. */
export function getAdminEmails(env: Env): string[] {
	return normalizeList(env.ADMIN_EMAILS);
}

export function domainOf(address: string): string {
	const at = address.lastIndexOf("@");
	return at === -1 ? "" : address.slice(at + 1).toLowerCase();
}

export function isDomainAllowed(env: Env, address: string): boolean {
	const domain = domainOf(address);
	return domain !== "" && getDomains(env).includes(domain);
}

// -- R2 config with TTL cache ---------------------------------------

type CacheEntry = { value: unknown; expiresAt: number };
const cache = new Map<string, CacheEntry>();

/** Drop cached R2 config. Call after admin writes; tests call it between cases. */
export function invalidateConfigCache(key?: string): void {
	if (key) cache.delete(key);
	else cache.clear();
}

/**
 * Load and validate a JSON config object from R2.
 * A missing object yields `fallback`. An unparsable or invalid object throws:
 * callers must fail closed rather than act on a config they can't read.
 */
async function loadR2Config<T>(
	env: Env,
	key: string,
	schema: z.ZodType<T, z.ZodTypeDef, unknown>,
	fallback: T,
): Promise<T> {
	const now = Date.now();
	const hit = cache.get(key);
	if (hit && hit.expiresAt > now) return hit.value as T;

	const obj = await env.BUCKET.get(key);
	let value: T;
	if (!obj) {
		value = fallback;
	} else {
		let json: unknown;
		try {
			json = await obj.json();
		} catch {
			throw new Error(`Config ${key} is not valid JSON`);
		}
		const parsed = schema.safeParse(json);
		if (!parsed.success) {
			throw new Error(`Config ${key} is invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
		}
		value = parsed.data;
	}

	cache.set(key, { value, expiresAt: now + CONFIG_TTL_MS });
	return value;
}

export function loadAliases(env: Env): Promise<Aliases> {
	return loadR2Config(env, ALIASES_KEY, AliasesSchema, {});
}

export function loadPrincipals(env: Env): Promise<PrincipalsConfig> {
	return loadR2Config(env, PRINCIPALS_KEY, PrincipalsSchema, []);
}
