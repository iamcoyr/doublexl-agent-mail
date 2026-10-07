import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { UNKNOWN_RECIPIENT, resolveInboundRecipient } from "../workers/lib/routing";
import bccMime from "./fixtures/bcc.eml?raw";
import ccOnlyMime from "./fixtures/cc-only.eml?raw";
import multiMime from "./fixtures/multi-recipient.eml?raw";
import plainMime from "./fixtures/plain.eml?raw";
import attachmentMime from "./fixtures/with-attachment.eml?raw";
import {
	createMailbox,
	deliver,
	fakeMessage,
	inbox,
	makeEnv,
	resetStorage,
	setAliases,
} from "./helpers/inbound";

const LSC = "coy@littlesaintscorner.com";
const AGENT = "test-agent@double-xl.ai";
const ROBURATIS = "coy@roburatis.com";
const ROBURATIS_ALIAS = "coy-roburatis@double-xl.ai";

/** Deliver and return the emails that landed in `mailboxId` during the call. */
async function deliverAndCollect(mailboxId: string, run: () => Promise<void>) {
	const before = new Set((await inbox(mailboxId)).map((e) => e.id));
	await run();
	return (await inbox(mailboxId)).filter((e) => !before.has(e.id));
}

async function getEmail(mailboxId: string, id: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId)).getEmail(id);
}

beforeEach(async () => {
	await resetStorage();
	await createMailbox(LSC);
	await createMailbox(AGENT);
	await createMailbox(ROBURATIS);
});

describe("inbound routing on the envelope recipient", () => {
	it("delivers a plain message and triggers the mailbox's agent", async () => {
		const { env: e, agentTriggers } = makeEnv();
		const msg = fakeMessage(LSC, plainMime);
		const added = await deliverAndCollect(LSC, () => deliver(e, msg));

		expect(msg.rejectedWith).toBeNull();
		expect(added).toHaveLength(1);
		expect(added[0].subject).toBe("Plain hello");
		expect((await getEmail(LSC, added[0].id))?.delivered_to).toBe(LSC);
		expect(agentTriggers).toEqual([{ mailboxId: LSC, emailId: added[0].id }]);
	});

	it("delivers when the mailbox is only in Cc", async () => {
		const { env: e } = makeEnv();
		const msg = fakeMessage(LSC, ccOnlyMime);
		const added = await deliverAndCollect(LSC, () => deliver(e, msg));
		expect(msg.rejectedWith).toBeNull();
		expect(added.map((m) => m.subject)).toEqual(["CC only"]);
	});

	it("delivers when the mailbox is not first in To", async () => {
		const { env: e } = makeEnv();
		const msg = fakeMessage(AGENT, multiMime);
		const added = await deliverAndCollect(AGENT, () => deliver(e, msg));
		expect(msg.rejectedWith).toBeNull();
		expect(added.map((m) => m.subject)).toEqual(["Multi recipient"]);
	});

	it("delivers a Bcc'd message whose headers don't name the mailbox", async () => {
		const { env: e } = makeEnv();
		const msg = fakeMessage(LSC, bccMime);
		const added = await deliverAndCollect(LSC, () => deliver(e, msg));
		expect(msg.rejectedWith).toBeNull();
		expect(added.map((m) => m.subject)).toEqual(["BCC only"]);
	});

	it("gives each of our mailboxes on one message exactly one copy", async () => {
		const { env: e } = makeEnv();
		const lscBefore = new Set((await inbox(LSC)).map((m) => m.id));
		const agentBefore = new Set((await inbox(AGENT)).map((m) => m.id));

		// Email Routing invokes the worker once per envelope recipient.
		await deliver(e, fakeMessage(LSC, multiMime));
		await deliver(e, fakeMessage(AGENT, multiMime));

		const lscNew = (await inbox(LSC)).filter((m) => !lscBefore.has(m.id));
		const agentNew = (await inbox(AGENT)).filter((m) => !agentBefore.has(m.id));
		expect(lscNew).toHaveLength(1);
		expect(agentNew).toHaveLength(1);
	});

	it("matches the envelope recipient case-insensitively", async () => {
		const { env: e } = makeEnv();
		const msg = fakeMessage("Coy@LittleSaintsCorner.com", plainMime);
		const added = await deliverAndCollect(LSC, () => deliver(e, msg));
		expect(msg.rejectedWith).toBeNull();
		expect(added).toHaveLength(1);
	});

	it("keeps attachment handling", async () => {
		const { env: e } = makeEnv();
		const added = await deliverAndCollect(LSC, () => deliver(e, fakeMessage(LSC, attachmentMime)));
		const stored = await getEmail(LSC, added[0].id);
		expect(stored?.attachments.map((a) => a.filename)).toEqual(["notes.txt"]);
	});
});

describe("aliases", () => {
	it("delivers alias mail to the canonical mailbox and records the alias", async () => {
		await setAliases({ [ROBURATIS_ALIAS]: ROBURATIS });
		const { env: e, agentTriggers } = makeEnv();
		const msg = fakeMessage(ROBURATIS_ALIAS, plainMime);
		const added = await deliverAndCollect(ROBURATIS, () => deliver(e, msg));

		expect(msg.rejectedWith).toBeNull();
		expect(added).toHaveLength(1);
		expect((await getEmail(ROBURATIS, added[0].id))?.delivered_to).toBe(ROBURATIS_ALIAS);
		expect(agentTriggers.map((t) => t.mailboxId)).toEqual([ROBURATIS]);
	});

	it("allows an alias on a domain outside DOMAINS", async () => {
		await setAliases({ "coy@other-brand.example": ROBURATIS });
		const route = await resolveInboundRecipient(makeEnv().env, "coy@other-brand.example");
		expect(route).toEqual({
			kind: "deliver",
			mailboxId: ROBURATIS,
			via: "alias",
			deliveredTo: "coy@other-brand.example",
		});
	});

	it("rejects an alias whose target mailbox doesn't exist", async () => {
		await setAliases({ [ROBURATIS_ALIAS]: "gone@roburatis.com" });
		const msg = fakeMessage(ROBURATIS_ALIAS, plainMime);
		await deliver(makeEnv().env, msg);
		expect(msg.rejectedWith).toBe(UNKNOWN_RECIPIENT);
	});

	it("fails the delivery (temporary error) when aliases.json is corrupt", async () => {
		await env.BUCKET.put("config/aliases.json", "{not json");
		const msg = fakeMessage(LSC, plainMime);
		await expect(deliver(makeEnv().env, msg)).rejects.toThrow(/aliases\.json/);
		expect(msg.rejectedWith).toBeNull();
	});
});

describe("rejections (D4)", () => {
	it("rejects an unknown recipient on a served domain", async () => {
		const msg = fakeMessage("nobody@littlesaintscorner.com", plainMime);
		await deliver(makeEnv().env, msg);
		expect(msg.rejectedWith).toBe(UNKNOWN_RECIPIENT);
	});

	it("rejects a recipient whose domain isn't in DOMAINS, even if a mailbox exists", async () => {
		await createMailbox("coy@not-ours.example");
		const msg = fakeMessage("coy@not-ours.example", plainMime);
		await deliver(makeEnv().env, msg);
		expect(msg.rejectedWith).toBe(UNKNOWN_RECIPIENT);
	});

	it("honors the EMAIL_ADDRESSES allowlist", async () => {
		const { env: e } = makeEnv({ EMAIL_ADDRESSES: [AGENT] });

		const blocked = fakeMessage(LSC, plainMime);
		await deliver(e, blocked);
		expect(blocked.rejectedWith).toBe(UNKNOWN_RECIPIENT);

		const allowed = fakeMessage(AGENT, plainMime);
		const added = await deliverAndCollect(AGENT, () => deliver(e, allowed));
		expect(allowed.rejectedWith).toBeNull();
		expect(added).toHaveLength(1);
	});

	it("rejects without reading the message body", async () => {
		const msg = fakeMessage("nobody@double-xl.ai", plainMime);
		await deliver(makeEnv().env, msg);
		expect(msg.rejectedWith).toBe(UNKNOWN_RECIPIENT);
		expect(msg.raw.locked).toBe(false);
	});
});
