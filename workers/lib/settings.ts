// doublexl: strict schema for mailbox settings (R2 `mailboxes/<email>.json`).
// Replaces upstream's `z.record(z.any())` and the unvalidated PUT body.

import { z } from "zod";
import { canAdminister, type Principal } from "./authz";

const EmailOrEmpty = z.union([z.literal(""), z.string().trim().email()]);

export const MailboxSettingsSchema = z
	.object({
		fromName: z.string().max(200),
		forwarding: z.object({ enabled: z.boolean(), email: EmailOrEmpty }).strict(),
		signature: z
			.object({
				enabled: z.boolean(),
				text: z.string().max(10_000),
				html: z.string().max(50_000).optional(),
			})
			.strict(),
		autoReply: z
			.object({
				enabled: z.boolean(),
				subject: z.string().max(500),
				message: z.string().max(10_000),
			})
			.strict(),
		// Goes straight into the agent's system prompt: admin-only (see canSetSettings).
		agentSystemPrompt: z.string().max(20_000),
	})
	.partial()
	.strict();

export type MailboxSettings = z.infer<typeof MailboxSettingsSchema>;

function promptOf(settings: MailboxSettings | null | undefined): string {
	return settings?.agentSystemPrompt?.trim() ?? "";
}

/**
 * Members may edit their mailbox's settings but not change agentSystemPrompt.
 * Re-submitting the stored prompt unchanged (as the settings UI does) is fine.
 */
export function canSetSettings(
	principal: Principal,
	next: MailboxSettings,
	current: MailboxSettings | null,
): boolean {
	if (canAdminister(principal)) return true;
	return promptOf(next) === promptOf(current);
}

/** A readable message from a zod error, for 400 responses. */
export function describeZodError(error: z.ZodError): string {
	return error.issues
		.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
		.join("; ");
}
