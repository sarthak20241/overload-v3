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

export type AiApp = 'claude' | 'chatgpt';

export const AI_APPS: { id: AiApp; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'chatgpt', label: 'ChatGPT' },
];

export const CONNECT_STEPS: Record<AiApp, string[]> = {
  claude: [
    'On claude.ai, open Connectors from Customize or Plugins. A computer is easiest.',
    'Tap Add, then Add custom connector. Name it Overload and paste your link.',
    'Tap Connect, sign in with your Overload account, and tap Allow.',
  ],
  chatgpt: [
    'On chatgpt.com, open Settings, then Apps or Plugins. A computer is easiest.',
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
    { title: 'Copy your link', detail: 'mcp.tryoverload.app' },
    { title: 'Paste it in Claude', detail: 'Customize, Connectors, then Add. A computer is easiest.' },
    { title: 'Sign in and allow', detail: 'With your Overload account' },
  ],
  chatgpt: [
    { title: 'Copy your link', detail: 'mcp.tryoverload.app' },
    { title: 'Paste it in ChatGPT', detail: 'Plugins, then Add. A computer is easiest.' },
    { title: 'Sign in and allow', detail: 'With your Overload account' },
  ],
};

/** Where "Open ChatGPT" / "Open Claude" goes after the link is copied.
 *  Both checked in a browser 2026-11-14 (each page has an Add button). */
export const APP_SETTINGS_URL: Record<AiApp, string> = {
  claude: 'https://claude.ai/customize/connectors',
  chatgpt: 'https://chatgpt.com/plugins',
};

/** Things to try first. Each one uses a tool the connector has. */
export const TRY_ASKING = [
  'Log 2 eggs and toast for breakfast.',
  'How did my bench press move this month?',
  'Was I under my calories this week?',
  'Write my next leg day for this phase and save it as a routine.',
  'What has Drona noticed about my training this month?',
  'Add a deload week to the end of my plan.',
];
