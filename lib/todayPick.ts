// The TODAY pick rules live with the server function that runs them at each
// user's local midnight, so the app and the server can never disagree.
export * from '../supabase/functions/_shared/todayPick';
