# doublexl-agent-mail: operations guide

How the DoubleXL fork of [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) is deployed, configured, and run. The project plan and decision log live in [`handoffs/mailbox-setup/HANDOFF.md`](handoffs/mailbox-setup/HANDOFF.md); every account change and its order is in [`handoffs/mailbox-setup/INFRA_RUNBOOK.md`](handoffs/mailbox-setup/INFRA_RUNBOOK.md).

## What it is

One Cloudflare Worker (`doublexl-agent-mail`) that is the central mailbox for Coy's human addresses and for DoubleXL agents:

| Mailbox | Who | How mail arrives |
|---|---|---|
| `coy@littlesaintscorner.com` | Coy | Email Routing catch-all → worker |
| `coy@roburatis.com` | Coy | Google Workspace stays primary and delivers a copy to the alias `coy-roburatis@double-xl.ai` (dual delivery, D1-A) |
| `<agent>@double-xl.ai` | agents (MCP) + Coy | Email Routing catch-all → worker |

- **Web UI:** `https://mail.double-xl.ai`, behind Cloudflare Access (app `agent-mail`, policy "Just Me"). There is no `workers.dev` URL and no preview URLs.
- **MCP:** `https://mail.double-xl.ai/mcp`. Agents authenticate with Access service tokens (Phase 5).

## Architecture (DoubleXL additions)

Upstream files carry short hooks marked `// doublexl:`; new behavior lives in new modules.

| Module | Responsibility |
|---|---|
| `workers/lib/config.ts` | Typed config: `DOMAINS`, `EMAIL_ADDRESSES`, `ADMIN_EMAILS` (vars); `config/aliases.json`, `config/principals.json` (R2, zod-validated, 30 s cache, invalidated on admin writes). |
| `workers/lib/routing.ts` | Inbound routing on the **envelope recipient** (`message.to`): alias → canonical mailbox; else an existing mailbox on a `DOMAINS` domain; else reject `5.1.1 Unknown recipient` before reading the body. |
| `workers/lib/access.ts` | Access JWT verification. Maps the token to a principal and returns 403 when none matches. Logs why a token was rejected (code, and whether iss/aud matched; never the token or secrets). |
| `workers/lib/authz.ts` | Principals (humans by `email`, agents by service-token `common_name`), `canAccessMailbox`, `canAdminister`. `ADMIN_EMAILS` are always admins. |
| `workers/lib/guards.ts` | `/mcp`: binds each MCP session to the identity that opened it. `/agents/*`: only the `EMAIL_AGENT` binding is routable, and only for accessible mailboxes. |
| `workers/lib/settings.ts` | Strict mailbox settings schema; only admins may change `agentSystemPrompt`. |
| `workers/lib/outbound.ts` | Every send goes through `sendFromMailbox`: From must be on a `DOMAINS` domain; Email Service errors become clear messages. REST sends finish before responding, and a failed send removes its Sent copy. |
| `workers/routes/admin.ts` | Admin-only `GET`/`PUT /api/v1/admin/aliases` and `/api/v1/admin/principals`. |

Authorization is enforced on: the mailbox list, `GET`/`PUT`/`DELETE /api/v1/mailboxes/:id`, every `/api/v1/mailboxes/:id/*` route (`requireMailbox`), every MCP tool (re-checked per call), and `/agents/*`.

## Configuration

| Name | Where | Value / notes |
|---|---|---|
| `DOMAINS` | `wrangler.jsonc` vars | `double-xl.ai, littlesaintscorner.com, roburatis.com`. Mailbox-creation allowlist, inbound allowlist, and sending allowlist. |
| `EMAIL_ADDRESSES` | `wrangler.jsonc` vars | `[]` (upstream hard allowlist; unused). |
| `ADMIN_EMAILS` | `wrangler.jsonc` vars | Bootstrap admins; must match the Access policy identities. |
| `POLICY_AUD` | Worker secret | AUD of Access app `agent-mail`. |
| `TEAM_DOMAIN` | Worker secret | `https://dblxl.cloudflareaccess.com`. A bare hostname is accepted, but set it with `https://`. |
| `config/principals.json` | R2 `doublexl-agent-mail` | Who may access which mailboxes. **Never commit it.** |
| `config/aliases.json` | R2 `doublexl-agent-mail` | `alias → canonical mailbox`, e.g. `coy-roburatis@double-xl.ai → coy@roburatis.com`. |

Principal shapes:

```json
[
  { "kind": "human", "id": "coy", "email": "coy@double-xl.com", "role": "admin", "mailboxes": ["*"] },
  { "kind": "agent", "id": "test-agent", "serviceTokenClientId": "<client-id>.access", "role": "member", "mailboxes": ["test-agent@double-xl.ai"] }
]
```

`mailboxes` entries are exact addresses, `*@domain`, or `*`.

## Common tasks

### Add a mailbox on an existing domain

Create it in the UI (admins only). No DNS or routing change: the domain's catch-all already sends every address to the worker, and the worker checks on each message whether the mailbox exists. Addresses without a mailbox bounce with 5.1.1.

### Add an alias or change who can see what

As an admin in the browser (or with an Access session cookie), `PUT` the whole document:

- `PUT /api/v1/admin/aliases` with `{"alias@domain": "mailbox@domain", ...}`
- `PUT /api/v1/admin/principals` with the full principals array

Both validate, write in one R2 put, and take effect immediately.

### Add a new domain

1. Add it to `DOMAINS` in `wrangler.jsonc` and deploy.
2. Enable Email Routing on the zone (adds apex MX/SPF/DKIM) **only if the domain has no other mail provider**, then set the catch-all → `doublexl-agent-mail`.
3. Onboard it for Email Service sending.
   - **If someone else (Google, Microsoft, …) sends as this domain, create `_dmarc` with `p=none` and the provider's SPF first.** Onboarding creates `_dmarc` with `p=reject` when none exists, which would bounce the other provider's unaligned mail. (This is why roburatis.com got `p=none` + Google SPF + Google DKIM before onboarding.)
4. Create the mailboxes.

### Deploy

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build && env -u CLOUDFLARE_API_TOKEN npx wrangler deploy --env-file /dev/null
```

`--env-file /dev/null` stops wrangler from picking up the account API token in the local `.env`, so the deploy runs as Coy's OAuth login (check with `wrangler whoami`). Don't use `cf deploy` here: it tries to migrate the project to its own build setup and rewrites `package.json`.

Rollback: `wrangler rollback --name doublexl-agent-mail`.

### Local development

`npm run dev` runs as a synthetic admin. To act as a configured principal, send `x-dev-principal: <email | service-token client id>` (dev builds only).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Invalid or expired Access token" after a successful Access login | The worker rejected the token. Run `wrangler tail doublexl-agent-mail` and reload: the "Access JWT rejected" log says whether `iss`/`aud` matched and whether `TEAM_DOMAIN` parses. (2026-10-07: `TEAM_DOMAIN` lacked `https://`.) |
| "Not authorized for this app" | The login verified but maps to no principal. Add it to `principals.json` (or `ADMIN_EMAILS`). |
| curl or an MCP client gets 403 "Just a moment…" | Super Bot Fight Mode on double-xl.ai challenges automated clients. Needs a WAF skip rule for `/mcp` before agents connect (Phase 5). |
| Mail to a new address bounces 5.1.1 | No mailbox exists for it. Create it in the UI. |
| Mail sent right after enabling Email Routing never arrives | The sender cached the domain's old "no MX" answer. It retries; re-send after a few minutes. Check Email Routing activity logs to see whether Cloudflare received it. |
| A send fails with "<domain> is not enabled for sending" | The domain isn't onboarded for Email Service sending. |
| Mail to `coy@double-xl.ai` never reaches the inbox | By design: the `coy@double-xl.ai → coy@double-xl.com` forward rule takes priority over the catch-all. |
