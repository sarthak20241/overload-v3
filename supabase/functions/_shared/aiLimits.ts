// Existing rolling 24-hour allowances, shared by enforcement and app help.
// Changes to allowances must also update get_coach_access_status() in
// the database, which supplies the client meter. Extracting these constants
// does not change any allowance or authorization rule.
export const AI_LIMITS = {
  freeChat: 3,
  proChat: 30,
  freeFood: 3,
  proFood: 40,
} as const;
