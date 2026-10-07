# doublexl-agent-mail — Claude Code project instructions

This repo is DoubleXL's fork of [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox): a self-hosted email client with an AI agent, running on Cloudflare Workers (Hono + React Router v7 + Durable Objects + R2 + Workers AI + Email Routing/Email Service).

The current initiative is turning it into a **central, multi-domain mailbox for DoubleXL agents and for Coy's human mailboxes**. The full plan lives in `docs/handoff/HANDOFF.md`. Read it before writing code, and work the phases in order.

## Owner and working preferences

- Owner: Coy Robison (DoubleXL / Roburatis). Sole developer.
- **TypeScript everywhere.** No new `.js` files. Keep `strict` on; fix types rather than casting to `any` (the upstream code has a few `as any`; don't add more).
- **When you show Coy changed code, show the whole file**, not a diff or a fragment, especially when a change touches more than one section of a file.
- Prefer small, reviewable commits, one concern each. Conventional-commit style subjects (`feat(routing): …`, `fix(authz): …`).

## Repo facts

- Entry: `workers/app.ts` (Access JWT middleware, `/mcp`, `/agents/*`, React Router catch-all, `email()` handler).
- REST API + inbound mail processing: `workers/index.ts` (`receiveEmail`).
- Per-mailbox storage: `MailboxDO` in `workers/durableObject/` (SQLite via Drizzle, schema in `workers/db/schema.ts`). Mailbox registry + settings: R2 objects at `mailboxes/<email>.json`. Attachments: R2 `attachments/<messageId>/<attId>/<filename>`.
- AI agent: `EmailAgent` in `workers/agent/index.ts` (one DO per mailbox, keyed by mailbox email; auto-drafts on new mail via `/onNewEmail`).
- MCP server: `EmailMCP` in `workers/mcp/index.ts`, served at `/mcp`. Tools take a `mailboxId` argument.
- Shared tool implementations: `workers/lib/tools.ts`. Sender validation: `workers/lib/email-helpers.ts` (`validateSender`). Mailbox middleware: `workers/lib/mailbox.ts` (`requireMailbox`).
- Scripts: `npm run dev`, `npm run typecheck`, `npm run deploy` (build + `wrangler deploy`). There is no test runner yet; Phase 1 adds Vitest with `@cloudflare/vitest-pool-workers`.

## Guardrails

- **This repo is public on GitHub.** Never commit secrets, service-token secrets, Access AUDs, or the principals/ACL file. Runtime config that names people or tokens lives in R2 or Worker secrets, not in git.
- **Ask Coy before any change to the live Cloudflare account**: DNS/MX records, Email Routing enable/disable/rules, Email Service sending domains, Access apps/policies/service tokens, R2 bucket creation, secrets, and `wrangler deploy`. Read-only inspection is fine without asking. `docs/handoff/INFRA_RUNBOOK.md` lists every account change and its order.
- **Never touch MX records on `roburatis.com` or `double-xl.com`** without Coy's explicit go-ahead in the current session. Both deliver to live Google Workspace mailboxes.
- Preserve the existing Email Routing rule on `double-xl.ai` (`coy@double-xl.ai` → forward to `coy@double-xl.com`).
- Keep the diff against upstream mergeable: put new behavior in new files (`workers/lib/routing.ts`, `workers/lib/authz.ts`, …) and keep edits to upstream files to small, clearly marked hooks. Add `upstream` as a git remote (`https://github.com/cloudflare/agentic-inbox.git`).
- Deploy from a wrangler session logged in as Coy's DoubleXL Cloudflare user. Check with `wrangler whoami` first (the April deploy was made from a different login).
- Fail closed. Anything that can't resolve a principal or an authorization decision returns 403, never "allow".
