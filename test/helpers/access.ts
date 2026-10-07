import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload } from "jose";
import { vi } from "vitest";
import worker from "../../workers/app";
import { setAccessJwksForTests } from "../../workers/lib/access";
import { PRINCIPALS_KEY, invalidateConfigCache, type PrincipalsConfig } from "../../workers/lib/config";

// Must match the test bindings in vitest.config.ts.
const TEAM_ORIGIN = "https://test.cloudflareaccess.com";
const AUDIENCE = "test-aud";

let signingKey: CryptoKey | null = null;

/**
 * Run the worker on its production path: Access verification on, against a
 * local test key set instead of the team's remote certs.
 */
export async function useProductionAccess(): Promise<void> {
	vi.stubEnv("DEV", false);
	vi.stubEnv("PROD", true);
	if (!signingKey) {
		const { publicKey, privateKey } = await generateKeyPair("RS256");
		const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" };
		setAccessJwksForTests(createLocalJWKSet({ keys: [jwk] }));
		signingKey = privateKey;
	}
}

export function restoreAccess(): void {
	vi.unstubAllEnvs();
}

type MintOptions = { audience?: string; issuer?: string; key?: CryptoKey };

export async function mintJwt(claims: JWTPayload, opts: MintOptions = {}): Promise<string> {
	const key = opts.key ?? signingKey;
	if (!key) throw new Error("call useProductionAccess() first");
	return new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", kid: "test" })
		.setIssuer(opts.issuer ?? TEAM_ORIGIN)
		.setAudience(opts.audience ?? AUDIENCE)
		.setIssuedAt()
		.setExpirationTime("5m")
		.sign(key);
}

export const humanJwt = (email: string) => mintJwt({ email, type: "app" });
export const agentJwt = (clientId: string) => mintJwt({ common_name: clientId, sub: "" });

type CallOptions = { token?: string; method?: string; body?: unknown; headers?: Record<string, string> };

/** Call the worker's fetch handler directly, as Access would forward a request. */
export async function call(path: string, opts: CallOptions = {}): Promise<Response> {
	const headers = new Headers(opts.headers);
	if (opts.token) headers.set("cf-access-jwt-assertion", opts.token);
	let body: string | undefined;
	if (opts.body !== undefined) {
		body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
		headers.set("content-type", "application/json");
	}
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(`https://agent-mail.test${path}`, { method: opts.method ?? "GET", headers, body }),
		env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return res;
}

export async function setPrincipals(principals: PrincipalsConfig): Promise<void> {
	await env.BUCKET.put(PRINCIPALS_KEY, JSON.stringify(principals));
	invalidateConfigCache();
}
