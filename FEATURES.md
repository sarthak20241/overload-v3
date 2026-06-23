# Overload — Features

*A marketing/sales reference. Benefit-led, grouped for reuse in the website, decks, store listings, and pitches. Sections are labelled **Live** (in the app today), **Coming soon** (next on the roadmap), and **Vision** (where it's headed).*

---

## The one-liner

**A workout tracker with an AI coach that's seen every set you've ever logged — and tells you what to do next.**

## The central theme

Most fitness apps just *store* your data. Overload turns it into a **coach that's with you for every rep** — it knows your history, catches your plateaus, and bases every suggestion on real research, not gym myths. A human trainer sees you twice a week. This one is there for every single set.

> **The philosophy:** getting stronger is a journey, not a one-off plan — and Overload walks every step with you. Today that's lifting. Soon it's diet, sleep, and lifestyle too.

## Why it's different

- **It remembers everything.** Every workout, every PR, every trend — and uses it.
- **It's proactive, not passive.** It doesn't just log; it tells you what to change.
- **It's backed by real science.** A research pipeline behind every recommendation (see "The Research Engine").
- **It's all heading into one place.** Train, eat, recover — one coach that sees the whole picture, instead of three apps that don't talk to each other.
- **Coaching without the price tag.** The guidance of a personal trainer, for the price of an app.

---

## 🏋️ Live today

### Coach Drona — your AI coach
The headline feature. A strength coach in your pocket that knows *your* numbers.
- **Chat** about anything — programming, plateaus, recovery, form, nutrition basics — with direct, no-fluff answers.
- **Generate a workout** for today, sized to your goal, experience, and recent training.
- **Generate a full multi-week plan** (Push/Pull/Legs, Upper/Lower, etc.).
- **Refine by conversation** — "make it shorter," "more chest," "swap squats" — and it rebuilds.
- **Knows your data** — references your real PRs, volume trends, and last sessions, not generic templates.
- **Cites real research** — tap to see the studies behind the advice.
- **Adapts to you** — comeback-aware after a break, adjusts to your equipment and time.

### Smart workout tracking
- **Picks up where you left off** — every exercise auto-fills your last weights and reps so you always know what to beat.
- **Built-in rest & exercise timers** — counts down recovery, skip when ready.
- **Automatic PR detection** — flags new personal records the second they happen.
- **500+ exercises** plus **custom exercise creation**.
- Start **from a saved routine or blank**; reorder, add, and remove exercises mid-session.
- **Pause/resume**, per-exercise notes, live set-by-set diff vs. last time.

### Routines
- **Create, edit, and delete** routines with targets (sets, rep ranges, rest, form notes).
- **AI-generate** a routine from a single prompt.
- One tap to start a routine as a live workout.

### Progress & analytics
- **Strength progression charts** per lift (weight or volume).
- **Volume trends**, **weekly sets/reps**, and **muscle-group balance** at a glance.
- **Personal records** list across all your lifts.

### Body tracking
- Log **bodyweight** and **body-fat %** with trend charts and a goal line.
- **13 body measurements** (chest, arms, waist, thighs, and more) with per-site charts and history.

### History
- **Calendar heatmap** of your training — see your consistency at a glance.
- Searchable, expandable session history; tap any day to filter.

### Gamification
- **XP and levels** earned from every workout.
- **8 progression tiers** — Beginner → Rookie → Regular → Dedicated → Athlete → Warrior → Elite → Legend.
- **Streak tracking** to keep you showing up.

### The Research Engine *(your trust story)*
Not a chatbot with a prompt — a real pipeline behind every recommendation:
1. **Listens to what lifters ask** to know where to get smarter.
2. **Reads the latest + established research** continuously.
3. **Keeps only what holds up** — trust-scores sources, flags contradictions, retires outdated claims.
4. **Distills papers into plain advice** — what to do, how much, when.
5. **Tailors it to you** — matched to your goal, experience, and actual numbers.

*This is the digestible summary — the full end-to-end flow is in **The Research Pipeline — complete** below.*

### Profile & training profile
- Goals, experience level, sessions/week, training age, body stats — all of which **feed the coach** so its advice is personalized.

### Design & access
- **Beautiful dark & light themes**; fast, clean, lifter-focused design.
- **Try it free as a guest** — explore before signing up.
- Sign in with **Apple, Google, or email**.
- In-app **bug reporting** and full **account/data deletion**.

### Plans & pricing
- **Free trial** of the coach, then a simple subscription (**monthly / annual / founding lifetime**).
- Positioned against a $150–250/month personal trainer — same guidance, fraction of the cost.

---

## 🔬 The Research Pipeline — complete

*The "Research Engine" summary above, in full. This is what makes Coach Drona's advice trustworthy — and it's a genuine moat. Great for investor diligence, technical credibility, and a deep-dive FAQ. Some specifics are under-the-hood (model/source names) — trim for public-facing copy.*

**The flow, end to end:**

> Curated sources → Fetch (checkpointed) → Filter opt-outs → Distill → Trust-score → Embed → Quarantine → Contradiction check → Human review → Live knowledge base → Supersede when outdated → Personalized retrieval → Cited in chat

**1. Curated sources.** Continuously pulls from the strength, nutrition, and recovery literature — **PubMed, Europe PMC, bioRxiv, SportRxiv** — plus manual curation. A per-source watermark (checkpoint) makes the daily run idempotent and resumable: nothing gets missed or processed twice, even if a run fails midway.

**2. Respect opt-outs & paywalls.** Every candidate is checked against a **publisher denylist** before anything is read. Creators who've asked not to be scraped (e.g. Stronger By Science) and paywalled sources (e.g. MASS) are skipped or limited to public abstracts. Ethical ingestion by design.

**3. Distillation.** Each paper is distilled (via Claude Haiku) into a structured record: the **key finding**, a one-line **practical takeaway**, **topic tags**, **study design** (meta-analysis / RCT / review / observational / preprint), **confidence** (established / replicated / single-study), population, and intervention. A dense paper becomes one usable coaching fact.

**4. Trust scoring.** Every entry gets a **trust score (0–1)** reflecting study quality and design. A strong meta-analysis outranks a lone preprint — and this score later weights what the coach actually surfaces.

**5. Embedding.** The finding is embedded (**Voyage 3, 1024-dimensional**) so it's retrievable *by meaning, not keywords* — "how much volume for growth" finds the right paper even if it never uses those exact words.

**6. Quarantine.** Nothing goes live automatically. New entries land in a **pending queue**, walled off from what the coach can see — so nothing unreviewed ever reaches a user.

**7. Contradiction detection.** Before approval, each new finding is matched against the existing knowledge base; for every close match, Haiku judges whether the two **contradict, agree, describe different conditions, or are unrelated** (with a rationale). Real conflicts are flagged on the pending entry, so a reviewer sees both sides side-by-side.

**8. Human review.** An admin works the queue (oldest first): sees the finding, takeaway, study design, trust score, source, and any contradiction flags — then **edits the distillation** if needed and either **approves** (promotes it into the live knowledge base) or **rejects** it with a reason. Human-in-the-loop is the final gate. (An automated review agent also runs, and its decisions are logged for audit.)

**9. Soft-supersede.** When newer, stronger work replaces an old finding, the old entry isn't deleted — it's **marked superseded** by the new one. Retrieval hides superseded entries so the coach never cites stale science, but the history stays — so the coach can still say *"earlier work suggested X, but recent meta-analyses show Y."* Fully reversible.

**10. Personalized retrieval.** When you ask the coach something, your question is embedded and matched against the live, non-superseded knowledge base. Results are ranked by **relevance × trust score**, then nudged toward **your goal** (a hypertrophy lifter and a fat-loss lifter asking the same question get evidence weighted toward their goal) — without ignoring strong off-goal findings.

**11. Cited in the answer.** The top findings are handed to Coach Drona, which weaves them into its reply with **tappable citations** (title, authors, year, link) — so you can check the source yourself.

**Security throughout:** the knowledge base is read-only to users and write-only to the ingestion worker; the pending queue, sources, and admin controls are locked down; every retrieval is scoped to the signed-in user.

**Why it matters (the moat):** most fitness AI is a chatbot with a prompt — it confidently repeats whatever was in its training data (gym myths included), with no sourcing and no way to stay current. Overload's coach answers from a **continuously-updated, quality-filtered, human-reviewed evidence base**, ranked for trust and personalized to you, *with citations*. That's expensive to build and hard to copy — it's the difference between an answer and an opinion.

---

## 🚀 Coming soon

- **Proactive coaching** — the coach reaches out *first*: catches plateaus early, celebrates victories, suggests your next workout, and nudges your diet — before you have to ask.
- **AI meal tracking** — just say *"chicken burrito and a shake"* and it logs your macros. No barcodes, no databases. And because the coach knows your training, **your food and your lifts finally talk to each other** (*"you're not gaining because you're under-eating on training days"*).
- **In-workout coach** — ask mid-set with full context of your live session: *"push another set?"*, *"shoulder's tweaking, swap this,"* *"only 20 min left, what do I cut?"*
- **Weekly & monthly reports** — your training reviewed like a pro athlete's: progress, PRs, what improved, and next week's focus. Spotify-Wrapped energy.
- **Celebrations & milestones** — every workout ends on a win; personal milestones (100th workout, 100-day streak, 1,000,000 kg lifted) and shareable cards.
- **"Did you know" insights** — surprising facts about your training (*"Tuesday is your strongest day," "your squat is up 15%"*) that bring you back, even on rest days.

---

## 🔭 The vision

Overload becomes the **one coach for your whole training life** — not just lifting, but **diet, sleep, and lifestyle**, all seen together. Because real progress isn't just what you do in the gym; it's how you eat, recover, and live. The end state: a coach that understands the full picture and guides every part of the journey — making the philosophy *"it walks every step with you"* literally true.

What makes this defensible: no standalone lifting app or food app can connect the dots between your training, nutrition, and recovery. Overload can — because it sees all of it.

---

## Who it's for

Intermediate-to-serious lifters who care about **progressive overload** — people who'd love a personal trainer's guidance but want it on-demand and affordable. Hypertrophy and strength trainees especially.

---

## Ready-to-use taglines

- *"Track every rep. Beat every PR."*
- *"The only gym app with a coach that knows your numbers."*
- *"A coach that's seen every set you've ever logged."*
- *"Stop guessing. Start overloading."*
- *"Your coach. There for every rep."*

---

*Last updated: keep this current as features ship — move items from "Coming soon" to "Live" as they launch.*
