# Known defects

## Active workout state can leak after removing the current exercise

When the user removes the currently open exercise and it is not the last item,
the next exercise slides into the same index. Weight and repetitions are
reseeded, but per-exercise state such as duration, RPE, unilateral-side state,
and rest overrides can remain from the removed exercise.

**Impact:** the next exercise may display or log stale values.

**Suggested fix:** reset or reseed all per-exercise state when the active
exercise identity changes, not only when its index changes.

**Status:** fixed on `claude/workout-exercise-state-leak-88b4e6`. The reset
effect now tracks the open exercise's id alongside its index and fires when
either moves, which is exactly the suggested fix. `reconcile` migrates that id
across the temp-to-real swap so an ad-hoc exercise resolving its row does not
read as the exercise changing.

## Unlogged weight and repetition drafts are not persisted

Typed weight and repetition values are kept in screen-local state. They are
lost if the screen remounts or the app recovers from a crash before the set is
logged. Logged sets restore normally.

**Impact:** users can lose uncommitted input.

**Status:** fixed in #98 (within a mount) and #100 (across a remount). #100
carries the drafts, the live inputs and the edit guard on the crash-recovery
snapshot, and flushes it synchronously on minimize so a fast reopen cannot read
a pre-edit snapshot.

## Non-weight exercise drafts are lost when switching exercises

Duration, distance, and resistance inputs are reset when switching exercises
and are not restored on return.

**Impact:** users can lose unlogged cardio or timed-exercise input.

**Status:** fixed on `claude/workout-exercise-state-leak-88b4e6`. Worth noting
the report was half right: duration was reset and lost as described, but
distance and resistance were never reset at all, so they bled the previous
exercise's value onto the next one. All three are now banked per exercise,
cleared on the way out, and handed back on return.
