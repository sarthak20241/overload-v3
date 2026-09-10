# Correction tagging: one field, two meanings (Sarthak's redesign)

Status: BUILT and measured, 2026-09-07 (branch claude/super-client, not yet
deployed). Raised by Sarthak 2026-09-06 while we were diagnosing a correction
that silently deleted a line the user never mentioned. What shipped is the
final shape below, reached through two intermediate designs that measurement
rejected - kept here because the rejections are the reasoning.

## The final rule (what is in the code)

corrects_food_name is the IDENTITY LINK, and it goes on every line the
correction touched and only those:

    edit      "make the poha half a plate"   poha entry carries "Poha" (own name)
    swap      "rice, not poha"               rice entry carries "Poha" (old name)
    untouched                                null

Non-null is what "changed" means. No second field. A line with a tag is
re-resolved and its previous version is never restored (it is superseded);
a line without one is copied back verbatim by keepUncoveredPrevious.

Three guards hold it up, and each exists because the previous design failed
without it:
1. replacedNames holds every tag, EDITS INCLUDED - or decide renaming an
   edited line ("Rajma Chawal" -> "Rajma Masala") gets the old one restored
   beside the new one. Measured: two rajmas, 594 + 433 kcal.
2. reconcileExtracted runs on corrections over the changed lines - or an
   edited line decide forgets to emit vanishes, because (1) marked it
   do-not-restore.
3. Untouched lines carry no tag, so (1) never touches them and the guard
   restores them.

Measured 3/3 on the correction cases plus the addition case, with the trace
showing "2 plate Rajma Chawal EDITED", replaced ["rajma chawal"], restored
[Poha, Banana], gone [].

## Two designs that were tried and rejected by measurement

- Tag only changed lines, comparison decides changed-ness (2026-09-06 pm):
  the name+amount+unit comparison kept reporting untouched lines as changed
  ("plate" vs "serving"), and a line wrongly called changed was re-sectioned.
- Split into corrects_food_name (swaps only) + is_changed (edits) (2026-09-07
  am): an edit then carried no identity link, so decide renaming it produced
  a duplicate. The fact that was missing both times: WHICH old line does this
  corrected line stand for.

## Original proposal, as written on 2026-09-06

## The problem, stated once

`corrects_food_name` carries TWO meanings at the same time:

1. "this returned line stands for that previous line" - an identity link, and
   the app needs it because decide RENAMES lines ("cheese slice" comes back as
   "Amul Cheese slices"), so name matching alone is not reliable.
2. "the user deliberately swapped that previous line out" - which is what stops
   `keepUncoveredPrevious` resurrecting the tofu after "actually paneer not
   tofu".

The extract prompt tells the model to re-list EVERY line of the previous meal
with `corrects_food_name` copied in, unchanged lines included. So every line
carries a field whose second meaning is destructive. Untouched lines are
wearing a tag that reads "deliberately deleted".

That is not a hypothetical. It cost a user's whole Breakfast section on live
v154, and it cost two wrong diagnoses before the real one.

## Sarthak's proposal

Tag ONLY the lines the correction actually re-targets. An untouched line comes
back with `corrects_food_name: null`, and the app reads the absence of a tag as
"keep this line as it was".

Then the field means exactly one thing: **this replaces that**. The destructive
reading applies only where it was intended.

## Why it is better

- One field, one meaning. The class of bug above stops being expressible.
- The two consumers (identity link, replacement marker) stop sharing a channel,
  so a change to one cannot silently alter the other.
- It matches what the user actually said. "Make it 2 plates of rajma chawal"
  names one line; the wire format should name one line.

## Why it was NOT done today, and what has to be true first

The codebase's standing rule, written in several places in parseMeal.ts, is
that a per-turn model instruction is not something to trust - which is exactly
why `keepUncoveredPrevious`, `preserveManual` and the removal enforcement exist
at all. This proposal moves a correctness guarantee ONTO model behaviour:

- Today the model is asked to FILL a field. Models are reliable at that.
- The proposal asks it to correctly OMIT a field. That is a weaker ask, and the
  failure is silent and worse: if the model tags everything anyway (which is
  what it does today, because that is what it is told), then under the new
  reading EVERY line is "deliberately replaced" and a dropped line is never
  restored. The current design degrades to an unnecessary re-resolve; the
  proposed one degrades to data loss.

So it is a better design that needs a code-side backstop before it is a safer
one.

## What would make it shippable

1. Keep the code-side comparison (`unchangedInCorrection`) as the source of
   truth for "was this line actually changed", and use the model's tag only as
   a hint. Then the tag being wrong costs nothing.
2. Only after (1) holds, simplify the prompt to tag re-targeted lines only.
3. Eval cases that assert the untouched lines survive, on both correction
   roads (decide and the fast path). Two now exist:
   `correction-keeps-untouched-lines` and
   `correction-keeps-untouched-lines-catalog-only`.

Note that (1) is most of the value on its own, and does not need the prompt
change at all. Worth doing (1) first and re-deciding whether (2) is still
wanted.

## Related

- `scopeCorrection` in parseMeal.ts - un-marks untouched lines. The un-marking
  used to sit inside the resolve-narrowing branch and so ran only sometimes.
- `correction_guard` / `correction_scope` trace steps - added 2026-09-06 so this
  class of failure is readable from a trace instead of inferred from code.
