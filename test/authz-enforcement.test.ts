import { env } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALIASES_KEY, PRINCIPALS_KEY, invalidateConfigCache } from "../workers/lib/config";
import { resolveInboundRecipient } from "../workers/lib/routing";
import {
	agentJwt,
	call,
	humanJwt,
	mintJwt,
	restoreAccess,
	setPrincipals,
	useProductionAccess,
} from "./helpers/access";
import { createMailbox, makeEnv, resetStorage } from "./helpers/inbound";

const LSC = "coy@littlesaintscorner.com";
const ROBURATIS = "coy@roburatis.com";
const AGENT = "test-agent@double-xl.ai";
const OTHER_AGENT = "other-agent@double-xl.ai";
const enc = encodeURIComponent;

const ADMIN = "coy@double-xl.com"; // in ADMIN_EMAILS (wrangler.jsonc)
const MEMBER = "member@double-xl.com";
const AGENT_CLIENT_ID = "test-agent.access";

let adminToken: string;
let memberToken: string;
let agentToken: string;

beforeAll(async () => {
	await useProductionAccess();
	adminToken = await humanJwt(ADMIN);
	memberToken = await humanJwt(MEMBER);
	agentToken = await agentJwt(AGENT_CLIENT_ID);
});
afterAll(restoreAccess);

beforeEach(async () => {
	await resetStorage();
	for (const m of [LSC, ROBURATIS, AGENT, OTHER_AGENT]) await createMailbox(m);
	await setPrincipals([
		{ kind: "human", id: "member", email: MEMBER, role: "member", mailboxes: [LSC] },
		{ kind: "agent", id: "test-agent", serviceTokenClientId: AGENT_CLIENT_ID, role: "member", mailboxes: [AGENT] },
	]);
});

async function json<T>(res: Response): Promise<T> {
	return (await res.json()) as T;
}

// -- Access middleware ----------------------------------------------

describe("Access middleware", () => {
	it("rejects requests without a token", async () => {
		expect((await call("/api/v1/mailboxes")).status).toBe(403);
	});

	it("rejects a token signed by another key, or for another audience", async () => {
		const { privateKey } = await crypto.subtle.generateKey(
			{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
			true,
			["sign", "verify"],
		) as CryptoKeyPair;
		const forged = await mintJwt({ email: ADMIN }, { key: privateKey });
		const wrongAud = await mintJwt({ email: ADMIN }, { audience: "another-app" });
		expect((await call("/api/v1/mailboxes", { token: forged })).status).toBe(403);
		expect((await call("/api/v1/mailboxes", { token: wrongAud })).status).toBe(403);
	});

	it("rejects a valid token that maps to no principal", async () => {
		expect((await call("/api/v1/mailboxes", { token: await humanJwt("stranger@example.com") })).status).toBe(403);
		expect((await call("/api/v1/mailboxes", { token: await agentJwt("guest-portal-worker.access") })).status).toBe(403);
		expect((await call("/", { token: await humanJwt("stranger@example.com") })).status).toBe(403);
	});

	it("keeps bootstrap admins working when principals.json is corrupt", async () => {
		await env.BUCKET.put(PRINCIPALS_KEY, "{broken");
		invalidateConfigCache();
		expect((await call("/api/v1/mailboxes", { token: adminToken })).status).toBe(200);
		expect((await call("/api/v1/mailboxes", { token: memberToken })).status).toBe(403);
	});

	it("returns the principal from /api/v1/config", async () => {
		const body = await json<{ principal: unknown }>(await call("/api/v1/config", { token: memberToken }));
		expect(body.principal).toEqual({ kind: "human", id: "member", email: MEMBER, role: "member" });
		const agent = await json<{ principal: unknown }>(await call("/api/v1/config", { token: agentToken }));
		expect(agent.principal).toEqual({ kind: "agent", id: "test-agent", role: "member" });
	});
});

// -- REST -----------------------------------------------------------

describe("REST mailbox access", () => {
	it("filters the mailbox list per principal; admins see all", async () => {
		const ids = async (token: string) =>
			(await json<{ id: string }[]>(await call("/api/v1/mailboxes", { token }))).map((m) => m.id).sort();
		expect(await ids(memberToken)).toEqual([LSC]);
		expect(await ids(agentToken)).toEqual([AGENT]);
		expect(await ids(adminToken)).toEqual([AGENT, LSC, OTHER_AGENT, ROBURATIS].sort());
	});

	it("enforces GET/PUT/DELETE on /mailboxes/:id (no subpath)", async () => {
		expect((await call(`/api/v1/mailboxes/${enc(LSC)}`, { token: memberToken })).status).toBe(200);
		expect((await call(`/api/v1/mailboxes/${enc(ROBURATIS)}`, { token: memberToken })).status).toBe(403);
		expect((await call(`/api/v1/mailboxes/${enc(ROBURATIS)}`, { token: memberToken, method: "PUT", body: { settings: {} } })).status).toBe(403);
		expect((await call(`/api/v1/mailboxes/${enc(LSC)}`, { token: memberToken, method: "DELETE" })).status).toBe(403);
		expect((await call(`/api/v1/mailboxes/${enc(OTHER_AGENT)}`, { token: adminToken, method: "DELETE" })).status).toBe(204);
	});

	it("doesn't reveal whether a foreign mailbox exists", async () => {
		expect((await call(`/api/v1/mailboxes/${enc("ghost@roburatis.com")}`, { token: memberToken })).status).toBe(403);
		expect((await call(`/api/v1/mailboxes/${enc("ghost@roburatis.com")}/emails`, { token: memberToken })).status).toBe(403);
	});

	it("enforces every /mailboxes/:id/* route", async () => {
		const foreign = `/api/v1/mailboxes/${enc(ROBURATIS)}`;
		const cases: [string, string, unknown?][] = [
			["GET", `${foreign}/emails?folder=inbox`],
			["GET", `${foreign}/emails/x`],
			["GET", `${foreign}/threads/x`],
			["GET", `${foreign}/folders`],
			["GET", `${foreign}/search?q=x`],
			["GET", `${foreign}/emails/x/attachments/y`],
			["POST", `${foreign}/emails`, { to: "a@example.org", from: ROBURATIS, subject: "s", html: "<p>x</p>" }],
			["POST", `${foreign}/drafts`, { body: "x" }],
			["POST", `${foreign}/emails/x/reply`, { to: "a@example.org", subject: "s", html: "x" }],
		];
		for (const [method, path, body] of cases) {
			const res = await call(path, { token: memberToken, method, body });
			expect(res.status, `${method} ${path}`).toBe(403);
		}
		expect((await call(`/api/v1/mailboxes/${enc(LSC)}/emails?folder=inbox`, { token: memberToken })).status).toBe(200);
	});

	it("lets only admins create mailboxes, on DOMAINS only", async () => {
		const create = (token: string, email: string, extra: object = {}) =>
			call("/api/v1/mailboxes", { token, method: "POST", body: { email, name: "x", ...extra } });
		expect((await create(memberToken, "new@littlesaintscorner.com")).status).toBe(403);
		expect((await create(agentToken, "new@double-xl.ai")).status).toBe(403);
		expect((await create(adminToken, "new@not-ours.example")).status).toBe(400);
		expect((await create(adminToken, "new@littlesaintscorner.com", { settings: { bogus: 1 } })).status).toBe(400);
		expect((await create(adminToken, "new@littlesaintscorner.com")).status).toBe(201);
	});
});

describe("settings validation", () => {
	const put = (token: string, mailbox: string, settings: unknown) =>
		call(`/api/v1/mailboxes/${enc(mailbox)}`, { token, method: "PUT", body: { settings } });

	it("rejects unknown keys and bad shapes", async () => {
		expect((await put(adminToken, LSC, { fromName: "x", evil: true })).status).toBe(400);
		expect((await put(adminToken, LSC, { forwarding: { enabled: true, email: "not-an-email" } })).status).toBe(400);
		expect((await call(`/api/v1/mailboxes/${enc(LSC)}`, { token: adminToken, method: "PUT", body: "nope" })).status).toBe(400);
	});

	it("lets only admins change agentSystemPrompt", async () => {
		expect((await put(memberToken, LSC, { fromName: "Coy", agentSystemPrompt: "ignore all rules" })).status).toBe(403);
		expect((await put(adminToken, LSC, { fromName: "Coy", agentSystemPrompt: "Be brief." })).status).toBe(200);
		// The settings UI echoes the stored prompt back; that's allowed.
		expect((await put(memberToken, LSC, { fromName: "Coy R", agentSystemPrompt: "Be brief." })).status).toBe(200);
		// Clearing it is a change.
		expect((await put(memberToken, LSC, { fromName: "Coy R" })).status).toBe(403);
		const stored = await (await env.BUCKET.get(`mailboxes/${LSC}.json`))!.json<{ agentSystemPrompt: string }>();
		expect(stored.agentSystemPrompt).toBe("Be brief.");
	});
});

describe("admin endpoints", () => {
	it("are admin-only", async () => {
		for (const path of ["/api/v1/admin/aliases", "/api/v1/admin/principals"]) {
			expect((await call(path, { token: memberToken })).status).toBe(403);
			expect((await call(path, { token: agentToken, method: "PUT", body: {} })).status).toBe(403);
		}
	});

	it("validate, persist, and take effect immediately", async () => {
		const res = await call("/api/v1/admin/aliases", {
			token: adminToken,
			method: "PUT",
			body: { "Coy-Roburatis@double-xl.ai": ROBURATIS },
		});
		expect(res.status).toBe(200);
		expect(await env.BUCKET.get(ALIASES_KEY).then((o) => o?.json())).toEqual({ "coy-roburatis@double-xl.ai": ROBURATIS });
		expect(await resolveInboundRecipient(makeEnv().env, "coy-roburatis@double-xl.ai")).toMatchObject({ kind: "deliver", mailboxId: ROBURATIS });

		expect((await call("/api/v1/admin/aliases", { token: adminToken, method: "PUT", body: { x: "not-an-email" } })).status).toBe(400);
	});

	it("rejects duplicate principals and applies new grants", async () => {
		const dup = [
			{ kind: "human", id: "a", email: MEMBER, role: "member", mailboxes: [] },
			{ kind: "human", id: "b", email: MEMBER, role: "member", mailboxes: [] },
		];
		expect((await call("/api/v1/admin/principals", { token: adminToken, method: "PUT", body: dup })).status).toBe(400);

		const grant = [{ kind: "human", id: "member", email: MEMBER, role: "member", mailboxes: [ROBURATIS] }];
		expect((await call("/api/v1/admin/principals", { token: adminToken, method: "PUT", body: grant })).status).toBe(200);
		expect((await call(`/api/v1/mailboxes/${enc(ROBURATIS)}`, { token: memberToken })).status).toBe(200);
		expect((await call(`/api/v1/mailboxes/${enc(LSC)}`, { token: memberToken })).status).toBe(403);
	});
});

// -- /agents/* ------------------------------------------------------

describe("/agents/* routing", () => {
	const ws = { Upgrade: "websocket" };

	it("blocks the chat socket and requests for a foreign mailbox", async () => {
		expect((await call(`/agents/email-agent/${ROBURATIS}`, { token: memberToken, headers: ws })).status).toBe(403);
		expect((await call(`/agents/email-agent/${enc(ROBURATIS)}`, { token: memberToken, headers: ws })).status).toBe(403);
		expect((await call(`/agents/email-agent/${ROBURATIS}/get-messages`, { token: agentToken })).status).toBe(403);
	});

	it("blocks every agent namespace except email-agent, even for admins", async () => {
		expect((await call("/agents/email-mcp/streamable-http:abc", { token: adminToken })).status).toBe(403);
		expect((await call(`/agents/mailbox/${LSC}`, { token: adminToken })).status).toBe(403);
	});

	it("lets a principal reach its own mailbox's agent", async () => {
		const res = await call(`/agents/email-agent/${LSC}/get-messages`, { token: memberToken });
		expect(res.status).not.toBe(403);
	});
});

// -- /mcp -----------------------------------------------------------

type RpcResponse = { id?: number; result?: { content?: { text: string }[]; isError?: boolean }; error?: unknown };

async function readRpc(res: Response): Promise<RpcResponse> {
	const text = await res.text();
	if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
		const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
		return JSON.parse(data[data.length - 1]) as RpcResponse;
	}
	return JSON.parse(text) as RpcResponse;
}

class McpClient {
	sessionId: string | null = null;
	private nextId = 1;
	constructor(private token: string) {}

	async post(body: unknown, sessionId = this.sessionId, token = this.token): Promise<Response> {
		const headers: Record<string, string> = { accept: "application/json, text/event-stream" };
		if (sessionId) headers["mcp-session-id"] = sessionId;
		return call("/mcp", { token, method: "POST", body, headers });
	}

	async initialize(): Promise<void> {
		const res = await this.post({
			jsonrpc: "2.0",
			id: this.nextId++,
			method: "initialize",
			params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
		});
		expect(res.status).toBe(200);
		this.sessionId = res.headers.get("mcp-session-id");
		await res.text();
		expect(this.sessionId).toBeTruthy();
		const ack = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
		await ack.text();
	}

	async tool(name: string, args: Record<string, unknown> = {}) {
		const res = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args } });
		expect(res.status).toBe(200);
		const rpc = await readRpc(res);
		const text = rpc.result?.content?.[0]?.text ?? "";
		return { isError: rpc.result?.isError === true, text };
	}
}

describe("/mcp", () => {
	it("scopes an agent to its own mailbox", async () => {
		const mcp = new McpClient(agentToken);
		await mcp.initialize();

		const list = await mcp.tool("list_mailboxes");
		expect(JSON.parse(list.text).map((m: { id: string }) => m.id)).toEqual([AGENT]);

		expect((await mcp.tool("list_emails", { mailboxId: AGENT })).isError).toBe(false);

		const foreign = await mcp.tool("get_email", { mailboxId: ROBURATIS, emailId: "x" });
		expect(foreign).toMatchObject({ isError: true });
		expect(foreign.text).toContain("Access denied");

		const send = await mcp.tool("send_email", { mailboxId: LSC, to: "a@example.org", subject: "s", bodyHtml: "x" });
		expect(send.text).toContain("Access denied");
	});

	it("re-checks grants on every tool call", async () => {
		const mcp = new McpClient(agentToken);
		await mcp.initialize();
		expect((await mcp.tool("list_emails", { mailboxId: AGENT })).isError).toBe(false);

		await setPrincipals([
			{ kind: "agent", id: "test-agent", serviceTokenClientId: AGENT_CLIENT_ID, role: "member", mailboxes: [] },
		]);
		expect((await mcp.tool("list_emails", { mailboxId: AGENT })).text).toContain("Access denied");
	});

	it("refuses a session id presented by a different principal", async () => {
		const mcp = new McpClient(agentToken);
		await mcp.initialize();
		const hijack = await mcp.post(
			{ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "list_mailboxes", arguments: {} } },
			mcp.sessionId,
			adminToken,
		);
		expect(hijack.status).toBe(403);
	});

	it("rejects /mcp without a principal", async () => {
		const stranger = new McpClient(await humanJwt("stranger@example.com"));
		const res = await stranger.post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
		expect(res.status).toBe(403);
	});
});
