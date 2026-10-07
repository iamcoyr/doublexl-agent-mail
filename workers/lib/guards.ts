// doublexl: authorization for the two non-REST surfaces, /mcp and /agents/*.

import type { Env } from "../types";
import { canAccessMailbox, sameIdentity, type Identity, type Principal } from "./authz";

// -- /mcp -----------------------------------------------------------

/** Props stored on an MCP session when it's created (agents' McpAgent `this.props`). */
export type McpSessionProps = { identity: Identity };

/** Matches the DO name agents@0.7.6 uses for streamable-HTTP sessions. */
export function mcpSessionName(sessionId: string): string {
	return `streamable-http:${sessionId}`;
}

/**
 * McpAgent stores props only when a session starts and ignores them afterwards,
 * so a session id presented by a different caller would act as the original
 * owner. Reject that: a session may only be used by the identity that opened it.
 */
export async function checkMcpSessionOwner(
	env: Env,
	request: Request,
	identity: Identity,
): Promise<Response | null> {
	const sessionId = request.headers.get("mcp-session-id");
	if (!sessionId) return null;
	const stub = env.EMAIL_MCP.get(env.EMAIL_MCP.idFromName(mcpSessionName(sessionId)));
	const owner = await stub.getSessionIdentity();
	if (owner && !sameIdentity(owner, identity)) {
		return new Response("MCP session belongs to another principal", { status: 403 });
	}
	return null;
}

/** An execution context carrying the caller's identity as MCP session props. */
export function mcpExecutionContext(ctx: ExecutionContext, identity: Identity): ExecutionContext {
	const props: McpSessionProps = { identity };
	return {
		waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise),
		passThroughOnException: () => ctx.passThroughOnException(),
		exports: ctx.exports,
		props,
	} as ExecutionContext;
}

// -- /agents/* ------------------------------------------------------

type Lobby = { className: string; name: string };

/**
 * Only the per-mailbox chat agent may be reached through /agents/*.
 * partyserver routes every Durable Object binding (including MAILBOX and
 * EMAIL_MCP) and reports the binding name as `lobby.className`.
 */
const ROUTABLE_AGENT_BINDING = "EMAIL_AGENT";

function decodeName(name: string): string | null {
	try {
		return decodeURIComponent(name);
	} catch {
		return null;
	}
}

/**
 * Hooks for routeAgentRequest. The chat UI connects to
 * /agents/email-agent/<mailboxId>; the DO is keyed by the raw path segment, so
 * both the raw and decoded names must be mailboxes the principal can access.
 */
export function agentRouteGuards(principal: Principal) {
	const check = (_req: Request, lobby: Lobby): Response | undefined => {
		if (lobby.className !== ROUTABLE_AGENT_BINDING) return new Response("Forbidden", { status: 403 });
		const decoded = decodeName(lobby.name);
		if (
			decoded === null ||
			!canAccessMailbox(principal, lobby.name) ||
			!canAccessMailbox(principal, decoded)
		) {
			return new Response("Forbidden", { status: 403 });
		}
		return undefined;
	};
	return { onBeforeConnect: check, onBeforeRequest: check };
}
