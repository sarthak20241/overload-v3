/**
 * Runs a prompt through a subscription CLI instead of a paid API key.
 *
 *   claude  -> `claude -p` (your Claude Code login)
 *   codex   -> `codex exec` (your ChatGPT login)
 *
 * The CLI is spawned outside this repo, with MCP servers and settings files
 * switched off. Without that, one call loaded ~460k tokens of plugins, skills
 * and MCP tool lists before it read a word of our prompt.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { DATA_DIR, read } from './store';

export type Provider = 'claude' | 'codex';

export interface RunOpts {
  system: string;
  prompt: string;
  /** Allow web search + page fetch. Only the research step needs it. */
  web?: boolean;
  timeoutMs?: number;
  onProgress?: (line: string) => void;
}

export interface WriterSettings {
  provider: Provider;
  /** When the chosen subscription hits its usage limit, try the other one. */
  fallback: boolean;
}

export async function writerSettings(): Promise<WriterSettings> {
  const envDefault: Provider = process.env.LLM_PROVIDER === 'codex' ? 'codex' : 'claude';
  const saved = await read<Partial<WriterSettings>>('settings', {});
  return { provider: saved.provider ?? envDefault, fallback: saved.fallback ?? true };
}

export function model(p: Provider): string | undefined {
  if (p === 'claude') return process.env.CLAUDE_MODEL?.trim() || 'opus';
  return process.env.CODEX_MODEL?.trim() || undefined;
}

/**
 * The ChatGPT desktop app ships its own codex binary, and it is not on PATH.
 * Order: CODEX_BIN, then the app's copy, then whatever `codex` is on PATH.
 */
export function codexBin(): string {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex';
  return existsSync(bundled) ? bundled : 'codex';
}

export function codexLoggedIn(): boolean {
  return existsSync(path.join(homedir(), '.codex', 'auth.json'));
}

/** The parent may be a Claude Code session itself. Its auth vars would win
 *  over the subscription login, and its base URL rejects that login. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CODE_') || k === 'ANTHROPIC_API_KEY' || k === 'ANTHROPIC_AUTH_TOKEN' || k === 'ANTHROPIC_BASE_URL') {
      delete env[k];
    }
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

const LIMIT = /usage limit|rate limit|limit reached|hit your (usage )?limit|out of (extra )?usage|quota/i;

export async function runLLM(opts: RunOpts): Promise<string> {
  const { provider, fallback } = await writerSettings();
  const run = (p: Provider) => (p === 'codex' ? runCodex(opts) : runClaude(opts));
  try {
    return await run(provider);
  } catch (e) {
    const msg = (e as Error).message;
    if (!fallback || !LIMIT.test(msg)) throw e;
    const other: Provider = provider === 'claude' ? 'codex' : 'claude';
    opts.onProgress?.(`${NAME[provider]} hit its usage limit. Switching to ${NAME[other]}.`);
    try {
      return await run(other);
    } catch (e2) {
      throw new Error(`${NAME[provider]}: ${msg}\n${NAME[other]}: ${(e2 as Error).message}`);
    }
  }
}

const NAME: Record<Provider, string> = { claude: 'Claude', codex: 'ChatGPT' };

function runClaude(opts: RunOpts): Promise<string> {
  const tools = opts.web ? 'WebSearch,WebFetch' : '';
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--tools', tools,
    '--system-prompt', opts.system,
    '--max-turns', opts.web ? '40' : '2',
    // Anything not pre-approved is denied instead of waiting on a prompt
    // nobody will ever answer.
    '--permission-mode', 'dontAsk',
  ];
  if (opts.web) args.push('--allowedTools', tools);
  const m = model('claude');
  if (m) args.push('--model', m);

  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_BIN || 'claude', args, {
      cwd: tmpdir(),
      env: childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let stderr = '';
    let final: { result?: string; is_error?: boolean } | null = null;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Claude took longer than ${Math.round((opts.timeoutMs ?? 600000) / 1000)}s and was stopped.`));
    }, opts.timeoutMs ?? 600000);

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'assistant') {
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'tool_use') {
            const q = block.input?.query ?? block.input?.url ?? '';
            opts.onProgress?.(`${block.name === 'WebSearch' ? 'Searching' : 'Reading'}: ${String(q).slice(0, 120)}`);
          }
        }
      }
      if (ev.type === 'result') final = ev;
    };

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not start the claude CLI (${e.message}). Is Claude Code installed and logged in?`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      handleLine(buf);
      const f = final as { result?: string; is_error?: boolean } | null;
      // Auth and API failures exit 0 with is_error set, so the exit code
      // alone would turn a 401 into an empty answer.
      if (!f) return reject(new Error(`claude exited ${code} with no answer. ${stderr.slice(0, 300)}`));
      if (f.is_error) {
        const said = String(f.result ?? 'unknown error').slice(0, 300);
        const fix = /authenticate|oauth|log ?in/i.test(said) ? ' Run "claude auth login" in Terminal, or put a token from "claude setup-token" in CLAUDE_CODE_OAUTH_TOKEN in .env.local.' : '';
        return reject(new Error(`Claude said: ${said}${fix}`));
      }
      resolve(String(f.result ?? ''));
    });
    child.stdin.on('error', () => { /* surfaced via close */ });
    child.stdin.end(opts.prompt);
  });
}

/**
 * codex reads ~/.codex/config.toml, which loads every plugin, skill and MCP
 * server on each call. It gets its own home instead: just a link to your
 * ChatGPT login, nothing else.
 */
function codexHome(): string {
  const home = path.join(DATA_DIR, 'codex-home');
  mkdirSync(home, { recursive: true });
  const auth = path.join(home, 'auth.json');
  if (!existsSync(auth)) {
    try { symlinkSync(path.join(homedir(), '.codex', 'auth.json'), auth); } catch { /* reported by codex itself */ }
  }
  return home;
}

function runCodex(opts: RunOpts): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'studio-codex-'));
  const out = path.join(dir, 'last.txt');
  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--output-last-message', out];
  if (opts.web) args.push('-c', 'web_search="live"');
  const m = model('codex');
  if (m) args.push('--model', m);
  args.push('-');

  return new Promise((resolve, reject) => {
    const child = spawn(codexBin(), args, {
      cwd: dir,
      env: { ...process.env, CODEX_HOME: codexHome() },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('ChatGPT took too long and was stopped.'));
    }, opts.timeoutMs ?? 600000);
    // exec prints only the final message on stdout. Its stderr echoes the
    // whole prompt, so it is kept for errors and never shown as progress.
    opts.onProgress?.('ChatGPT is writing.');
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not start codex (${e.message}). Install the ChatGPT desktop app or: npm i -g @openai/codex`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const text = readFileSync(out, 'utf8');
        if (!text.trim()) throw new Error('empty');
        resolve(text);
      } catch {
        // codex prints its real reason (usage limit, not logged in) as an ERROR line.
        const clean = stderr.replace(/\x1b\[[0-9;]*m/g, '');
        const reason = clean.split('\n').reverse().find((l) => l.startsWith('ERROR:'))?.slice(6).trim();
        reject(new Error(reason ? `ChatGPT said: ${reason}` : `codex exited ${code} with no answer. ${stderr.slice(-300)}`));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    child.stdin.on('error', () => {});
    // codex has no separate system prompt flag, so the rules lead the prompt.
    child.stdin.end(`${opts.system}\n\n---\n\n${opts.prompt}`);
  });
}

/** Models wrap JSON in prose or fences now and then. Take the outermost object. */
export function extractJson<T = unknown>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.search(/[[{]/);
    if (start < 0) continue;
    const open = c[start];
    const close = open === '{' ? '}' : ']';
    const end = c.lastIndexOf(close);
    if (end <= start) continue;
    try { return JSON.parse(c.slice(start, end + 1)) as T; } catch { /* try next */ }
  }
  throw new Error(`The model did not return valid JSON. It said: ${text.slice(0, 200)}`);
}
