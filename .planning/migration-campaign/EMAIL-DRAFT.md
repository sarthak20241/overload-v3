# Old Overload users: invite email + free month

Status (2026-10-31): email APPROVED, sharer reward ON (+1 month per friend, up
to 3), sender = Zoho. Built, not live, nothing sent:

- DB: `supabase/migrations/20261031150000_invite_codes.sql` (NOT applied),
  tests `supabase/functions/_shared/inviteCodes.test.ts` (7 pass)
- App: `app/invite.tsx`, `lib/invite.ts`, Profile "Have an invite code?" row
- Website: `~/Coding/overload-website/.claude/worktrees/invite-page`
  (branch `claude/invite-page`), page `app/i/[code]`
- Send scripts (local, gitignored): `migration/campaign/` export-users.js,
  make-codes.js, email.js, send.js; secrets go in `migration/campaign/.env`

## The email

**Subject:** The new Overload, and a free month on me

> Hi there,
>
> You used Overload, the workout tracker I built. Thank you. You were one of the
> first people to trust it with your training, and that is why I kept building.
>
> I rebuilt it from zero. The new Overload is live on the App Store and Google Play.
>
> **What it fixes**
>
> Most of us log our workouts. The hard part is the plan around them: what to
> train and how much, what to eat, how to sleep and recover, and how long the
> goal should really take. And the plan has to adjust to the progress you
> actually make.
> That is why I built Overload. It brings your training, food and recovery
> together and turns them into one plan to your goal.
>
> - Set your goal and Overload builds the plan to get there.
> - It walks the plan with you, watches your progress, and adjusts when needed.
> - Log food in plain words with AI. It learns how you eat, so most logs take one tap.
> - It spots patterns and steers you back when you drift off track.
>
> **Free, forever**
>
> - Log every workout: routines, sets, PRs, history and progress charts
> - Track your food and macros
> - Drona builds your first training phase for you
> - 3 chats with Drona and 3 AI food logs every day
>
> **Your free month of Pro**
>
> Tap your link and you get Pro free for 1 month. No card. Nothing renews.
>
> - Unlimited chat with Drona
> - Unlimited AI food logs. Type "2 eggs and toast" and it is logged.
> - Your plan, rewritten every week
>
> **[Get my free month]** → `tryoverload.app/i/{CODE}`
>
> Or open the app and enter code **{CODE}** in Profile.
>
> **Bring a friend**
>
> Your link works for friends too. Each friend gets their own free month.
> {IF REWARD: For every friend who joins, you get one more month, up to 3.}
>
> Thanks again for being here at the start.
>
> Sarthak
> Overload
>
> _Reply "stop" and I will not email you again._

## How the free month works (no store, no card)

The server already has a "trialing" state. The app and Drona already treat it
the same as Pro, on iPhone and Android. A code gives the user 30 days of it.
When the 30 days end, they go back to Free. Nothing bills.

## What I will build after your OK

1. **Database:** a table of invite codes (one per old user) and a `redeem_invite`
   function. One free month per account, ever. A paying user is not changed.
2. **App (OTA update, no new build):** "Have a code?" row in Profile, and the
   link opens the app with the code filled in.
3. **Website:** `tryoverload.app/i/{CODE}` page. It shows the offer, the code,
   and App Store + Play buttons.
4. **Send script:** reads the old users from MongoDB, makes one code each, and
   sends one email per person, slowly, so it does not look like spam.

I test all of it and show you before anything goes live or any email goes out.

## Optional (not in the email now)

"Want your old workouts in the new app? Reply and I will move them." The
migration scripts exist, but each user is a manual job today. Add this line only
if you want up to 200 replies to handle.
