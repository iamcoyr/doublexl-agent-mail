// doublexl: principals and mailbox authorization.
//
// Identity comes from a verified Cloudflare Access JWT:
//   - human (identity login): `email` claim
//   - agent (service token):  `common_name` claim = the token's Client ID
// Anything that can't be mapped to a principal is denied. Never fall back to allow.

import type { JWTPayload } from "jose";
import type { Env } from "../types";
import {
	domainOf,
	getAdminEmails,
	loadPrincipals,
	type Principal,
	type PrincipalsConfig,
} from "./config";

export type { Principal, PrincipalsConfig } from "./config";

/** Who is calling, before it's mapped to a principal. Serializable (stored in MCP session props). */
export type Identity =
	| { kind: "human"; email: string }
	| { kind: "agent"; clientId: string };

/** Synthetic admin used only when the worker runs in local development. */
export const DEV_PRINCIPAL: Principal = {
	kind: "human",
	id: "dev",
	email: "dev@localhost",
	role: "admin",
	mailboxes: ["*"],
};

export function identityFromJwt(payload: JWTPayload): Identity | null {
	const email = payload.email;
	if (typeof email === "string" && email.trim()) {
		return { kind: "human", email: email.trim().toLowerCase() };
	}
	const commonName = payload.common_name;
	if (typeof commonName === "string" && commonName.trim()) {
		return { kind: "agent", clientId: commonName.trim() };
	}
	return null;
}

export function sameIdentity(a: Identity, b: Identity): boolean {
	if (a.kind === "human" && b.kind === "human") return a.email === b.email;
	if (a.kind === "agent" && b.kind === "agent") return a.clientId === b.clientId;
	return false;
}

/**
 * Map an identity to a principal. `admins` (ADMIN_EMAILS) always resolve to an
 * admin, even when principals.json is missing, broken, or lists them as members.
 */
export function principalForIdentity(
	identity: Identity,
	cfg: PrincipalsConfig,
	admins: string[],
): Principal | null {
	if (identity.kind === "human") {
		const isAdmin = admins.includes(identity.email);
		const entry = cfg.find(
			(p): p is Extract<Principal, { kind: "human" }> => p.kind === "human" && p.email === identity.email,
		);
		if (entry) return isAdmin ? { ...entry, role: "admin" } : entry;
		if (isAdmin) {
			return { kind: "human", id: identity.email, email: identity.email, role: "admin", mailboxes: ["*"] };
		}
		return null;
	}
	return cfg.find((p) => p.kind === "agent" && p.serviceTokenClientId === identity.clientId) ?? null;
}

export function principalFromJwt(
	payload: JWTPayload,
	cfg: PrincipalsConfig,
	admins: string[],
): Principal | null {
	const identity = identityFromJwt(payload);
	return identity ? principalForIdentity(identity, cfg, admins) : null;
}

/**
 * Resolve an identity against the current config. A broken principals.json is
 * logged and treated as empty, which leaves only the bootstrap admins.
 */
export async function resolvePrincipal(env: Env, identity: Identity): Promise<Principal | null> {
	let cfg: PrincipalsConfig = [];
	try {
		cfg = await loadPrincipals(env);
	} catch {
		// Logged once per cache TTL by loadPrincipals. Fall back to the bootstrap admins only.
	}
	return principalForIdentity(identity, cfg, getAdminEmails(env));
}

function matchesPattern(pattern: string, mailboxId: string): boolean {
	if (pattern === "*") return true;
	if (pattern.startsWith("*@")) {
		const at = mailboxId.lastIndexOf("@");
		return at > 0 && domainOf(mailboxId) === pattern.slice(2);
	}
	return pattern === mailboxId;
}

export function canAdminister(p: Principal): boolean {
	return p.role === "admin";
}

export function canAccessMailbox(p: Principal, mailboxId: string): boolean {
	if (canAdminister(p)) return true;
	const id = mailboxId.trim().toLowerCase();
	if (!id) return false;
	return p.mailboxes.some((pattern) => matchesPattern(pattern, id));
}

/** The principal fields the UI may see. */
export function publicPrincipal(p: Principal) {
	return p.kind === "human"
		? { kind: p.kind, id: p.id, email: p.email, role: p.role }
		: { kind: p.kind, id: p.id, role: p.role };
}
