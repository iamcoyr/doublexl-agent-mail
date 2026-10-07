# Kickoff prompt

Paste the block below into Claude Code, opened in a local clone of `iamcoyr/doublexl-agent-mail`, after copying this package's `CLAUDE.md` and `docs/handoffs/mailbox-setup/` into the repo.

---

```
We're turning this repo (our fork of cloudflare/agentic-inbox) into a central multi-domain mailbox for DoubleXL agents and for my human mailboxes coy@roburatis.com and coy@littlesaintscorner.com.

Read CLAUDE.md, then docs/handoffs/mailbox-setup/HANDOFF.md and docs/handoffs/mailbox-setup/INFRA_RUNBOOK.md in full before doing anything.

Then do Phase 0 only:
1. Add the upstream remote and confirm the fork still matches upstream except package.json and wrangler.jsonc.
2. npm ci and npm run typecheck. Report any pre-existing failures, but don't fix them yet.
3. Run wrangler whoami and the read-only checks in INFRA_RUNBOOK §0. Tell me if anything differs from HANDOFF §2.
4. Add Vitest with @cloudflare/vitest-pool-workers and one smoke test.
5. Ask me decisions D1–D4 from HANDOFF §3 using multiple-choice questions, record my answers in the Decisions log, and stop.

Don't change anything in the Cloudflare account during Phase 0. When you show me code changes, show whole files.
```

---

## Later phases

After Phase 0, start each phase with:

```
Start Phase <N> from docs/handoffs/mailbox-setup/HANDOFF.md. Follow the checklist, keep upstream files to small `// doublexl:` hooks, and stop for my OK before any INFRA_RUNBOOK step that changes the account.
```
