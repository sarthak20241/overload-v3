/**
 * What Drona asks Jev about a person's fortnight (.planning/drona-jev-plan.md).
 *
 * Jev (TypeSafe "System One") does not write text. It takes state plus named
 * typed questions and answers them all at once with calibrated probabilities.
 * Two kinds of question live here:
 *
 *   SIGNALS     "can we see X in this data?"  one yes/no each. These replace the
 *               guessed thresholds the rules used (135% of target, 1.2 kg...).
 *   WHICH_CARD  "which one card fits this fortnight?"  The POLICY is written
 *               into the question in plain English, as an ordered list of cases
 *               with a worked example per card (the owner's idea; an abstract
 *               "act / talk / request / hold" scored 10-20% confidence on
 *               everything, and this form scored 6/6).
 *
 * Every question is a small prompt and is only trusted after it separates known
 * weeks: scripts/drona-jev/eval.mts. The examples below use people and numbers
 * that appear in NO eval week, so the eval stays held-out.
 *
 * Pure: no imports. The worker and the eval both read this one file.
 */

/** Pinned. Thresholds are calibrated against ONE model; an alias would drift. */
export const JEV_MODEL = 'jev-1.13.0';
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';

export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string | string[]; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export const SIGNALS = {
  weight_is_flat: {
    type: 'noul',
    instructions: 'Has body weight stayed essentially flat over the fortnight? Use weigh_in_summary.trend_pct_of_body_weight_per_week.',
    criteria: {
      true: 'The trend is tiny: between about -0.15% and +0.15% of body weight per week.',
      false: 'Weight is clearly moving down or up, OR there are too few weigh-ins to say.',
    },
  },
  weight_falling_fast: {
    type: 'noul',
    instructions: 'Is body weight falling fast: about 1% of body weight per week or more?',
    criteria: { true: 'Falling about 1% per week or faster.', false: 'Falling slower than that, flat, rising, or unknown.' },
  },
  weight_rising_fast: {
    type: 'noul',
    instructions: 'Is body weight rising fast: about 0.5% of body weight per week or more?',
    criteria: { true: 'Rising about 0.5% per week or faster.', false: 'Rising slower than that, flat, falling, or unknown.' },
  },
  scale_is_jumpy: {
    type: 'noul',
    instructions: 'Do the weigh-ins swing wildly between neighbouring readings, so that no trend can be trusted? Use weigh_in_summary.typical_change_between_neighbouring_weigh_ins_kg.',
    criteria: {
      true: 'The typical change between neighbouring weigh-ins is around 0.8 kg or more.',
      false: 'The typical change is under about 0.6 kg. That is normal daily wobble, not jumpy.',
    },
  },
  few_weigh_ins: {
    type: 'noul',
    instructions: 'Are there too few weigh-ins in the fortnight to judge weight at all?',
    criteria: { true: 'Fewer than six weigh-ins in 14 days (see weigh_in_summary.count).', false: 'Six or more weigh-ins.' },
  },
  food_log_sparse: {
    type: 'noul',
    instructions: 'Is the food log too sparse to judge what this person eats?',
    criteria: { true: 'Fewer than nine days logged out of 14 (see food_summary.days_logged).', false: 'Nine or more days logged.' },
  },
  intake_near_target: {
    type: 'noul',
    instructions: 'On MOST logged days, is calorie intake close to the daily calorie target? Use food_summary.days_within_10pct_of_target against days_logged.',
    criteria: {
      true: 'Most logged days are within 10% of the target. A couple of outlier days do not change this.',
      false: 'Most logged days are well off the target, or almost nothing is logged.',
    },
  },
  has_far_over_days: {
    type: 'noul',
    instructions: 'Is at least one logged day FAR above the daily calorie target? Use food_summary.highest_day_pct_of_target.',
    criteria: {
      true: 'highest_day_pct_of_target is about 140 or higher.',
      false: 'highest_day_pct_of_target is under about 130, or nothing is logged.',
    },
  },
  protein_adequate: {
    type: 'noul',
    instructions: 'Is protein intake close to the daily protein target?',
    criteria: { true: 'food_summary.avg_protein_pct_of_target is about 85 or more.', false: 'It is under about 80, or nothing is logged.' },
  },
  user_undid_a_cut: {
    type: 'noul',
    instructions: 'Does calorie_target_changes show this person REVERSING a coach-made change by hand?',
    criteria: {
      true: 'A change made by the coach (chat or card) was later moved back by the user by hand.',
      false: 'No such reversal. A user changing their own number with no coach change before it does not count.',
    },
  },
  training_short_this_week: {
    type: 'noul',
    instructions: 'In the most recent week of training_by_week, did this person do half or less of the planned sessions?',
    criteria: { true: 'Done is half of planned, or less.', false: 'Done is more than half of planned.' },
  },
  training_short_for_weeks: {
    type: 'noul',
    instructions: 'Has this person been well short of their planned sessions for TWO OR MORE weeks running, ending with the most recent week?',
    criteria: {
      true: 'The most recent week AND the week before it are both at about 60% of planned or less.',
      false: 'Only the most recent week is short, or none are.',
    },
  },
  absence_is_explained: {
    type: 'noul',
    instructions: 'Do coach_notes give a reason with an end in sight for missed training or logging (travel, illness, injury, a busy stretch)?',
    criteria: { true: 'A note explains the gap and it is still current.', false: 'No note, or the notes do not explain the gap.' },
  },
} as const satisfies Record<string, JevQuestion>;

export const CARDS = [
  'talk_about_undone_change', 'talk_about_missed_training', 'offer_to_relay_week',
  'request_weigh_ins', 'request_more_food_logging', 'request_steadier_weigh_ins',
  'talk_about_high_days', 'talk_about_eating_over_target', 'propose_protein_fix',
  'propose_raise_calories', 'propose_lower_calories', 'hold',
] as const;
export type JevCard = typeof CARDS[number];

export const WHICH_CARD = {
  type: 'choice',
  instructions: [
    'You are a fitness coach choosing ONE card to show a person this week, from their last fortnight. The state holds their goal, daily targets, food log, weigh-ins, calorie target history, training by week, and any coach notes.',
    'Work DOWN this list and stop at the FIRST case that clearly applies:',
    '0. If coach_notes explain a current gap in training or logging (travel, illness, injury, a busy stretch with an end), choose hold. They told us already; do not ask again.',
    '1. If calorie_target_changes shows the person moving a coach-made calorie change back by hand, choose talk_about_undone_change.',
    '2. If the two most recent weeks in training_by_week BOTH have done_pct_of_planned at about 60 or less, choose talk_about_missed_training.',
    '3. If ONLY the most recent week has done_pct_of_planned at 50 or less, and the weeks before were on plan, choose offer_to_relay_week.',
    '4. If weigh_in_summary.count is under six and the goal involves body weight, choose request_weigh_ins. Six weigh-ins in a fortnight is the least a calorie decision may rest on.',
    '5. If food_summary.days_logged is under nine, choose request_more_food_logging, even when the logged days look fine. Fewer than nine days cannot speak for a fortnight.',
    '6. If weigh_in_summary.typical_change_between_neighbouring_weigh_ins_kg is around 0.8 or more, choose request_steadier_weigh_ins. Under about 0.6 is normal wobble and does NOT count.',
    '7. If food_summary.highest_day_pct_of_target is about 140 or more, while most days are within 10% of target, choose talk_about_high_days. A few very high days explain a stall better than the target does.',
    '8. If food_summary.avg_kcal_pct_of_target is about 115 or more and few days are within 10% of target, choose talk_about_eating_over_target. Lowering the number will not help someone who is not eating to it.',
    '9. If food_summary.avg_protein_pct_of_target is under about 85, choose propose_protein_fix.',
    '10. If the calorie target changed within the last 10 days, choose hold. It is too soon to judge it.',
    'Now judge the speed, using weigh_in_summary.trend_pct_of_body_weight_per_week. The right speed depends on the goal:',
    '11. FAT LOSS goal, trend at about -1.0% a week or faster: choose propose_raise_calories. That speed costs muscle.',
    '12. FAT LOSS goal, trend flat (between about -0.15% and +0.15%) with intake near target: choose propose_lower_calories.',
    '13. FAT LOSS goal, trend between about -0.2% and -0.9% a week: that is healthy progress. Choose hold.',
    '14. MUSCLE GAIN goal, trend at about +0.5% a week or faster: choose propose_lower_calories. That speed is mostly fat.',
    '15. MUSCLE GAIN goal, trend flat (between about -0.15% and +0.15%): choose propose_raise_calories.',
    '16. MUSCLE GAIN goal, trend between about +0.2% and +0.45% a week: that is healthy progress. Choose hold.',
    '17. MAINTAIN goal with a flat trend is success. Choose hold.',
    '18. Otherwise choose hold.',
  ],
  criteria: {
    talk_about_undone_change: 'The person reversed a coach-made calorie change themselves. Example: the coach set 2400 to 2250, then the person set 2250 back to 2400 by hand.',
    talk_about_missed_training: 'Well short of planned sessions for two or more weeks running. Example: planned 5 a week, did 2 and then 2.',
    offer_to_relay_week: 'One short week after weeks on plan. Example: planned 3, did 3, 3, 3, then 1.',
    request_weigh_ins: 'Too few weigh-ins to rest a decision on: under six in 14 days. Example: four weigh-ins with a weight-loss goal.',
    request_more_food_logging: 'Too few food days to judge: under nine of 14. Example: 7 days logged out of 14.',
    request_steadier_weigh_ins: 'Weigh-ins bounce too much to read. Example: 80.2, 81.9, 80.4, 81.7 on neighbouring days.',
    talk_about_high_days: 'Most days near target but one or more far above it. Example: target 1800, ten days near it, two days at 3000.',
    talk_about_eating_over_target: 'Eating well over the target on most days. Example: target 1800, most days between 2150 and 2300.',
    propose_protein_fix: 'Protein far under target. Example: target 140 g, logging 60 to 75 g.',
    propose_raise_calories: 'A cut running too fast, or a bulk that is not moving. Example: fat loss, 90 kg, down 1.1 kg a week for two weeks.',
    propose_lower_calories: 'An honest stall on a cut, or a bulk running too fast. Example: target 1800, days between 1750 and 1850, scale 81.0 to 81.3 kg for two weeks.',
    hold: 'On track, explained by a note, changed too recently, or nothing clear enough to act on. Example: fat loss, down 0.5 kg a week, food near target.',
  },
} as const satisfies JevQuestion;

export const JEV_QUESTIONS = { ...SIGNALS, which_card: WHICH_CARD };
export type SignalName = keyof typeof SIGNALS;
