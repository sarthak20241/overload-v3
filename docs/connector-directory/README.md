# Listing the Overload connector in Claude and ChatGPT

Server: `https://mcp.tryoverload.app` (the `mcp` edge function behind the
Vercel forwarder in `mcp-proxy/`). Sign-in: Clerk OAuth. Use needs Overload Pro.

## Before either submission

1. **Reviewer account.** Make a new Overload account for reviewers only. Do
   not use a real user's account.
   - Sign in with email and password. No email codes, no magic links, no
     Google or Apple, no 2-step login. Check in the Clerk dashboard that this
     user can sign in with only a password.
   - Give it Pro (set `user_profiles.tier` with a far `tier_expires_at`).
   - Fill it: about 3 weeks of food and workouts, a bench press history, a
     few body weights, a live program with targets. Every test case below must
     have data to read.
   - Run every test case with this account in Claude and in ChatGPT.
2. **Deploy this branch's `mcp` function** and apply
   `supabase/migrations/20261112130000_mcp_update_workout_old_week.sql`.
3. **Redeploy `mcp-proxy/`** (`vercel deploy --prod` from `mcp-proxy/`) so the
   OpenAI domain check path is forwarded.

## Claude: Connectors Directory

Portal: https://claude.ai/directory/manage -> Submit new -> MCP connector.
Rules: https://claude.com/docs/connectors/building/submission

| Step | What to enter |
|---|---|
| Connection | `https://mcp.tryoverload.app` (one URL for every user) |
| Tools | Syncs by itself. All 16 tools have a title and a read or write hint. |
| Listing name | Overload |
| One-liner (200) | Read and log your Overload food diary, workouts, lifts and body weight from Claude. |
| Description (2000) | Use the `longDescription` text in `openai-plugin/plugin.json`, with "ChatGPT" changed to "Claude". |
| Categories | Health and fitness (plus Productivity if offered) |
| Docs URL | https://tryoverload.app/chatgpt-claude |
| Privacy URL | https://tryoverload.app/privacy.html |
| Support | hello@tryoverload.app |
| Icon | `assets/icon.png` (1024 x 1024) |
| Slug | `overload` (permanent once published) |
| Use cases | Ask about your food, macros, workouts, lift progress and weight; log food and workouts by chat. Users need an Overload account with Pro. Reads and writes. |
| Authentication | Required. OAuth. Claude uses Clerk's client ID metadata (CIMD), so no client ID or secret is needed. |
| Data handling | Our own API. Yes, it handles personal health data (food, body weight, workouts). No sponsored content. |
| Test & launch | Reviewer account email + password, and the steps: add the connector, sign in, try the 5 prompts below. |

## ChatGPT: plugin directory

Portal: https://platform.openai.com/plugins
Rules: https://developers.openai.com/plugins/deploy/submission

1. Organization settings: verify your identity (individual or business).
2. Upload the package first; the portal makes the draft from it. The zip
   holds one folder (`overload/`) with `plugin.json`, `.codex-plugin/plugin.json`,
   `mcp.json`, `.mcp.json`, `skills/` and `assets/`. `tools_triggered` is a
   string. The plugin category comes from the plugin list (Productivity,
   Developer Tools, ...); it has no health option, and LIFESTYLE (the old
   apps list) is refused.
3. MCPs -> Connect. The portal shows a domain token. Set it, then press verify:
   `supabase secrets set OPENAI_APPS_CHALLENGE=<token>`
   Check: `curl https://mcp.tryoverload.app/.well-known/openai-apps-challenge`
   prints only the token. Then connect and sign in with the reviewer account.
4. Every tool must send readOnlyHint, destructiveHint and openWorldHint as
   explicit booleans (protocol.ts does this). Rescan after a deploy.
5. Add review information: reviewer email + password and sign-in steps (never
   in the zip), and a demo recording URL (required).
6. Submit for review. After approval, press Publish plugin.

The 5 positive and 3 negative test cases are in `openai-plugin/plugin.json`
under `review.test_cases`. Use the same 5 prompts for Claude's reviewers.
