# Store listing copy — paste into consoles

This file is reference copy for the Apple App Store and Google Play Store
listings. Replace [PLACEHOLDER: ...] with your final values.

---

## App Store Connect

### App Information

- **App name** (max 30 chars): `Overload`
- **Subtitle** (max 30 chars): `Lift smarter. Track progress.`
- **Primary category**: Health & Fitness
- **Secondary category**: Sports
- **Content rights**: I do not own / I licensed all content (default: free for first launch)
- **Age rating**: 4+ (no objectionable content)

### Privacy Policy URL
[PLACEHOLDER: https://your-admin-domain.app/privacy.html]

### Support URL
[PLACEHOLDER: https://your-admin-domain.app/support.html]

### Marketing URL (optional)
[PLACEHOLDER: https://your-admin-domain.app/]

### Description (max 4000 chars)

```text
Overload is a strength training tracker built for people who actually
train. Log sets and reps in seconds, watch your numbers move, and get
sharp feedback when something is off.

WHAT'S INSIDE

• Routines — build your own splits or start from a template. Reorder
  exercises, set per-exercise targets, swap on the fly.

• Workout tracking — log weight × reps without leaving the active set.
  Rest timer counts down, RPE optional, supersets supported.

• Progress — every metric that matters: total volume, top set, e1RM,
  per-exercise PR history, and a clean weekly streak.

• Analytics — your trends as charts: lifts moving up, body weight vs
  goal, body fat over time, weekly session counts.

• AI Coach — ask in plain English. The Coach reads your recent training
  and gives suggestions grounded in real numbers, not vibes. Powered by
  Claude.

• Body stats — log weight and body fat as often (or as rarely) as you
  want. Optional. We don't pester.

• XP and levels — small dopamine hit for showing up. 11 levels, with
  tier titles. Hidden from the main UI if you don't care.

• Apple Sign-In, Google Sign-In, or email — your data syncs across
  devices.

DESIGNED TO STAY OUT OF YOUR WAY

We don't run ads. We don't sell your data. We don't gate the basics
behind a paywall. The app is fast on cellular, works on the road, and
your training history is yours to export at any time.

PRIVACY

You can delete your account from inside the app, and we wipe your data.
Read the full policy at [your privacy URL].
```

### Keywords (100 chars, comma-separated)

```text
workout tracker,gym log,strength training,lifting,bodybuilding,reps sets,routines,coach,fitness,prs
```

### What's New (per release, max 4000 chars)

```text
First release on the App Store. Welcome.
• Build routines and track every set
• Live analytics: volume, e1RM, PR history
• AI Coach answers questions about your training
• Sign in with Apple, Google, or email
• Delete-your-data control in Profile
Send bugs and ideas via Profile → Report a Bug.
```

### App Privacy answers (Data Collection)

Configure these in App Store Connect → App Privacy:

| Data type            | Collected? | Linked to user? | Used for tracking? | Purpose                        |
|----------------------|-----------|------------------|--------------------|--------------------------------|
| Contact Info / Email | Yes       | Yes              | No                 | App functionality              |
| User ID              | Yes       | Yes              | No                 | App functionality              |
| Health & Fitness     | Yes       | Yes              | No                 | App functionality, Analytics   |
| Sensitive Info       | No        | —                | —                  | —                              |
| Diagnostics / Crash  | Yes       | Yes              | No                 | App functionality (bug reports)|
| Identifiers (IDFA)   | No        | —                | —                  | —                              |
| Location             | No        | —                | —                  | —                              |
| Contacts             | No        | —                | —                  | —                              |
| Photos / Camera      | No        | —                | —                  | —                              |

Answer "no" to "Does this app use the AppTrackingTransparency framework?"

### Age rating questionnaire (key answers)

- Cartoon or fantasy violence: None
- Realistic violence: None
- Sexual content: None
- Profanity / crude humor: None
- Alcohol, tobacco, or drug use: None
- Mature/suggestive themes: None
- Gambling: None
- Horror/fear themes: None
- Medical/treatment information: None (the AI Coach gives training
  suggestions, not medical advice — but it does NOT diagnose or treat)
- Unrestricted web access: No
- Result: **4+**

### Encryption (Export Compliance)

- Does your app use encryption? **Yes** (HTTPS only, no custom crypto)
- Qualifies for exemption (only standard encryption)? **Yes**
- This is already declared in `app.json` →
  `ios.config.usesNonExemptEncryption: false`, so reviewers won't ask
  again.

### TestFlight

- Test Information / Beta App Description:
  ```text
  Overload is a strength training tracker. This TestFlight build is for
  internal testing of routines, workout logging, analytics, and the AI
  Coach flow. Sign-in via Apple, Google, or email. Send feedback via
  Profile → Report a Bug or directly to [PLACEHOLDER: your email].
  ```
- Test Account credentials: leave blank if anyone-can-test, or provide a
  guest account if the reviewer asks.
- Demo account for App Review: most reviewers won't sign up — give them
  a working account they can sign into. Create a `reviewer@tryoverload.app`
  test account in Clerk + Supabase before submission.

---

## Google Play Console

### Main store listing

- **App name** (max 30 chars): `Overload`
- **Short description** (max 80 chars):
  ```text
  Strength training tracker. Routines, PRs, analytics, AI coach. No ads.
  ```
- **Full description** (max 4000 chars): same body as App Store
  description above (Play accepts a richer block, but the same copy
  works fine).
- **Category**: Health & Fitness
- **Tags**: Workouts, Strength training (Play allows 5 tags)
- **Email**: [PLACEHOLDER: support@yourdomain]
- **Website**: [PLACEHOLDER: https://your-admin-domain.app/]
- **Privacy Policy**: [PLACEHOLDER: https://your-admin-domain.app/privacy.html]

### Content rating questionnaire (IARC)

- Violence: None
- Sex: None
- Language: None
- Controlled Substances: None
- Gambling: None
- Miscellaneous: This app does not contain user-to-user interaction,
  unrestricted internet, or location sharing. It DOES offer digital
  purchases (Coach Drona subscriptions + founding-member tiers via
  in-app purchase).
- Result: **Everyone** / **PEGI 3** / **CERO A** etc.

### Data Safety form

| Data type           | Collected? | Shared? | Optional? | Purpose                  |
|---------------------|-----------|---------|-----------|--------------------------|
| Email address       | Yes       | No      | No        | Account management       |
| User IDs            | Yes       | No      | No        | Account management       |
| Health & Fitness    | Yes       | No      | No        | App functionality        |
| App diagnostics     | Yes       | No      | Yes       | Bug reports user submits |

- Encryption in transit: **Yes** (HTTPS)
- Users can request deletion: **Yes** (in-app via Profile → Delete Account)

### Target audience

- Age groups: **18 and over** (training app for adults; can include 13+
  if you want broader reach — set to 13+ if comfortable)

### Ads declaration

- App contains ads: **No**

### News app: **No**
### Covid-19 contact tracing: **No**

### Government apps: **No**

### Internal testing setup

1. Create a Google Group: `overload-internal-testers@googlegroups.com`
   (or use individual emails).
2. Play Console → Testing → Internal testing → Create new release.
3. Upload AAB from `eas build --platform android --profile production`
   (or the EAS submit pipeline does it automatically).
4. Add testers, share the opt-in URL.

### Service account for `eas submit`

For `eas submit --platform android` to upload automatically:

1. Google Play Console → Setup → API access.
2. Create a service account in Google Cloud, grant it the
   **Release manager** role.
3. Download the JSON key.
4. Save it at the repo root as `google-service-account.json` (already
   gitignored via `.gitignore` if it isn't, ADD IT).
5. eas.json already points to `./google-service-account.json`.

---

## Shared asset checklist

- [ ] App icon 1024×1024 PNG (no transparency, no rounded corners — Apple rounds it) — likely already at `assets/icon.png`, just verify dimensions.
- [ ] Android Play Store icon 512×512 PNG (same source, different size)
- [ ] iOS screenshots:
  - 6.7" (iPhone 15 Pro Max, 1290×2796) — required, 3-10 images
  - 6.5" (iPhone 11 Pro Max, 1242×2688) — required, 3-10 images
  - 5.5" — optional but improves older device coverage
- [ ] Android screenshots:
  - Phone (1080×1920 or higher) — required, 2-8 images
  - 7" tablet — optional (we have supportsTablet: false on iOS but Android is fine without)
  - 10" tablet — optional
- [ ] Feature graphic for Play Store (1024×500 PNG/JPG, no transparency)
- [ ] App preview video (optional, 15-30s, both stores accept)
