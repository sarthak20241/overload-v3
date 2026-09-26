import { NextResponse } from 'next/server';
import { getBrief, recentWork, repoPath } from '@/lib/brief';
import { playbooks } from '@/lib/generate';
import { runningJobs } from '@/lib/jobs';
import { codexBin, codexLoggedIn, model, writerSettings } from '@/lib/llm';
import { linkedinConfigured, linkedinStatus } from '@/lib/publish/linkedin';
import { xConfigured } from '@/lib/publish/x';
import { read } from '@/lib/store';
import type { Draft, Topic } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const [brief, books, topics, drafts, li, work, writer] = await Promise.all([
    getBrief(), playbooks(), read<Topic[]>('topics', []), read<Draft[]>('drafts', []), linkedinStatus(), recentWork(), writerSettings(),
  ]);
  return NextResponse.json({
    brief, playbooks: books, topics, drafts, recentWork: work,
    jobs: runningJobs().map((j) => ({ id: j.id, kind: j.kind, label: j.label })),
    status: {
      provider: writer.provider, fallback: writer.fallback, model: model(writer.provider) ?? 'default',
      codexBin: codexBin(), codexLoggedIn: codexLoggedIn(), repo: repoPath(),
      x: xConfigured(), xCommunity: Boolean(process.env.X_COMMUNITY_ID),
      linkedin: linkedinConfigured(), linkedinConnected: li.connected, linkedinName: li.name, linkedinExpiresAt: li.expiresAt,
    },
  });
}
