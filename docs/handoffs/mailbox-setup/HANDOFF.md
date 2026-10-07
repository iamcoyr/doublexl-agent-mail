# Handoff: multi-domain agentic mailbox

**Repo:** `iamcoyr/doublexl-agent-mail` (fork of `cloudflare/agentic-inbox`)
**Worker:** `doublexl-agent-mail` on Coy's DoubleXL Cloudflare account
**Prepared:** 2026-10-06, from a read-only audit of the repo and the live account
**Out of scope:** the separate `doublexl-mail` worker (outbound transactional API). Don't modify it.

---

## 1. Goal

One deployment of this worker becomes the central mailbox for:

| Mailbox | Kind | Who uses it |
|---|---|---|
| `coy@roburatis.com` | human | Coy, in the web UI |
| `coy@littlesaintscorner.com` | human | Coy, in the web UI |
| `<agent>@double-xl.ai` (one per agent; see D2) | agent | DoubleXL agents over MCP / API, plus Coy for oversight |

More domains (other DoubleXL brand domains) must be addable later with configuration only: no code change, no redeploy beyond a vars update.

Each principal sees only the mailboxes it's allowed to. Coy, as admin, sees everything. An agent sees only its own mailbox(es).

---

## 2. Current state (verified 2026-10-06)

### Code

- The fork matches today's upstream exactly except for `package.json` and `wrangler.jsonc` (worker name, R2 bucket name, `DOMAINS: "double-xl.ai"`). No DoubleXL changes yet.
- Multi-domain is partly there already. `DOMAINS` is parsed as a comma list (`GET /api/v1/config`), the create-mailbox UI shows a domain picker when there's more than one, and mailboxes are keyed by full address, so the same local part on two domains never collides.

#### Gaps this project closes

1. **Inbound routing uses the wrong address.** `receiveEmail` in `workers/index.ts` picks the mailbox from the first `To:` header address (`allRecipients[0]`). It ignores the envelope recipient (`message.to`), which the `email()` handler in `workers/app.ts` never passes along. The result: mail where the mailbox is in CC/BCC, or isn't first in `To:`, is silently dropped, and mail sent to two of our mailboxes lands in only one.
2. **Unknown recipients are silently accepted.** When the mailbox doesn't exist, the handler logs and returns, so the sender gets no bounce.
3. **No authorization beyond Access.** The README is explicit: anyone who passes the Access policy can read and send from every mailbox, including through `/mcp` by passing any `mailboxId`.
4. **Inbound domains aren't checked.** Anything Email Routing hands the worker is processed.
5. **Settings are unvalidated.** `POST /api/v1/mailboxes` accepts `settings: z.record(z.any())`, and `PUT /api/v1/mailboxes/:mailboxId` writes the request body's `settings` with no validation at all. That includes `agentSystemPrompt`, which goes straight to the model.
6. **Some settings do nothing.** `forwarding` and `autoReply` are stored and shown in the UI but implemented nowhere.
7. **No tests.**

### Deployed worker

- Last deployed 2026-04-26 by `crobison@byupathway.edu` (wrangler + dashboard), not Coy's DoubleXL login.
- Bindings: `AI`, `BUCKET` → R2 `doublexl-agent-mail`, `EMAIL` (send_email, unrestricted), DOs `MAILBOX` / `EMAIL_AGENT` / `EMAIL_MCP`, vars `DOMAINS="double-xl.ai"` and `EMAIL_ADDRESSES=[]`, secrets `POLICY_AUD` and `TEAM_DOMAIN`.
- **The R2 bucket `doublexl-agent-mail` does not exist**, and no bucket with a mail/inbox/agent name does. Every R2 call fails today. There's no data to migrate.
- Reachable only on `*.workers.dev`. It has no custom domain and no route.

### Cloudflare account

| Item | State |
|---|---|
| Access team domain | `dblxl.cloudflareaccess.com` |
| Access app `agent-mail` | id `0a71ffa7-13d1-44bb-8048-d273bd0a10e0`, self-hosted, domain `agent-mail.double-xl.ai`, session 24h |
| Access app policies | **"Just Me"** (allow `coy@double-xl.com`, `coy@robison.family`); an onboarding allow for `coy@double-xl.com`; **"Worker API Bypass"** (bypass, misusing `common_name` for paths `/api/public/*`, `/healthz`); **"cms-bypass-policy"** (bypass for a group). The two bypass policies look copied from another app. They should go; see the runbook. |
| DNS `agent-mail.double-xl.ai` | **No record.** The Access app protects a hostname that doesn't resolve. |
| Existing service tokens | `doublexl-admin-cert`, `gospel-collection-service`, `inbox-monitor`, `guest-portal-worker`. None are for this app yet. |
| Email Service quota | 5,000/day, 7 sent today |

#### Domains

| Domain | MX today | Email Routing | Email Service sending | Implication |
|---|---|---|---|---|
| `littlesaintscorner.com` | **none on apex** (only `cf-bounce.` and `send.` subdomains) | unconfigured | enabled for `littlesaintscorner.com` | **Safe** to enable Email Routing on the apex and point a catch-all at the worker. DMARC is `p=reject`, so outbound must be DKIM-aligned (Email Service handles this). |
| `double-xl.ai` | Cloudflare (`route1-3.mx.cloudflare.net`) | ready; one rule, `coy@double-xl.ai` → forward to `coy@double-xl.com`; catch-all disabled | enabled for **`mail.double-xl.ai` only**, not the apex | Inbound is ready: add a catch-all → worker and keep the `coy@` rule. Sending from `@double-xl.ai` needs the apex onboarded, or agents use `@mail.double-xl.ai` (D2). |
| `roburatis.com` | **Google Workspace** (`smtp.google.com`) | unconfigured | not onboarded | `coy@roburatis.com` is a live Google mailbox. **Do not move MX without D1.** No SPF/DMARC records exist; add them during onboarding. |
| `double-xl.com` | Google Workspace | "misconfigured" | not onboarded | Not in scope. Never touch its MX. |

---

## 3. Decisions for Coy

Confirm these with Coy before the phase that needs them. The default is what to build if Coy says "go with your recommendation".

**D1. How does `coy@roburatis.com` reach the inbox?** (Phase 4)
- **A. Dual delivery (default; no disruption, reversible).** Google stays primary and **nothing changes in roburatis.com's inbound DNS**. In the Google Workspace admin console (Gmail → Routing), Coy adds a rule that also delivers a copy of mail for `coy@roburatis.com` to a hidden address on a domain the worker already receives, default `coy-roburatis@double-xl.ai`. The inbox registers that address as an **alias** of mailbox `coy@roburatis.com`. Outbound from the inbox sends as `coy@roburatis.com` via Email Service: roburatis.com is onboarded for sending, which adds DKIM and bounce-subdomain records but no apex MX. Apex SPF keeps Google, and DMARC aligns through DKIM.
- **B. Cut over.** Move roburatis.com MX to Cloudflare Email Routing; the inbox becomes the only mailbox and Google stops receiving. Optional transition: forward a copy to the Workspace secondary routing domain.
- Phase 1 builds alias support either way, so switching from A to B later is configuration only.

**D2. Agent address namespace.** (Phase 4)
- **Default: `<agent>@double-xl.ai`**, with a catch-all → worker and the apex onboarded for Email Service sending.
- Alternatives: `<agent>@mail.double-xl.ai` (sending is already onboarded there; needs an Email Routing subdomain), or a dedicated `agents.double-xl.ai`.

**D3. Which agents get mailboxes first?** Seed one `test-agent@…` for verification. Coy names the real ones (candidates in the account include `studio-os`, `outreach-orchestrator`, and `agent-smith`). One Access service token per agent.

**D4. Unknown recipients.** Default: **reject** at SMTP time with `message.setReject("5.1.1 Unknown recipient")`. Alternative: accept and drop (current behavior). Rejecting gives senders a bounce and keeps catch-all spam from burning CPU.

---

## 4. Design

Keep upstream files close to upstream: new behavior goes in new modules, and upstream files get short hooks marked `// doublexl:`.

### 4.1 Configuration

| Name | Where | Shape | Purpose |
|---|---|---|---|
| `DOMAINS` | wrangler `vars` (exists) | `"double-xl.ai, littlesaintscorner.com, roburatis.com"` | Domains users may create mailboxes on, and the inbound allowlist. Stays a comma string for UI compatibility. |
| `EMAIL_ADDRESSES` | wrangler `vars` (exists) | `[]` | Keep upstream semantics: an optional hard allowlist. Leave empty. |
| `config/aliases.json` | R2 | `Record<string, string>` mapping alias → canonical mailbox | e.g. `{"coy-roburatis@double-xl.ai": "coy@roburatis.com"}`. The alias address's domain must be one Email Routing delivers to the worker. Being an alias implicitly allowlists that address, even if its domain isn't in `DOMAINS`. |
| `config/principals.json` | R2 (**never in git**) | `Principal[]` (below) | Who may access which mailboxes. |
| `ADMIN_EMAILS` | wrangler `vars` | `["coy@double-xl.com", "coy@robison.family"]` | Bootstrap admins, so a missing or corrupt `principals.json` can't lock Coy out. Must match the Access policy's identities. |

Cache both R2 config objects in module scope with a short TTL (about 30s), and invalidate on admin writes.

### 4.2 Inbound routing (`workers/lib/routing.ts`)

- Change the `email()` handler in `workers/app.ts` to take `ForwardableEmailMessage`. Pass the whole message (or at least `message.to`, `message.raw`, `message.rawSize`, `message.setReject`) into `receiveEmail`.
- Email Routing invokes the worker **once per envelope recipient**. Route on `message.to` only; headers are for display. This alone fixes CC/BCC, ordering, and multi-mailbox delivery.
- Resolution order for the envelope recipient, lowercased:
  1. alias table hit → canonical mailbox;
  2. exact mailbox (`mailboxes/<addr>.json` exists) **and** its domain is in `DOMAINS`;
  3. otherwise apply D4 (reject by default).
- Keep the `EMAIL_ADDRESSES` allowlist check, applied to the canonical mailbox.
- Keep the upstream size guard and attachment handling unchanged.
- Store the envelope recipient on the email row so the UI can show which alias it came through. Add a nullable `delivered_to` column through the existing migration system in `workers/durableObject/migrations.ts`. Don't hand-edit existing migrations; append a new one.
- Keep the agent trigger (`EMAIL_AGENT` → `/onNewEmail`), keyed by the canonical mailbox.

```ts
// workers/lib/routing.ts (shape only; implement and test it)
export type RouteResult =
  | { kind: "deliver"; mailboxId: string; via: "direct" | "alias"; deliveredTo: string }
  | { kind: "reject"; reason: string }
  | { kind: "drop"; reason: string };

export async function resolveInboundRecipient(env: Env, envelopeTo: string): Promise<RouteResult>;
```

### 4.3 Principals and authorization (`workers/lib/authz.ts`)

**Identity comes from the Access JWT,** which the middleware in `workers/app.ts` already verifies. Have it put the verified payload's principal on the Hono context (`c.set("principal", …)`); today it discards the payload.

- Human (identity login): payload has `email`.
- Agent (Access service token): payload has `common_name` set to the service token's **Client ID**, and no `email`.
- Dev mode (`import.meta.env.DEV`): a synthetic admin principal. The production path stays fail-closed.

```ts
export type Principal =
  | { kind: "human"; id: string; email: string; role: "admin" | "member"; mailboxes: string[] }
  | { kind: "agent"; id: string; serviceTokenClientId: string; role: "member"; mailboxes: string[] };
// mailboxes: exact addresses or single-segment globs on the local part, e.g. "*@double-xl.ai".
// Admins implicitly match every mailbox.

export function principalFromJwt(payload: JWTPayload, cfg: PrincipalsConfig, admins: string[]): Principal | null;
export function canAccessMailbox(p: Principal, mailboxId: string): boolean;
export function canAdminister(p: Principal): boolean; // create/delete mailboxes, edit aliases/principals
```

A JWT that verifies but maps to no principal → **403**. Never fall back to "allow".

#### Enforcement points (all of them)

| Surface | Where | Rule |
|---|---|---|
| `GET /api/v1/mailboxes` | `workers/index.ts` | Filter the list to mailboxes the principal can access. |
| `POST /api/v1/mailboxes` | `workers/index.ts` | `canAdminister`. The domain must be in `DOMAINS`. |
| `GET` / `PUT` / `DELETE /api/v1/mailboxes/:mailboxId` | `workers/index.ts` | These are **not** covered by the `/:mailboxId/*` middleware (the wildcard needs a subpath). Check `canAccessMailbox` explicitly; `DELETE` also needs `canAdminister`. |
| `/api/v1/mailboxes/:mailboxId/*` | `requireMailbox` in `workers/lib/mailbox.ts` | Add the `canAccessMailbox` check after the existence check. This covers emails, drafts, reply/forward, folders, search, and attachments. |
| `/mcp` | `workers/app.ts` + `workers/mcp/index.ts` | Pass the principal into the `EmailMCP` session as `props`. In the installed `agents@0.7.6`, the MCP handler reads props from the execution context (`ctx.props`), and `McpAgent` exposes them as `this.props`. Set `ctx.props = { principal }` before calling `mcpHandler.fetch`. `list_mailboxes` filters; every tool taking `mailboxId` calls `canAccessMailbox` next to the existing `verifyMailbox`. Re-check the principal per tool call rather than trusting props cached at session start. |
| `/agents/*` (chat WebSocket) | `workers/app.ts` | Pass `{ onBeforeConnect, onBeforeRequest }` to `routeAgentRequest` (partyserver options, present in the installed version). The UI connects with `useAgent({ agent: "EmailAgent", name: mailboxId })`, so the path is `/agents/email-agent/<url-encoded mailboxId>`. Decode it and check `canAccessMailbox`; return a 403 `Response` to block. The internal `/onNewEmail` call goes straight to the DO stub and is unaffected. |
| Settings writes | `PUT /api/v1/mailboxes/:mailboxId` | Replace `z.record(z.any())` with a strict zod schema for the known settings keys. Only admins may set `agentSystemPrompt`. |
| UI | `app/` | Hide the create-mailbox control for non-admins. Show the signed-in principal in the header. Use the existing `GET /api/v1/config`, extended with `{ principal: { kind, email?, role } }`. |

Admin-only endpoints for config, so Coy doesn't hand-edit R2:

- `GET` / `PUT /api/v1/admin/aliases`
- `GET` / `PUT /api/v1/admin/principals`

Both validate with zod and write atomically (single R2 put).

### 4.4 Outbound

- `validateSender` already requires `from == mailboxId`. Add: the mailbox's domain must be in `DOMAINS`.
- When a mailbox was reached through an alias, replies still send **as the canonical address**, never the alias (`coy@roburatis.com`, not `coy-roburatis@double-xl.ai`).
- Map Email Service errors to clear messages. If a domain isn't onboarded for sending, the API and the MCP tool should say so explicitly (e.g. "littlesaintscorner.com is not enabled for sending").
- Don't change the agent's "drafts require explicit confirmation" behavior. Agents using MCP `send_email` / `send_reply` are a deliberate send, and that's fine.

### 4.5 Agents

- Each agent gets: one mailbox, one Access service token, and one `principals.json` entry mapping the token's Client ID to its mailbox.
- Connection: MCP over `https://agent-mail.double-xl.ai/mcp` with `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers. The Access app needs a **Service Auth** policy for these tokens; the runbook covers it.
- Per-agent behavior is the existing `agentSystemPrompt` mailbox setting (admin-only after 4.3).
- Optional, Phase 6: internal DoubleXL workers (`studio-os`, `outreach-orchestrator`, …) call the inbox over a **service binding** instead of public MCP. Expose a typed `WorkerEntrypoint` RPC class with the caller identity bound per service binding, and reuse `authz.ts`.

---

## 5. Phases

Work in order. Each phase ends green on `npm run typecheck` and `npm test`, with a summary to Coy (whole files for anything changed). Account changes go through `INFRA_RUNBOOK.md` and need Coy's OK at the moment they happen.

### Phase 0: baseline (local plus read-only checks)

- [x] Add the `upstream` remote and confirm the fork still matches upstream except `package.json` / `wrangler.jsonc`.
- [x] `npm ci`, then `npm run typecheck` passes on untouched code. Record any pre-existing failures without fixing them yet. *(No pre-existing failures.)*
- [x] `wrangler whoami` shows Coy's DoubleXL user on the account that owns `doublexl-agent-mail`. *(coy@double-xl.com, account DoubleXL; §2 re-verified 2026-10-06, no differences.)*
- [x] Add Vitest with `@cloudflare/vitest-pool-workers` and an `npm test` script. Write one smoke test that boots the worker.
- [x] Ask Coy to settle D1–D4. Proceed with the defaults on any he defers.

**Done when:** tests run in CI-equivalent locally, and the decisions are recorded in the "Decisions log" at the end of this file.

### Phase 1: inbound routing, aliases, domain allowlist

- [ ] `workers/lib/config.ts`: typed loaders for `DOMAINS`, `config/aliases.json`, `config/principals.json`, `ADMIN_EMAILS` (zod-validated, TTL cache).
- [ ] `workers/lib/routing.ts` per §4.2.
- [ ] `workers/app.ts` `email()` passes the envelope through; `workers/index.ts` `receiveEmail` uses `resolveInboundRecipient`.
- [ ] New migration adding `delivered_to`. Display it in the message view.
- [ ] Tests: envelope recipient in CC; recipient second in `To:`; BCC; alias delivery; unknown recipient → reject; domain not in `DOMAINS` → reject; `EMAIL_ADDRESSES` allowlist still honored; two of our mailboxes on one message each get exactly one copy (simulate two invocations).

**Done when:** every case above passes, and `wrangler dev` with a locally injected `ForwardableEmailMessage` stores mail in the right mailbox.

### Phase 2: principals and authorization

- [ ] Middleware sets `principal` from the verified JWT (human via `email`, agent via `common_name`).
- [ ] `workers/lib/authz.ts` per §4.3, wired into every row of the enforcement table.
- [ ] Strict settings schema; `agentSystemPrompt` admin-only.
- [ ] Admin endpoints for aliases and principals.
- [ ] UI: principal in header, admin-gated controls, `GET /api/v1/config` returns the principal.
- [ ] Tests: a member can't list, read, send from, or open the agent socket for a foreign mailbox (REST, MCP, `/agents/*`); an agent token sees only its mailbox; an unknown JWT subject → 403; admin sees all; the routes without a subpath (`GET`/`PUT`/`DELETE` on `/api/v1/mailboxes/:mailboxId`) are enforced.

**Done when:** the full test matrix passes, and a manual check in `wrangler dev` with forged dev principals behaves correctly.

### Phase 3: account setup and first deploy (runbook §1–§4; Coy approves each step)

- [ ] Create the R2 bucket `doublexl-agent-mail`.
- [ ] Add `agent-mail.double-xl.ai` as a Worker custom domain (in `wrangler.jsonc` `routes` with `custom_domain: true`).
- [ ] Clean up the Access app policies; add a Service Auth policy.
- [ ] Set `POLICY_AUD` (the `agent-mail` app's AUD) and `TEAM_DOMAIN=https://dblxl.cloudflareaccess.com`.
- [ ] Set vars `DOMAINS` and `ADMIN_EMAILS`. Seed `config/principals.json` and `config/aliases.json`.
- [ ] Deploy. Verify: `workers.dev` returns 403; `agent-mail.double-xl.ai` behind Access loads the UI as Coy.

**Done when:** Coy can sign in at `https://agent-mail.double-xl.ai` and create mailboxes on each configured domain.

### Phase 4: domain onboarding (runbook §5–§7)

- [ ] `littlesaintscorner.com`: enable Email Routing on the apex; catch-all → worker. Create mailbox `coy@littlesaintscorner.com`. Test inbound from an outside account, and outbound reply (check DKIM/DMARC pass in the received headers).
- [ ] `double-xl.ai`: catch-all → worker (keep the `coy@double-xl.ai` forward rule). Onboard the apex for sending per D2. Create `test-agent@double-xl.ai`.
- [ ] `roburatis.com` per D1. Default A: the `coy-roburatis@double-xl.ai` alias, a Workspace dual-delivery rule that Coy adds himself in the Google admin console, roburatis.com sending onboarding, and a DMARC record. No apex MX change.

**Done when:** for each human mailbox, external → inbox works, reply → external lands in an inbox (not spam) with `dkim=pass` and `dmarc=pass`, and a CC-only test message arrives.

### Phase 4b: additional brand domains (added 2026-10-06, per Coy)

Each domain is configuration only: add it to `DOMAINS`, enable Email Routing with a catch-all → worker, onboard it for Email Service sending, and add a DMARC record (start `p=none`) with Coy's OK. All are Cloudflare zones in the DoubleXL account. State from a read-only check on 2026-10-06:

| Domain | MX today | Email Routing | Notes |
|---|---|---|---|
| `littlesaintscorner.com` | none | unconfigured | Already Phase 4 (§5). Listed here so the set is complete. |
| `fitfluencerhq.com` | none | unconfigured | No DMARC. Safe to enable routing. |
| `backbarzen.com` | Cloudflare (`route1-3`) | **ready**, no active rules (catch-all disabled) | Just enable the catch-all → worker. No DMARC. |
| `asecondlook.media` | none | unconfigured | No DMARC. Safe to enable routing. |
| `gospel-db.org` | none | unconfigured | No DMARC. Safe to enable routing. |

- [ ] `fitfluencerhq.com`: Email Routing + catch-all → worker; sending onboarding; DMARC.
- [ ] `backbarzen.com`: catch-all → worker; sending onboarding; DMARC.
- [ ] `asecondlook.media`: Email Routing + catch-all → worker; sending onboarding; DMARC.
- [ ] `gospel-db.org`: Email Routing + catch-all → worker; sending onboarding; DMARC.
- [ ] Add all four to `DOMAINS` (wrangler vars) and redeploy.
- [ ] Ask Coy which mailboxes to create on each domain (human, agent, or both).

**Done when:** each domain passes the same inbound / outbound (`dkim=pass`, `dmarc=pass`) / unknown-recipient-rejected checks as Phase 4.

### Phase 5: agent onboarding

- [ ] For each agent from D3: create a service token, a mailbox, and a principals entry, and set the system prompt.
- [ ] Write `docs/agents.md`: MCP client config for Claude Code / Claude Desktop / the agents SDK using service-token headers, and how to add an agent.
- [ ] Verify `test-agent` over MCP: it sees only its mailbox, can read, draft, and send; a foreign `mailboxId` is refused.

**Done when:** at least one real agent is connected and isolated.

### Phase 6 (optional; ask before starting)

- Service-binding RPC entrypoint for internal workers (§4.5).
- Inbound event hook: on delivery to an agent mailbox, enqueue `{ mailboxId, emailId, threadId }` to a Queue so agent workers react without polling.
- Implement or remove the `forwarding` / `autoReply` settings (currently UI-only).
- Upstream sync: merge `upstream/main` and resolve conflicts in the `// doublexl:` hooks.

---

## 6. Testing notes

- Inbound tests construct a fake `ForwardableEmailMessage`: `to`, `from`, `raw` (a `ReadableStream` of a MIME fixture), `rawSize`, and spy `setReject` / `forward`. Put the MIME fixtures under `test/fixtures/` (plain, CC-only, BCC, multi-recipient, with attachment).
- Authz tests mint JWTs with a test JWKS. Make the JWKS URL injectable in the middleware for tests only; don't weaken the production path.
- Use miniflare-backed R2/DO bindings from the vitest pool. No live-account calls in tests.

## 7. Risks

- **The `roburatis.com` mailbox.** Any MX mistake stops Coy's real email. The default (D1-A) never enables Email Routing on roburatis.com and never touches its MX. If the Cloudflare dashboard ever offers to "delete existing MX records" on that zone, the answer is no.
- **DMARC `p=reject` on littlesaintscorner.com.** Outbound from anything that isn't DKIM-aligned will bounce. Only send via the onboarded Email Service domain.
- **Catch-all spam.** Mitigated by D4 reject. Watch Email Routing analytics after enabling.
- **Public repo.** Principals, aliases, and token IDs stay in R2; secrets stay in Worker secrets.
- **Upstream drift.** Upstream is moving quickly. Keep hooks small so merges stay cheap.

## Decisions log

| # | Decision | Date | Notes |
|---|---|---|---|
| D1 | **A. Dual delivery.** Google stays primary; Workspace routing adds a copy to alias `coy-roburatis@double-xl.ai`. No MX change on roburatis.com. | 2026-10-06 | Default. |
| D2 | **`<agent>@double-xl.ai`.** Catch-all → worker; onboard the apex for Email Service sending. | 2026-10-06 | Default. Keep the `coy@double-xl.ai` forward rule. |
| D3 | **`test-agent`, `outreach-orchestrator`, `agent-smith`.** One mailbox + one Access service token each. | 2026-10-06 | Coy also added more mailbox domains; see Phase 4b. |
| D4 | **Reject** unknown recipients with `5.1.1 Unknown recipient`. | 2026-10-06 | Default. |
