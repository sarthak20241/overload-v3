// The body of the signed-in onboarding program request to ai-coach.
//
// Its own file with no imports so the server's tests can read it: ai-coach
// counts this request as the free account's one goal plan build only when it
// has no `mode` and forces generate_program (freeGoalTurnKind). A mode added
// here would send free users to the paywall and, quietly, to the phone-made
// plan. supabase/functions/ai-coach/freeGoalBuild.test.ts checks it.
export function onboardingProgramRequestBody(message: string) {
  return {
    messages: [{ role: 'user' as const, content: message }],
    force_tool: 'generate_program' as const,
  };
}
