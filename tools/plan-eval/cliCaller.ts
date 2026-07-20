/**
 * A TextCaller backed by `claude -p` instead of the Anthropic API.
 *
 * Exists because the API key can run out of credits while a Claude Code
 * subscription keeps working. Since generatePlan.ts takes its caller by
 * injection, swapping the transport costs nothing structural: the module under
 * test is byte-identical either way.
 *
 * FIDELITY — read before quoting any number produced through this path.
 *
 *   Accuracy      Fully valid. Same model, same prompts, same parsers, same
 *                 module. This is what the transport is FOR.
 *
 *   Latency       DO NOT USE. Not a constant offset, not a usable ratio.
 *                 Measured 2026-07-20 on onb-hypertrophy-3d-beginner:
 *                   skeleton   5.3s via API   ->  31.4s via CLI
 *                   run total 11.8s via API   ->  71.2s via CLI
 *                 ~6x, because the CLI runs its own agent loop around the
 *                 request: extra turns, no prompt caching (cache_read comes
 *                 back 0), and session setup per invocation. An earlier
 *                 version of this comment claimed "~650ms of startup", which
 *                 was wrong by an order of magnitude.
 *
 *   Token counts  Also unusable. `usage.output_tokens` came back 4477 for a
 *                 plan that costs ~800 via the API, because it aggregates the
 *                 CLI's internal turns. `modelUsage` shows haiku calls we
 *                 never asked for.
 *
 *   Coverage      `baseline` CANNOT run here: it needs forced tool_choice and
 *                 the CLI exposes no such flag. compact and fanout are text
 *                 output and run fine.
 *
 * In short: use `--provider cli` to answer "is the output correct", and the
 * API to answer "how long does it take".
 *
 * SANDBOX: the CLI reads its OAuth token from the login keychain, which a
 * sandboxed shell may see a stale copy of. Invoke eval runs that use this
 * transport with the sandbox disabled, or every call 401s on an expired token.
 */
import { spawn } from 'node:child_process';

export interface CliCallResult {
  text: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  /** Wall clock for the whole subprocess, including CLI startup. */
  total_ms: number;
  /** The CLI's own measure of time spent in the API. Prefer this for latency. */
  api_ms: number;
}

export const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';

/** Production `system` is an array of cache-annotated blocks; the CLI takes a
 *  single string. Flattening drops the cache breakpoints, which is exactly why
 *  cache_read comes back as 0. */
export function flattenSystem(system: unknown): string {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
    .filter(Boolean)
    .join('\n\n');
}

/** Messages are a single user turn in every plan-generation call we make. */
function flattenMessages(messages: { role: string; content: unknown }[]): string {
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n\n');
}

export async function callClaudeCli(args: {
  system: unknown;
  messages: { role: string; content: unknown }[];
  model?: string;
  timeoutMs?: number;
}): Promise<CliCallResult> {
  const started = Date.now();
  const argv = [
    '-p',
    '--output-format', 'json',
    // Without this the CLI may decide to read files or search the web, which
    // would both distort latency and let it "cheat" on catalog grounding.
    '--disallowedTools', '*',
    '--system-prompt', flattenSystem(args.system),
  ];
  if (args.model) argv.push('--model', args.model);

  return await new Promise<CliCallResult>((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude -p timed out after ${args.timeoutMs ?? 180000}ms`));
    }, args.timeoutMs ?? 180000);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      let parsed: any;
      try { parsed = JSON.parse(stdout); }
      catch { reject(new Error(`claude -p emitted non-JSON: ${stdout.slice(0, 200)}`)); return; }

      // An auth or API failure comes back as a SUCCESSFUL exit with
      // is_error:true, so checking the exit code alone silently turns a 401
      // into an empty plan.
      if (parsed.is_error) {
        reject(new Error(`claude -p error: ${String(parsed.result ?? 'unknown').slice(0, 200)}`));
        return;
      }

      const u = parsed.usage ?? {};
      resolve({
        text: String(parsed.result ?? ''),
        usage: {
          input_tokens: u.input_tokens ?? 0,
          output_tokens: u.output_tokens ?? 0,
          cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
        },
        total_ms: Date.now() - started,
        api_ms: parsed.duration_api_ms ?? (Date.now() - started),
      });
    });

    // A dead child (bad CLAUDE_BIN => ENOENT, or an early exit) leaves stdin
    // destroyed, and writing to it emits 'error' on the stream. With no
    // listener Node treats that as unhandled and takes the process down, so a
    // simple typo in CLAUDE_BIN would crash the whole eval run instead of
    // failing one case. Swallow it here; the real cause still surfaces through
    // the 'error'/'close' handlers above, which reject with the exit code and
    // stderr.
    child.stdin.on('error', () => { /* reported via 'error' / 'close' */ });
    child.stdin.write(flattenMessages(args.messages));
    child.stdin.end();
  });
}
