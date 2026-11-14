/**
 * "Use Overload in ChatGPT or Claude": the link and the setup steps the
 * Connect screen (app/connect-ai.tsx) shows.
 *
 * The link is the MCP server (supabase/functions/mcp, through the Vercel
 * forwarder in mcp-proxy/). It is written into every sign-in token, so it
 * must remain stable once people connect.
 *
 * The steps follow what each app showed on 2026-11-10/11, when the connector
 * was first added to Claude.ai and ChatGPT (Plus). Re-check them when either
 * app moves its settings.
 */

export const MCP_URL = 'https://mcp.tryoverload.app';

/** The link without https://, as the step card shows it. */
export const MCP_HOST = MCP_URL.replace(/^https?:\/\//, '');

export type AiApp = 'claude' | 'chatgpt';

export const AI_APPS: { id: AiApp; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'chatgpt', label: 'ChatGPT' },
];

export const CONNECT_STEPS: Record<AiApp, string[]> = {
  claude: [
    'On claude.ai, open Customize, then Connectors.',
    'Tap Add, then Add custom connector. Name it Overload and paste your link.',
    'Tap Connect, sign in with your Overload account, and tap Allow.',
  ],
  chatgpt: [
    'On chatgpt.com, open Plugins (on some plans: Settings, then Apps).',
    'Add a custom app or MCP server named Overload. Paste the link and choose OAuth. If prompted, enable developer mode.',
    'Create the app, then choose Connect. Sign in with your Overload account and allow access.',
  ],
};

/**
 * The short version of CONNECT_STEPS, one card each on the Connect screen.
 * Step 1 is the Copy link button itself; the long steps above sit behind
 * "Full steps and what it can change".
 */
export const SHORT_STEPS: Record<AiApp, { title: string; detail: string }[]> = {
  claude: [
    { title: 'Copy your link', detail: MCP_HOST },
    { title: 'Paste it in Claude', detail: 'On claude.ai, open Customize, then Connectors. Tap Add and paste.' },
    { title: 'Sign in and allow', detail: 'With your Overload account' },
  ],
  chatgpt: [
    { title: 'Copy your link', detail: MCP_HOST },
    { title: 'Paste it in ChatGPT', detail: 'On chatgpt.com, open Plugins. Tap Add and paste.' },
    { title: 'Sign in and allow', detail: 'With your Overload account' },
  ],
};

/** Where "Open ChatGPT" / "Open Claude" goes after the link is copied.
 *  Both checked in a browser 2026-11-14 (each page has an Add button). */
export const APP_SETTINGS_URL: Record<AiApp, string> = {
  claude: 'https://claude.ai/customize/connectors',
  chatgpt: 'https://chatgpt.com/plugins',
};

export type StepMark = 'done' | 'next' | 'todo';

/**
 * How each of the three step cards looks. Step 1 is done only after a real
 * copy; a failed copy (the user copies the link by hand) still moves the
 * screen on to step 2. Opening the app moves it to step 3. With no plan, no
 * step is lit: the button sells the plan instead.
 */
export function stepMarks(s: { copied: boolean; copyFailed: boolean; opened: boolean; needsPlan: boolean }): StepMark[] {
  const current = s.opened ? 2 : s.copied || s.copyFailed ? 1 : 0;
  return [0, 1, 2].map((i) => {
    if (i < current) return i === 0 && !s.copied ? 'todo' : 'done';
    if (i === current && !s.needsPlan) return 'next';
    return 'todo';
  });
}

/** Things to try first. Each one uses a tool the connector has. */
export const TRY_ASKING = [
  'Log 2 eggs and toast for breakfast.',
  'How did my bench press move this month?',
  'Was I under my calories this week?',
  'Write my next leg day for this phase and save it as a routine.',
  'What has Drona noticed about my training this month?',
  'Add a deload week to the end of my plan.',
];
