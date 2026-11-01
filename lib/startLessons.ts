/**
 * The short lessons behind each getting-started step (lib/startGuide.ts):
 * two or three cards, each a moving picture of the real screen, a title and
 * one or two lines in Drona's voice. The last card's button opens the screen
 * where the step is done. Pure on purpose (no imports) so `deno test` reaches
 * it; the sheet lives in components/home/StartLessonSheet.tsx and the
 * pictures in components/home/LessonDemos.tsx.
 *
 * Copy rules (tested): no em dashes, a title fits one line, a body fits two.
 */

import type { StartStepId } from './startGuide';

/** Which moving picture a card shows. */
export type LessonDemo =
  | 'food_type'
  | 'food_result'
  | 'food_where'
  | 'modes_pick'
  | 'workout_today'
  | 'workout_sets'
  | 'workout_adjust'
  | 'phases_road'
  | 'weight_trend';

export interface LessonPage {
  demo: LessonDemo;
  title: string;
  body: string;
}

export interface Lesson {
  /** The button on the last card. */
  cta: string;
  pages: readonly LessonPage[];
}

export const LESSON_TITLE_MAX = 30;
export const LESSON_BODY_MAX = 110;

export const START_LESSONS: Record<StartStepId, Lesson> = {
  ai_food: {
    cta: 'Open the food box',
    pages: [
      { demo: 'food_type', title: 'Tell me what you ate', body: 'Type it the way you would say it. "2 eggs and toast" is enough.' },
      { demo: 'food_result', title: 'I work out the numbers', body: 'Calories and macros for each food. Change any amount before you save.' },
      { demo: 'food_where', title: 'Always one tap away', body: 'The food box sits on Nutrition. The log button on Home opens it too.' },
    ],
  },
  modes: {
    cta: 'Pick a mode',
    pages: [
      { demo: 'modes_pick', title: 'Three ways I log food', body: 'Quick is a fast estimate. Thorough checks our catalog. Precise is for packaged food.' },
    ],
  },
  workout: {
    cta: "Start today's workout",
    pages: [
      { demo: 'workout_today', title: "Today's session is ready", body: 'Your phase 1 plan picks it for you. It is the Today card at the top of Home.' },
      { demo: 'workout_sets', title: 'Tick off every set', body: 'Weight and reps, one tap each. Rough days count too.' },
      { demo: 'workout_adjust', title: 'I adjust as you go', body: 'I read your sets and tell you when it is time to add weight.' },
    ],
  },
  phases: {
    cta: 'See my phases',
    pages: [
      { demo: 'phases_road', title: 'Your program, in phases', body: 'Each phase has one job. Together they end at your goal.' },
    ],
  },
  weight: {
    cta: 'Log my weight',
    pages: [
      { demo: 'weight_trend', title: 'I read the trend, not the day', body: 'Weigh in a few mornings a week. One high reading means nothing. The trend tells me what to change.' },
    ],
  },
};
