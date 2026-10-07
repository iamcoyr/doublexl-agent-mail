// doublexl: inbound recipient resolution.
//
// Email Routing invokes the worker once per envelope recipient, so routing
// keys off `message.to` only. Message headers (To/Cc/Bcc) are display data.

import type { Env } from "../types";
import { domainOf, getAllowedAddresses, isDomainAllowed, loadAliases } from "./config";

/** The parts of a ForwardableEmailMessage that inbound processing uses. */
export type InboundMessage = Pick<ForwardableEmailMessage, "to" | "raw" | "rawSize" | "setReject">;

export type RouteResult =
	| { kind: "deliver"; mailboxId: string; via: "direct" | "alias"; deliveredTo: string }
	| { kind: "reject"; reason: string };

/** SMTP rejection text for addresses we don't serve (decision D4). */
export const UNKNOWN_RECIPIENT = "5.1.1 Unknown recipient";

export function normalizeAddress(address: string): string {
	return address.trim().toLowerCase();
}

export function mailboxKey(mailboxId: string): string {
	return `mailboxes/${mailboxId}.json`;
}

async function mailboxExists(env: Env, mailboxId: string): Promise<boolean> {
	return (await env.BUCKET.head(mailboxKey(mailboxId))) !== null;
}

/**
 * Resolve an envelope recipient to a mailbox.
 *
 * 1. Alias hit -> canonical mailbox. Being an alias allowlists the address
 *    even if its domain isn't in DOMAINS.
 * 2. Exact mailbox whose domain is in DOMAINS.
 * 3. Otherwise reject.
 *
 * The EMAIL_ADDRESSES allowlist, when set, applies to the canonical mailbox.
 * Throws if the alias config can't be read, so delivery fails temporarily
 * instead of rejecting mail permanently.
 */
export async function resolveInboundRecipient(env: Env, envelopeTo: string): Promise<RouteResult> {
	const deliveredTo = normalizeAddress(envelopeTo);
	if (domainOf(deliveredTo) === "") return { kind: "reject", reason: UNKNOWN_RECIPIENT };

	const aliases = await loadAliases(env);
	const aliasTarget = aliases[deliveredTo];

	let mailboxId: string;
	let via: "direct" | "alias";
	if (aliasTarget) {
		mailboxId = aliasTarget;
		via = "alias";
	} else if (isDomainAllowed(env, deliveredTo)) {
		mailboxId = deliveredTo;
		via = "direct";
	} else {
		return { kind: "reject", reason: UNKNOWN_RECIPIENT };
	}

	const allowed = getAllowedAddresses(env);
	if (allowed.length > 0 && !allowed.includes(mailboxId)) {
		return { kind: "reject", reason: UNKNOWN_RECIPIENT };
	}

	if (!(await mailboxExists(env, mailboxId))) {
		if (via === "alias") {
			console.error(`Alias ${deliveredTo} points to missing mailbox ${mailboxId}`);
		}
		return { kind: "reject", reason: UNKNOWN_RECIPIENT };
	}

	return { kind: "deliver", mailboxId, via, deliveredTo };
}
