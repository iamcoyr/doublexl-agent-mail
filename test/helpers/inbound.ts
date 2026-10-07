import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../workers/app";
import { ALIASES_KEY, invalidateConfigCache } from "../../workers/lib/config";
import type { InboundMessage } from "../../workers/lib/routing";
import type { Env } from "../../workers/types";

export type FakeMessage = InboundMessage & { rejectedWith: string | null };

/** A stand-in for the ForwardableEmailMessage Email Routing hands the worker. */
export function fakeMessage(envelopeTo: string, mime: string): FakeMessage {
	const bytes = new TextEncoder().encode(mime);
	const message: FakeMessage = {
		to: envelopeTo,
		rawSize: bytes.byteLength,
		raw: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}),
		rejectedWith: null,
		setReject(reason: string) {
			message.rejectedWith = reason;
		},
	};
	return message;
}

export type AgentTrigger = { mailboxId: string; emailId: string };

/**
 * Test env: real R2 + MailboxDO bindings, with EMAIL_AGENT replaced by a
 * recorder so inbound tests never reach Workers AI.
 */
export function makeEnv(overrides: { EMAIL_ADDRESSES?: string[] } = {}) {
	const agentTriggers: AgentTrigger[] = [];
	const fakeAgents = {
		idFromName: (name: string) => name,
		get: (name: string) => ({
			fetch: async (req: Request) => {
				const body = await req.json<AgentTrigger>();
				agentTriggers.push({ mailboxId: body.mailboxId, emailId: body.emailId });
				expectNamedAfterMailbox(name, body.mailboxId);
				return new Response("{}");
			},
		}),
	} as unknown as Env["EMAIL_AGENT"];

	const testEnv: Env = { ...env, ...overrides, EMAIL_AGENT: fakeAgents } as Env;
	return { env: testEnv, agentTriggers };
}

function expectNamedAfterMailbox(doName: string, mailboxId: string) {
	if (doName !== mailboxId) throw new Error(`Agent DO ${doName} != mailbox ${mailboxId}`);
}

export async function deliver(testEnv: Env, message: FakeMessage): Promise<void> {
	const ctx = createExecutionContext();
	await worker.email(message as unknown as ForwardableEmailMessage, testEnv, ctx);
	await waitOnExecutionContext(ctx);
}

export async function createMailbox(address: string): Promise<void> {
	await env.BUCKET.put(`mailboxes/${address}.json`, JSON.stringify({ fromName: address }));
}

export async function setAliases(aliases: Record<string, string>): Promise<void> {
	await env.BUCKET.put(ALIASES_KEY, JSON.stringify(aliases));
	invalidateConfigCache();
}

/** Remove every R2 object and cached config so each test starts clean. */
export async function resetStorage(): Promise<void> {
	let cursor: string | undefined;
	do {
		const page = await env.BUCKET.list({ cursor });
		if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	invalidateConfigCache();
}

export async function inbox(mailboxId: string) {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	return stub.getEmails({ folder: "inbox", limit: 100 });
}
