import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { EmailAgent } from "../workers/agent";
import type { Env } from "../workers/types";
import plainMime from "./fixtures/plain.eml?raw";
import { createMailbox, deliver, fakeMessage, inbox, resetStorage } from "./helpers/inbound";

const MAILBOX = "coy@littlesaintscorner.com";

type NewEmail = Parameters<EmailAgent["handleNewEmail"]>[0];

beforeEach(async () => {
	await resetStorage();
	await createMailbox(MAILBOX);
});

describe("inbound auto-draft trigger", () => {
	it("reaches a never-opened EmailAgent named after the mailbox", async () => {
		const testEnv = env as Env;
		const agent = testEnv.EMAIL_AGENT.get(testEnv.EMAIL_AGENT.idFromName(MAILBOX));

		// Swap the drafting path for a recorder so no Workers AI call is made.
		// runInDurableObject skips partyserver's fetch, so the agent stays unnamed,
		// just like one whose mailbox was never opened in the UI.
		const calls: NewEmail[] = [];
		await runInDurableObject(agent, (instance: EmailAgent) => {
			instance.handleNewEmail = async (data: NewEmail) => {
				calls.push(data);
				return { stubbed: true } as unknown as Awaited<ReturnType<EmailAgent["handleNewEmail"]>>;
			};
		});

		await deliver(testEnv, fakeMessage(MAILBOX, plainMime));

		const [email] = await inbox(MAILBOX);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ mailboxId: MAILBOX, emailId: email.id, subject: "Plain hello" });
		const name = await runInDurableObject(agent, (instance: EmailAgent) => instance.name);
		expect(name).toBe(MAILBOX);
	});
});
