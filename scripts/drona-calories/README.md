# B1 calories: live checks and the model eval

```bash
npx tsx scripts/drona-calories/targets.mts        # data + moves on the live project (27 checks)
EVAL_VIA_CLI=1 npx tsx scripts/drona-eval/run.mts  # the model on held-out packs, via claude -p
```

`targets.mts` builds a Pro user on a cut with 12 logged days near 2100 and a
flat scale, then checks: the diet facts, the gate and anchor on real numbers,
who may apply, the four targets re-derived on the user's split and adding up,
the diary row (`source: card` with the card id), Undo putting the exact four
numbers back, apply + Undo cancelling in the diary, a hand edit winning, and
a free user being gated out. Two made-up users, removed afterwards.

`run.mts` is the ugly-week eval from plan section 3: clean stalls must come
out as a proposal inside the bounds, ugly weeks (weekend blowouts hiding in a
good mean, a target raised back by hand, a noisy scale, collapsed protein) as
a hold. Packs are held out: never paste them into the prompt. A CLI run proves
correctness only; its latency and token counts mean nothing.

The CLI shim (`scripts/parse-meal-eval/claude-cli-fetch.ts`) now honours
`tool_choice: any` by offering every tool and asking for `{"tool", "input"}`.
Before that it forced the first tool, which scored the model 2/6 on holds it
had written out in plain words. The real API path never had that problem.
