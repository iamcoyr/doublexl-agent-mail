// doublexl: one gate for every outbound send (REST send/reply/forward, MCP tools).
//
// - The From domain must be in DOMAINS, so a mailbox can't send as a domain
//   this deployment doesn't serve.
// - Email Service errors become messages a person or agent can act on.

import type { MailboxDO } from "../durableObject";
import { sendEmail, type SendEmailParams } from "../email-sender";
import type { Env } from "../types";
import { domainOf, isDomainAllowed } from "./config";

export class OutboundError extends Error {
	constructor(
		message: string,
		/** HTTP status for REST callers. */
		readonly status: 400 | 429 | 502,
	) {
		super(message);
		this.name = "OutboundError";
	}
}

function fromAddress(from: SendEmailParams["from"]): string {
	return (typeof from === "string" ? from : from.email).trim().toLowerCase();
}

/** Turn an Email Service binding error into a clear, actionable OutboundError. */
export function describeSendError(error: unknown, fromEmail: string): OutboundError {
	const code = (error as { code?: unknown })?.code;
	const message = (error as { message?: unknown })?.message;
	const domain = domainOf(fromEmail);
	switch (code) {
		case "E_SENDER_DOMAIN_NOT_AVAILABLE":
		case "E_SENDER_NOT_VERIFIED":
			return new OutboundError(`${domain} is not enabled for sending (Email Service). Onboard it before sending from ${fromEmail}.`, 400);
		case "E_RATE_LIMIT_EXCEEDED":
			return new OutboundError("Sending rate limit reached. Try again shortly.", 429);
		case "E_DAILY_LIMIT_EXCEEDED":
			return new OutboundError("Daily sending quota reached. Try again tomorrow.", 429);
		case "E_RECIPIENT_SUPPRESSED":
			return new OutboundError("A recipient is on the suppression list (previous bounce or complaint).", 400);
		case "E_RECIPIENT_NOT_ALLOWED":
			return new OutboundError("A recipient isn't allowed by the sending binding.", 400);
		case "E_TOO_MANY_RECIPIENTS":
			return new OutboundError("Too many recipients (the limit is 50 across to, cc and bcc).", 400);
		case "E_CONTENT_TOO_LARGE":
			return new OutboundError("The message is too large to send.", 400);
		case "E_VALIDATION_ERROR":
		case "E_FIELD_MISSING":
			return new OutboundError(`The message was rejected as invalid: ${typeof message === "string" ? message : "validation error"}`, 400);
		default:
			return new OutboundError(`Failed to send: ${typeof message === "string" ? message : String(error)}`, 502);
	}
}

/** Why this deployment may not send from `fromEmail`, or null if it may. Check before doing any send work. */
export function sendingDomainError(env: Env, fromEmail: string): string | null {
	const from = fromEmail.trim().toLowerCase();
	return isDomainAllowed(env, from)
		? null
		: `${domainOf(from) || from} is not one of this inbox's domains; can't send from ${from}.`;
}

/** Throws OutboundError if this deployment may not send from `fromEmail`. */
export function assertSendingDomain(env: Env, fromEmail: string): void {
	const error = sendingDomainError(env, fromEmail);
	if (error) throw new OutboundError(error, 400);
}

/**
 * Remove the Sent copy of a message that failed to send: the email row and its
 * R2 attachment blobs. Never throws, so the caller can still report the send error.
 */
export async function discardUnsent(
	env: Env,
	stub: DurableObjectStub<MailboxDO>,
	messageId: string,
): Promise<void> {
	try {
		const attachments = (await stub.deleteEmail(messageId)) ?? [];
		if (attachments.length > 0) {
			await env.BUCKET.delete(attachments.map((a) => `attachments/${messageId}/${a.id}/${a.filename}`));
		}
	} catch (e) {
		console.error("Failed to discard unsent message", messageId, (e as Error).message);
	}
}

/** Send through Email Service after checking the From domain. Throws OutboundError. */
export async function sendFromMailbox(env: Env, params: SendEmailParams): Promise<{ messageId: string }> {
	const fromEmail = fromAddress(params.from);
	assertSendingDomain(env, fromEmail);
	try {
		return await sendEmail(env.EMAIL, params);
	} catch (e) {
		const error = describeSendError(e, fromEmail);
		console.error("Email send failed:", (e as { code?: string })?.code ?? "unknown", error.message);
		throw error;
	}
}
