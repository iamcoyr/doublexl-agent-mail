import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../workers/app";
import { OutboundError, describeSendError } from "../workers/lib/outbound";
import type { Env } from "../workers/types";
import { createMailbox, makeEnv, resetStorage } from "./helpers/inbound";

const LSC = "coy@littlesaintscorner.com";
const FOREIGN = "coy@not-ours.example";

/** Dev-mode request (synthetic admin) against an env with a scripted EMAIL binding. */
async function send(testEnv: Env, mailboxId: string, body: object) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(`https://agent-mail.test/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		testEnv,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return res;
}

function envWithEmail(sendImpl: () => Promise<{ messageId: string }>): Env {
	return { ...makeEnv().env, EMAIL: { send: sendImpl } as unknown as SendEmail };
}

async function sentCount(mailboxId: string) {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	return (await stub.getEmails({ folder: "sent", limit: 100 })).length;
}

const message = (from: string) => ({ to: "alice@example.org", from, subject: "Hi", html: "<p>Hi</p>" });

beforeEach(async () => {
	await resetStorage();
	await createMailbox(LSC);
	await createMailbox(FOREIGN);
});

describe("describeSendError", () => {
	it("names the domain when it isn't onboarded for sending", () => {
		const e = describeSendError({ code: "E_SENDER_DOMAIN_NOT_AVAILABLE", message: "x" }, LSC);
		expect(e).toBeInstanceOf(OutboundError);
		expect(e.status).toBe(400);
		expect(e.message).toBe(
			"littlesaintscorner.com is not enabled for sending (Email Service). Onboard it before sending from coy@littlesaintscorner.com.",
		);
	});

	it("maps quota errors to 429 and unknown errors to 502", () => {
		expect(describeSendError({ code: "E_DAILY_LIMIT_EXCEEDED" }, LSC).status).toBe(429);
		expect(describeSendError(new Error("boom"), LSC)).toMatchObject({ status: 502, message: "Failed to send: boom" });
	});
});

describe("REST send", () => {
	it("sends and keeps a Sent copy on success", async () => {
		let calls = 0;
		const sentBefore = await sentCount(LSC);
		const res = await send(envWithEmail(async () => { calls++; return { messageId: "m1" }; }), LSC, message(LSC));
		expect(res.status).toBe(202);
		expect(calls).toBe(1);
		expect(await sentCount(LSC)).toBe(sentBefore + 1);
	});

	it("refuses to send from a domain outside DOMAINS", async () => {
		let calls = 0;
		const res = await send(envWithEmail(async () => { calls++; return { messageId: "m1" }; }), FOREIGN, message(FOREIGN));
		expect(res.status).toBe(400);
		expect((await res.json<{ error: string }>()).error).toContain("not-ours.example is not one of this inbox's domains");
		expect(calls).toBe(0);
		expect(await sentCount(FOREIGN)).toBe(0); // FOREIGN is never sent from in this file
	});

	it("reports an Email Service failure and drops the Sent copy", async () => {
		const failing = envWithEmail(async () => {
			throw Object.assign(new Error("domain not available"), { code: "E_SENDER_DOMAIN_NOT_AVAILABLE" });
		});
		const sentBefore = await sentCount(LSC);
		const res = await send(failing, LSC, message(LSC));
		expect(res.status).toBe(400);
		expect((await res.json<{ error: string }>()).error).toContain("littlesaintscorner.com is not enabled for sending");
		expect(await sentCount(LSC)).toBe(sentBefore);
	});

	it("removes the attachment blobs of a send that failed", async () => {
		const failing = envWithEmail(async () => {
			throw Object.assign(new Error("quota"), { code: "E_DAILY_LIMIT_EXCEEDED" });
		});
		const res = await send(failing, LSC, {
			...message(LSC),
			attachments: [{ content: btoa("hello"), filename: "notes.txt", type: "text/plain", disposition: "attachment" }],
		});
		expect(res.status).toBe(429);
		expect((await env.BUCKET.list({ prefix: "attachments/" })).objects).toHaveLength(0);
	});
});
