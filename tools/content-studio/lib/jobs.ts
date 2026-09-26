/**
 * Long model calls (research can take minutes) run as background jobs.
 * The browser starts one, then polls /api/jobs/:id. Jobs live in memory on
 * globalThis so a dev-server hot reload does not lose them. Each job saves its
 * own result to the store, so a lost job never loses work.
 */
import { id } from './store';

export interface Job {
  id: string;
  kind: string;
  label: string;
  status: 'running' | 'done' | 'error';
  progress: string[];
  result?: unknown;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const jobs: Map<string, Job> = ((globalThis as any).__studioJobs ??= new Map());

export function startJob(kind: string, label: string, fn: (log: (s: string) => void) => Promise<unknown>): Job {
  const job: Job = { id: id('job'), kind, label, status: 'running', progress: [], startedAt: Date.now() };
  jobs.set(job.id, job);
  const log = (s: string) => {
    job.progress.push(s);
    if (job.progress.length > 60) job.progress.shift();
  };
  fn(log)
    .then((r) => { job.status = 'done'; job.result = r; })
    .catch((e) => { job.status = 'error'; job.error = e instanceof Error ? e.message : String(e); })
    .finally(() => { job.finishedAt = Date.now(); });
  return job;
}

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

export function runningJobs(): Job[] {
  return [...jobs.values()].filter((j) => j.status === 'running');
}
