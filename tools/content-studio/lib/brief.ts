/**
 * The brief is what the model knows about Overload and about you.
 * It seeds itself once from what we already know, then it is yours to edit.
 * Two things are read live every time instead: FEATURES.md and recent commits.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { read } from './store';
import type { Brief } from './types';

const run = promisify(execFile);

export function repoPath(): string {
  return process.env.OVERLOAD_REPO?.trim() || path.resolve(process.cwd(), '..', '..');
}

export const DEFAULT_BRIEF: Brief = {
  updatedAt: new Date(0).toISOString(),
  sections: [
    {
      key: 'intent',
      label: "Commander's intent",
      hint: 'If people remember one thing about Overload, it is this.',
      text: 'Overload is a workout tracker with a coach that has seen every set you have ever logged, and tells you what to do next. You show up and do the work. Drona handles the thinking.',
    },
    {
      key: 'problem',
      label: 'The problem',
      hint: 'The pain, in the lifter\'s own words.',
      text: [
        'Most lifters guess. They repeat the same weights for months and do not know why they stopped growing.',
        'Tracker apps store numbers but never say what to do with them. A personal trainer costs $150 to $250 a month and sees you twice a week.',
        'Training, food and recovery live in three apps that never talk to each other.',
      ].join('\n'),
    },
    {
      key: 'audience',
      label: 'Who it is for',
      hint: 'One real person, not a demographic.',
      text: 'Intermediate lifters who care about progressive overload and want a trainer\'s guidance without the trainer\'s price. People who log their sets but are not sure the plan is working.',
    },
    {
      key: 'live',
      label: 'Live now',
      hint: 'Only things a user can do today. Never overclaim.',
      text: [
        'Fast workout logging that fills in last time\'s weights and reps, rest timers, automatic PR detection.',
        'Coach Drona: chat that knows your real numbers, builds a goal-driven multi-week program, adjusts it, and cites research.',
        'Nutrition tracking: type what you ate in plain words and it logs the macros.',
        'Progress charts, body weight and measurements, streaks, XP and levels.',
        'Weekly reports for Pro users. Free trial, then monthly, yearly, or a limited founding lifetime plan.',
        'Store status: iOS and Android. [Check this line and keep it true.]',
      ].join('\n'),
    },
    {
      key: 'building',
      label: 'Building now (your notes)',
      hint: 'What you are working on. Recent commits are added automatically.',
      text: 'Drona cards: every week the coach proposes one concrete change (calories, a swap, a deload) and explains why, and you say yes or no.',
    },
    {
      key: 'vision',
      label: 'Future vision',
      hint: 'Where this goes in 2 to 5 years.',
      text: 'One coach for your whole training life: lifting, food, sleep and recovery seen together. A coach that reaches out first, catches a plateau before you feel it, and walks every step of the journey with you.',
    },
    {
      key: 'founder',
      label: "Founder's story",
      hint: 'Add real moments. The model will never invent facts about you.',
      text: [
        'Sarthak, solo founder, building Overload in public.',
        'I built Overload for myself. I wanted one coach who handles the thinking: the plan, the macros, the calls on when to push and when to rest, so all I have to do is show up and do the work.',
        '[Add: how long you have lifted, the moment you got stuck, why you started building, a hard week, a user message that mattered.]',
      ].join('\n'),
    },
    {
      key: 'voice',
      label: 'Voice rules',
      hint: 'How every post must sound.',
      text: [
        'Human founder voice. Calm, direct, specific. No hype, no buzzwords.',
        'Never use em dashes. Use commas, colons or a new sentence.',
        'Overload is a workout tracker with a coach. Never call it an "AI coach app" and do not lead with "AI-powered".',
        'Lead with the benefit the lifter feels, not the tech.',
        'Only claim what is live. Label future things as coming.',
      ].join('\n'),
    },
    {
      key: 'links',
      label: 'Links and handles',
      hint: 'Where people should go.',
      text: 'Website: https://tryoverload.app\nX: @build_sarthak',
    },
    {
      key: 'subreddits',
      label: 'Subreddits',
      hint: 'One per line: name, then what is allowed there.',
      text: [
        'r/SideProject: sharing your project is welcome',
        'r/indiehackers: build lessons, numbers, honest updates',
        'r/iOSProgramming: technical lessons, app launches on Saturdays',
        'r/reactnative: technical lessons from building the app',
        'r/naturalbodybuilding: value only, no promotion',
        'r/GYM: value only, no promotion',
        'r/Fitness: value only, strict rules, no apps',
      ].join('\n'),
    },
  ],
};

export async function getBrief(): Promise<Brief> {
  const saved = await read<Brief | null>('brief', null);
  if (!saved) return DEFAULT_BRIEF;
  // Keep any section added to the defaults after the brief was first saved.
  const have = new Set(saved.sections.map((s) => s.key));
  return { ...saved, sections: [...saved.sections, ...DEFAULT_BRIEF.sections.filter((s) => !have.has(s.key))] };
}

export function briefText(brief: Brief): string {
  return brief.sections.map((s) => `## ${s.label}\n${s.text.trim()}`).join('\n\n');
}

export async function featuresDoc(): Promise<string> {
  try {
    const text = await fs.readFile(path.join(repoPath(), 'FEATURES.md'), 'utf8');
    // The research pipeline internals are for investors, not posts.
    return text.replace(/## 🔬 The Research Pipeline[\s\S]*?(?=\n## )/, '').slice(0, 9000);
  } catch {
    return '';
  }
}

/** Recent commit subjects on main, cleaned into plain notes. */
export async function recentWork(days = 21): Promise<string[]> {
  const repo = repoPath();
  for (const ref of ['origin/main', 'main', 'HEAD']) {
    try {
      const { stdout } = await run('git', ['-C', repo, 'log', ref, `--since=${days}.days`, '--no-merges', '--pretty=%ad %s', '--date=short'], { timeout: 5000 });
      return stdout
        .split('\n')
        .map((l) => l.replace(/\s*\[skip eas\]/gi, '').replace(/\s*\(#\d+\)/g, '').trim())
        .filter(Boolean)
        .slice(0, 60);
    } catch { /* try the next ref */ }
  }
  return [];
}
