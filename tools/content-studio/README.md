# Overload Studio

A local website that suggests post topics, writes posts for X, LinkedIn and
Reddit, and publishes them. It writes with your **Claude subscription** (via
the `claude` CLI) or your **ChatGPT subscription** (via the `codex` CLI), not
with a paid API key.

It runs on your Mac only. Never deploy it: it shells out to your CLI login and
holds your social tokens.

## Start

```bash
cd tools/content-studio
npm install
cp .env.local.example .env.local   # optional: X and LinkedIn keys
npm run dev                        # http://localhost:4747
```

## The flow

1. **Brief**: what the writer knows about Overload and you. Seeded from
   FEATURES.md and the founder note. Add real moments to "Founder's story":
   the writer never invents facts, it leaves `[placeholders]` instead.
   Recent commits on `main` and FEATURES.md are read live on every run.
2. **Research**: web research per channel (how the feed ranks posts,
   formats, first lines, ban rules). 2 to 5 minutes each. Redo monthly.
3. **Ideas**: topics, each with one core idea (commander's intent), a hook,
   and how it uses the six Made to Stick principles. Pick pillars, add a focus.
4. **Drafts**: "Write for X / LinkedIn / Reddit" on any idea. Edit by hand or
   rewrite with a note. Char counters, em dash guard, placeholder guard.
5. **Publish**:
   - X: posts or threads via the API (pay-per-use credit, ~$0.015 a post,
     $0.20 with a link), or a free button that opens X filled in.
   - LinkedIn: posts via the API after "Connect LinkedIn" (60-day login),
     or opens LinkedIn with the text copied.
   - Reddit: opens the subreddit's submit page filled in and copies the body.
     You press Post. Reddit closed new API apps in Nov 2025 and bans bot
     posting.

Every API post shows the exact text and asks you to confirm first.

## Where things live

- `data/` (gitignored): brief, research, ideas, drafts, LinkedIn token.
- `knowledge/made-to-stick.md`: the sticky-idea rules every prompt uses.
- `lib/generate.ts`: all prompts. `lib/llm.ts`: the CLI runner.

## Notes

- The CLI is run with MCP servers and settings files off. Without that, each
  call loaded ~460k tokens of plugins before reading the prompt.
- If X posting returns 403, the app permission is not "Read and write", the
  access token was made before that change, or the credit balance is zero.
- LinkedIn API version is `202609`. If LinkedIn retires it, set
  `LINKEDIN_VERSION=YYYYMM` in `.env.local`.
