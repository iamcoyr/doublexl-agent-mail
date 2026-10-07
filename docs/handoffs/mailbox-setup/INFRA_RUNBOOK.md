# Infra runbook: doublexl-agent-mail

Every change to the live Cloudflare account (and the one in Google Workspace) needed for `docs/handoffs/mailbox-setup/HANDOFF.md`, in order.

**Rule:** each numbered step that changes something needs Coy's explicit OK in the session before you run it. State what you're about to change, run it, verify it, and report. Read-only checks need no approval.

Tools: `wrangler` (logged in as Coy's DoubleXL user), the Cloudflare API, or the dashboard. Where the API is shown, the paths are from the public Cloudflare API. Check the request bodies against the current API docs before sending.

Account facts captured 2026-10-06:

- Worker: `doublexl-agent-mail`
- Access team domain: `https://dblxl.cloudflareaccess.com`
- Access app: `agent-mail`, id `0a71ffa7-13d1-44bb-8048-d273bd0a10e0`, domain `mail.double-xl.ai`
- Look up zone IDs with `GET /zones?name=<domain>`. Don't hard-code them.

---

## §0 Pre-flight (read-only)

```bash
wrangler whoami                          # must be Coy's DoubleXL user, on the account that owns the worker
wrangler deployments list --name doublexl-agent-mail
wrangler r2 bucket list | grep -i agent  # expect nothing; the bucket is missing
```

Also re-confirm with the API:

- `GET /zones/{zone}/email/routing` and `/rules` and `/rules/catch_all` for `double-xl.ai` and `littlesaintscorner.com`;
- the MX records on `roburatis.com` (expect `smtp.google.com`) and `littlesaintscorner.com` (expect none on the apex).

**If anything differs from HANDOFF §2, stop and tell Coy.**

## §1 R2 bucket (Phase 3)

```bash
wrangler r2 bucket create doublexl-agent-mail
```

**Verify:** `wrangler r2 bucket list` shows the bucket.
**Rollback:** `wrangler r2 bucket delete doublexl-agent-mail`, only while it's empty.

## §2 Custom domain for the app (Phase 3)

Add to `wrangler.jsonc` (committed; hostnames aren't secret):

```jsonc
"routes": [
  { "pattern": "mail.double-xl.ai", "custom_domain": true }
],
"workers_dev": false
```

Deploying in §4 creates the DNS record and certificate. Turning off `workers_dev` removes the unprotected `*.workers.dev` URL.

**Verify** (after §4): `dig mail.double-xl.ai` resolves to Cloudflare; the workers.dev URL is gone.

## §3 Access app and service auth (Phase 3)

1. **Policy cleanup** on app `0a71ffa7-…`. Remove **"Worker API Bypass"** (bypass using `common_name` path patterns, a misconfiguration) and **"cms-bypass-policy"** (bypass for a group). Keep **"Just Me"** (allow `coy@double-xl.com`, `coy@robison.family`). The onboarding policy that duplicates `coy@double-xl.com` can be removed or kept; ask Coy.
   - Check first whether those bypass policies are reusable policies shared with other apps. If so, **detach them from this app only**; don't delete them.
2. **Service Auth policy.** Add a policy with decision **Service Auth** (`non_identity`) that includes the specific agent service tokens. Start with `agent-mail-test-agent`, created in §8. Don't use "any valid service token": that would let every DoubleXL token (`gospel-collection-service`, `guest-portal-worker`, …) in.
3. **Secrets on the worker:**
   ```bash
   # AUD: GET /accounts/{account}/access/apps/0a71ffa7-13d1-44bb-8048-d273bd0a10e0 → result.aud
   wrangler secret put POLICY_AUD --name doublexl-agent-mail
   wrangler secret put TEAM_DOMAIN --name doublexl-agent-mail   # https://dblxl.cloudflareaccess.com
   ```
   Both secrets already exist from April, but their values are unknown. Re-set them so you know they match.

**Verify** (after §4): in a private window, `https://mail.double-xl.ai` redirects to the Access login. After login as `coy@double-xl.com` the UI loads. `curl` without credentials gets the Access login page, not the app.

## §4 Configuration and deploy (Phase 3)

1. `wrangler.jsonc` vars (non-secret, committed):
   ```jsonc
   "vars": {
     "DOMAINS": "double-xl.ai, littlesaintscorner.com, roburatis.com",
     "EMAIL_ADDRESSES": [],
     "ADMIN_EMAILS": ["coy@double-xl.com", "coy@robison.family"]
   }
   ```
2. Seed R2 config. **Not committed:** write the files to a temp dir outside the repo and upload them.
   ```bash
   # principals.json: see the example below
   wrangler r2 object put doublexl-agent-mail/config/principals.json --file /tmp/principals.json --content-type application/json --remote
   wrangler r2 object put doublexl-agent-mail/config/aliases.json --file /tmp/aliases.json --content-type application/json --remote
   ```
3. Deploy: `npm run deploy`.

Example `principals.json`. The Client IDs come from §8.

```json
[
  { "kind": "human", "id": "coy", "email": "coy@double-xl.com", "role": "admin", "mailboxes": ["*"] },
  { "kind": "human", "id": "coy-family", "email": "coy@robison.family", "role": "admin", "mailboxes": ["*"] },
  { "kind": "agent", "id": "test-agent", "serviceTokenClientId": "<client-id>.access", "role": "member", "mailboxes": ["test-agent@double-xl.ai"] }
]
```

Example `aliases.json` (D1-A):

```json
{ "coy-roburatis@double-xl.ai": "coy@roburatis.com" }
```

**Verify:** sign in as Coy and create the mailboxes `coy@littlesaintscorner.com`, `coy@roburatis.com`, and `test-agent@double-xl.ai`. Then confirm with `wrangler r2 object get … mailboxes/<addr>.json --remote` that the objects exist.

**Rollback:** `wrangler rollback --name doublexl-agent-mail` to the previous version.

## §5 littlesaintscorner.com: inbound and outbound (Phase 4)

The apex has no MX and Email Routing is unconfigured, so there's nothing to break.

1. Enable Email Routing on the zone: dashboard → littlesaintscorner.com → Email → Email Routing → Enable, or `POST /zones/{zone}/email/routing/dns`. This adds apex MX (`route1-3.mx.cloudflare.net`) and an apex SPF.
   - Check that it doesn't disturb the existing `cf-bounce.` and `send.` subdomain records or the `resend._domainkey` record. Those are used by other DoubleXL senders, likely `littlesaintscorner-api` via SES/Resend.
2. Catch-all → worker:
   ```
   PUT /zones/{zone}/email/routing/rules/catch_all
   { "enabled": true, "matchers": [{ "type": "all" }], "actions": [{ "type": "worker", "value": ["doublexl-agent-mail"] }] }
   ```
3. Outbound: Email Service sending is already enabled for `littlesaintscorner.com`. Nothing to do.

**Verify:**
- Send from an outside account (e.g. Gmail) to `coy@littlesaintscorner.com`, and separately CC-only. Both arrive.
- Reply from the inbox. The received headers show `dkim=pass` and `dmarc=pass` (DMARC is `p=reject` here, so a failure means a bounce).
- Mail to `nobody@littlesaintscorner.com` is rejected with 5.1.1 (D4).

**Rollback:** disable the catch-all (`"enabled": false`). Email Routing can stay enabled.

## §6 double-xl.ai: agents (Phase 4)

Email Routing is already on, with the rule `coy@double-xl.ai` → forward to `coy@double-xl.com`. **Keep that rule.** Specific rules take precedence over the catch-all.

1. Catch-all → worker, with the same body as §5.2 on the double-xl.ai zone.
2. Outbound per D2.
   - **Default `@double-xl.ai`:** onboard the apex for sending (dashboard → Email Service → add domain, or `POST /zones/{zone}/email/sending/subdomains` with the apex). Today only `mail.double-xl.ai` is onboarded. The apex already has a Cloudflare SPF and a `cf2024-1._domainkey` record from Email Routing; let onboarding add whatever it needs and check the resulting DNS status endpoint.
   - **If D2 = `@mail.double-xl.ai`:** sending is already onboarded. Add Email Routing for the `mail.double-xl.ai` subdomain instead.

**Verify:**
- External → `test-agent@double-xl.ai` arrives in that mailbox.
- `coy@double-xl.ai` still forwards to `coy@double-xl.com`.
- `test-agent` sends to an external address with `dkim=pass`.

**Rollback:** disable the catch-all.

## §7 roburatis.com (Phase 4, per D1)

**Hard rule: never change, delete, or "fix" the apex MX on roburatis.com.** If the dashboard prompts to replace existing MX records, decline.

### D1-A (default): dual delivery from Google Workspace

1. **Coy does this himself in Google Workspace** (Admin console → Apps → Google Workspace → Gmail → Routing). Add a rule for recipient `coy@roburatis.com` that also delivers to `coy-roburatis@double-xl.ai`. Claude Code only provides these instructions and the target address.
   - This depends on §6.1, which makes `double-xl.ai` deliver to the worker, and on the alias in `config/aliases.json`.
2. Onboard roburatis.com for Email Service sending, after confirming with the API spec that onboarding doesn't require enabling Email Routing on the zone. If it does, stop and ask Coy.
3. DNS hygiene. roburatis.com has **no SPF and no DMARC** today. Propose them to Coy, and add them only with his OK:
   - apex SPF `v=spf1 include:_spf.google.com ~all` (Email Service uses its own bounce subdomain for SPF);
   - `_dmarc` `v=DMARC1; p=none; rua=mailto:…` to start; tighten later.

**Verify:**
- External → `coy@roburatis.com` arrives in **both** Gmail and the inbox.
- Reply from the inbox arrives externally from `coy@roburatis.com` with `dkim=pass` and `dmarc=pass`.
- Gmail is unaffected.

### D1-B (only if Coy chooses a cutover)

Plan this separately with Coy, including a time window, lowering the MX TTL a day ahead, and a rollback to `smtp.google.com`. Not covered here.

## §8 Agent service tokens (Phase 5)

For each agent (start with `test-agent`):

1. Create the service token `agent-mail-<agent>`: dashboard → Zero Trust → Access → Service credentials, or `POST /accounts/{account}/access/service_tokens`. **The secret is shown once.** Give it to Coy to store in his secret manager. Never write it to the repo, to chat logs that get committed, or to R2.
2. Add the token to the Service Auth policy (§3.2).
3. Add a principals entry with its Client ID (§4.2 format), and upload `config/principals.json` again (or use `PUT /api/v1/admin/principals` once Phase 2 ships it).
4. Create the agent's mailbox and set its `agentSystemPrompt` as admin.

MCP client config for the agent (documented in `docs/agents.md`, Phase 5):

```json
{
  "mcpServers": {
    "agent-mail": {
      "type": "http",
      "url": "https://mail.double-xl.ai/mcp",
      "headers": {
        "CF-Access-Client-Id": "${AGENT_MAIL_CLIENT_ID}",
        "CF-Access-Client-Secret": "${AGENT_MAIL_CLIENT_SECRET}"
      }
    }
  }
}
```

**Verify:** with the token, `list_mailboxes` returns only `test-agent@double-xl.ai`, and `get_email` against `coy@roburatis.com` is refused.

## §9 Global rollback

1. Disable the catch-alls on littlesaintscorner.com and double-xl.ai.
2. Remove the Workspace dual-delivery rule (Coy).
3. `wrangler rollback`.

Mail then flows exactly as it did before this project.
