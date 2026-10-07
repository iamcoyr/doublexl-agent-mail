// doublexl: Cloudflare Access JWT verification that also resolves the caller's principal.
// Replaces the upstream inline middleware in workers/app.ts.

import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "../types";
import { DEV_PRINCIPAL, identityFromJwt, resolvePrincipal, type Identity, type Principal } from "./authz";

export type AccessVariables = {
	principal: Principal;
	identity: Identity;
};

export type AccessContext = {
	Bindings: Env;
	Variables: AccessVariables;
};

export const DEV_IDENTITY: Identity = { kind: "human", email: "dev@localhost" };

function getAccessUrls(teamDomain: string) {
	const certsPath = "/cdn-cgi/access/certs";
	const teamUrl = new URL(teamDomain);
	const issuer = teamUrl.origin;
	const certsUrl = teamUrl.pathname.endsWith(certsPath)
		? teamUrl
		: new URL(certsPath, issuer);

	return { issuer, certsUrl };
}

const remoteJwks = new Map<string, JWTVerifyGetKey>();
let testJwks: JWTVerifyGetKey | null = null;

/**
 * Tests only: verify tokens against a local key set instead of the team's
 * remote certs. Nothing in the worker calls this; issuer and audience are
 * still checked against TEAM_DOMAIN and POLICY_AUD.
 */
export function setAccessJwksForTests(jwks: JWTVerifyGetKey | null): void {
	testJwks = jwks;
}

function getJwks(certsUrl: URL): JWTVerifyGetKey {
	if (testJwks) return testJwks;
	const key = certsUrl.toString();
	let jwks = remoteJwks.get(key);
	if (!jwks) {
		jwks = createRemoteJWKSet(certsUrl);
		remoteJwks.set(key, jwks);
	}
	return jwks;
}

export const accessMiddleware = createMiddleware<AccessContext>(async (c, next) => {
	// Local development: synthetic admin, or act as a configured principal with
	// `x-dev-principal: <email | service token client id>`. Production stays fail-closed below.
	if (import.meta.env.DEV) {
		const devAs = c.req.header("x-dev-principal")?.trim();
		if (!devAs) {
			c.set("identity", DEV_IDENTITY);
			c.set("principal", DEV_PRINCIPAL);
			return next();
		}
		const devIdentity: Identity = devAs.includes("@")
			? { kind: "human", email: devAs.toLowerCase() }
			: { kind: "agent", clientId: devAs };
		const devPrincipal = await resolvePrincipal(c.env, devIdentity);
		if (!devPrincipal) return c.text("Not authorized for this app", 403);
		c.set("identity", devIdentity);
		c.set("principal", devPrincipal);
		return next();
	}

	const { POLICY_AUD, TEAM_DOMAIN } = c.env;

	// Fail closed in production if Access is not configured.
	if (!POLICY_AUD || !TEAM_DOMAIN) {
		return c.text(
			"Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN.",
			500,
		);
	}

	const token = c.req.header("cf-access-jwt-assertion");
	if (!token) {
		return c.text("Missing required CF Access JWT", 403);
	}

	let identity: Identity | null;
	try {
		const { issuer, certsUrl } = getAccessUrls(TEAM_DOMAIN);
		const { payload } = await jwtVerify(token, getJwks(certsUrl), {
			issuer,
			audience: POLICY_AUD,
		});
		identity = identityFromJwt(payload);
	} catch {
		return c.text("Invalid or expired Access token", 403);
	}

	const principal = identity ? await resolvePrincipal(c.env, identity) : null;
	if (!identity || !principal) {
		return c.text("Not authorized for this app", 403);
	}

	c.set("identity", identity);
	c.set("principal", principal);
	return next();
});
