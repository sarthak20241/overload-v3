# Food card editing verification

Verified October 1, 2026 on iPhone 17e, iOS 26.5. The development client was rebuilt locally from main commit `3a6a3fe` and served by this worktree's Metro on port 8082. The previously running simulator used the older checkout on port 8081, which explained the outdated Quantity/Amount labels.

## Simulator checks

| Feature | Before | Verified after |
| --- | --- | --- |
| Live calorie feedback | Proposal editor had no macro-to-calorie comparison. | Lassi's 4.5 P / 28 C / 5 F produced 175 calories. Entering 300 showed the discrepancy; entering zero exposed Use it, which filled 175. Egg protein edited to 20.5 produced 185.4 calories; Use it filled 185 and saved the proposal. |
| Decimal macro display | Lassi editor showed 4.5 g protein while the proposal showed 5 g. | Proposal displayed egg carbs 1.1 g and toast fat 1.5 g, with totals 15.1 g carbs and 12.5 g fat. Editing egg protein to 20.5 displayed 20.5 on the item and 23.5 on the combined card. Saved entries and meal subtotals displayed 6.7 and 20.1 g protein. |
| Full editing after logging | Saved entry offered quantity, meal section, and delete only. | Same editor now exposes serving size, unit, quantity, calories, protein, carbs, fat, and calorie feedback. Saved 300 calories / 6.7 g protein and moved Breakfast to Lunch on September 27; reopened and restarted app to confirm persistence. |
| Portion scaling and cancellation | Saved editor could not change serving size or label. | Reopened manual snapshot scaled 1 to 2 quantities as 600 calories / 13.4 g protein; Cancel left saved 300 / 6.7 intact. Size 2 × quantity 1.5, labelled QA glass, produced and saved 720 g / 900 calories / 20.1 g protein. Reopening retained size, label, and quantity. Final code moved the fixture back to Breakfast without changing nutrition or date. |
| Serving label typing | Deleting through the temporary letter g while replacing glass incorrectly changed the size to grams. | Conversion now occurs when the label edit is completed or saved. Replacing glass with QA glass preserved size and portion; subsequent scaling remained correct. |
| Keyboard visibility | Feedback was absent in proposal editor. | With the numeric keyboard open, all four macro inputs, calorie feedback, Cancel, and Save remained visible above it. |

The single saved simulator fixture is identifiable as lassi, `1.5 × 2 QA glass`, 900 calories, on September 27. Cleanup requires the user's confirmation. The eggs/toast proposal was not logged.

## Automated validation

- `deno test lib/servingSize.test.ts`: 7 passed, including named-unit edits and mass conversion.
- `deno test --no-check lib/loggedEntryEdit.test.ts`: 7 passed. Runtime tests cover decimal snapshot persistence, a meal move on a past date, failed writes, zero-row writes, invalid values, null grams, unchanged nutrient metadata, failed meal lookup, and failed cleanup count.
- `git diff --check`: passed.
- TypeScript comparison against HEAD using the same installed dependencies: 272 distinct diagnostics before and after, no added diagnostics. The repository-wide type check remains blocked by existing unrelated errors; changed food files have no diagnostics.

Saving uses one entry update for nutrition and meal assignment, requires a returned row before reporting success, and keeps a failed draft available for retry. Saved entries scale their logged snapshot, preserving manual corrections rather than replacing them with current catalog values. Extended nutrient snapshots are marked unknown after nutrition corrections because those fields were not edited in this form. No schema migration is needed.
