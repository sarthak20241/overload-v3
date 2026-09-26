'use client';
import type { Brief, Channel, Draft, Playbook, Topic } from './types';

export interface StudioState {
  brief: Brief;
  playbooks: Partial<Record<Channel, Playbook>>;
  topics: Topic[];
  drafts: Draft[];
  recentWork: string[];
  jobs: { id: string; kind: string; key: string; label: string }[];
  status: {
    provider: 'claude' | 'codex';
    fallback: boolean;
    model: string;
    codexBin: string;
    codexLoggedIn: boolean;
    repo: string;
    x: boolean;
    xCommunity: boolean;
    linkedin: boolean;
    linkedinConnected: boolean;
    linkedinName?: string;
    linkedinExpiresAt?: number;
  };
}

export interface JobView {
  id: string;
  key?: string;
  kind: string;
  label: string;
  status: 'running' | 'done' | 'error';
  progress: string[];
  result?: any;
  error?: string;
  startedAt: number;
}

export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
  return json as T;
}

export const CHANNEL_NAME: Record<Channel, string> = { x: 'X', linkedin: 'LinkedIn', reddit: 'Reddit' };

export function ago(iso?: string | number): string {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
