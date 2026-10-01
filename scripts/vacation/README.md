# Vacation issue coverage, October 1–9, 2026

GitHub Actions acknowledges new public issues immediately and starts nightly
triage at 23:00 IST (17:30 UTC). GitHub can delay scheduled starts. Each run
attempts the oldest eligible report, limiting mobile submissions to one pair
of builds per night to conserve the account's monthly allowance. No local Mac is required.
New acknowledgments and fixes stop at midnight IST after October 9. A release
already underway may finish afterward.

The cloud worker uses the existing Claude subscription token. The fixer and
independent reviewer run separate sessions; neither can merge or deploy. The
controller runs TypeScript and the Deno suites, checks the reviewed commit and
unchanged main, and creates a PR. Missing credentials, unclear reports, failed
tests, or review findings leave the issue open with `vacation:needs-human`.
Infrastructure/dependency changes require maintainer attention. Existing
unrelated PRs are never picked up or merged.

Release credentials are supplied only to a separate job. Supabase migrations
must be new, additive, backward compatible and match remote pending migration
history. Functions changed by the fix are deployed; `_shared` changes fan out.
Mobile changes suppress the GitHub EAS trigger with `[skip eas]` and explicitly
run the existing EAS build-and-submit workflow at the
landed SHA. Its existing destinations are **TestFlight and Android alpha/closed
testing**, not a public App Store release or Google Play production rollout.
Workflow success is reported separately from store processing/availability.
Failures after merge reopen the issue for attention; no automatic rollback,
destructive migration, or repeated store submission is attempted.

## Setup and controls

- Repository variable `VACATION_ISSUES_ENABLED=true` enables both workflows.
  Set it to `false` to stop new work immediately. During coverage the older
  immediate Claude issue resolver is disabled to prevent duplicate fixes.
- Existing `CLAUDE_CODE_OAUTH_TOKEN` must authenticate successfully.
- `EXPO_TOKEN` is required for mobile releases.
- Existing `SUPABASE_ACCESS_TOKEN` and `SUPABASE_URL` deploy functions.
- `SUPABASE_DB_PASSWORD` is additionally required for database migrations.
- Enable GitHub Actions to create pull requests in repository Actions settings.
- Run **Vacation nightly issues → Run workflow → preflight_only=true** to test
  cloud AI and Expo login without modifying issues or deploying.
- `vacation:hold` excludes an issue. `vacation:needs-human` stops automatic
  retries. Review the blocker and existing PR before removing that label; an
  existing worker PR is left for attention rather than duplicated.
- GitHub Actions failure emails are the failure notification channel. The issue
  also gets progress, blocker, PR, and release comments. Enable GitHub email
  notifications before leaving.

Run controller checks with `python3 -m unittest discover -s scripts/vacation`.
This workflow is an automated bug-fix attempt with explicit gates; it cannot
guarantee every report will be fixed or a store will accept every submission.
