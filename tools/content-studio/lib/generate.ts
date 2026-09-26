/**
 * The three model jobs: research a channel, suggest topics, write a post.
 * Each one builds its prompt from the same shared context, calls the CLI,
 * parses JSON, and saves the result.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { briefText, featuresDoc, getBrief, recentWork } from './brief';
import { SPECS } from './channels';
import { extractJson, runLLM } from './llm';
import { cleanDashes } from './lint';
import { id, read, update } from './store';
import type { Channel, Draft, Pillar, Playbook, Topic } from './types';
import { CHANNELS, PILLARS } from './types';

async function stickRules(): Promise<string> {
  return fs.readFile(path.join(process.cwd(), 'knowledge', 'made-to-stick.md'), 'utf8');
}

const WRITER_ROLE = `You are the content partner of a solo founder who builds Overload, a workout tracker with a coach called Drona, in public.
You think with the Made to Stick framework (Chip and Dan Heath) and you know how each social channel rewards content.
Hard rules for everything you write:
- Never use the em dash character or the en dash character. Use commas, colons, or a new sentence.
- Never invent facts, numbers, users, quotes or events. Use only what the brief, the product facts and the recent work say. If a post needs a real detail you do not have, write it as a bracketed placeholder like [your squat number] so the founder fills it in.
- Only describe features listed as live as if they exist. Anything else is "coming" or "building".
- Sound like a real person, not a brand and not an AI. No buzzwords like "game-changer", "revolutionize", "unlock", "elevate", "dive in", "journey" used as filler.
- Reply with JSON only when asked for JSON. No prose around it, no code fence.`;

async function context(): Promise<string> {
  const [brief, features, work] = await Promise.all([getBrief(), featuresDoc(), recentWork()]);
  return [
    '# The brief (written by the founder, highest authority)',
    briefText(brief),
    '# Product facts (FEATURES.md from the repo; the brief wins if they disagree)',
    features || '(not found)',
    '# Recent work (commit log from the last 3 weeks, newest first)',
    work.length ? work.map((w) => `- ${w}`).join('\n') : '(none)',
  ].join('\n\n');
}

function playbookText(p: Playbook | undefined): string {
  if (!p) return '(No research yet. Use your own up-to-date knowledge of this channel.)';
  return [
    `Summary: ${p.summary}`,
    `How distribution works: ${p.algorithm.join(' | ')}`,
    `Formats that work: ${p.formats.map((f) => `${f.name} (${f.why}; pattern: ${f.pattern})`).join(' | ')}`,
    `Hooks that work: ${p.hooks.join(' | ')}`,
    `Length: ${p.length}`,
    `Do: ${p.doList.join(' | ')}`,
    `Do not: ${p.dontList.join(' | ')}`,
    p.communities.length ? `Communities: ${p.communities.map((c) => `${c.name} (fit: ${c.fit}; rules: ${c.rules})`).join(' | ')}` : '',
    p.examples.length ? `Patterns seen in top posts: ${p.examples.map((e) => `${e.pattern} (${e.why})`).join(' | ')}` : '',
  ].filter(Boolean).join('\n');
}

export async function playbooks(): Promise<Partial<Record<Channel, Playbook>>> {
  return read('playbooks', {});
}

// ---------- Research ----------

const RESEARCH_FOCUS: Record<Channel, string> = {
  x: 'X (Twitter). Focus on build-in-public founders, indie app makers and fitness creators. Cover how the For You ranking treats replies, links, media, threads and communities in 2026, and what first lines stop the scroll.',
  linkedin: 'LinkedIn personal profiles. Focus on founder storytelling, product-building posts and health or fitness founders. Cover how the feed treats dwell time, "see more", comments, links, carousels and posting frequency in 2026.',
  reddit: 'Reddit. Focus on how solo developers share apps without getting banned, and on value posts in fitness communities. Cover self-promotion rules, what titles get upvoted, and the specific rules of these subreddits where you can find them: {SUBS}.',
};

export async function researchChannel(channel: Channel, log: (s: string) => void): Promise<Playbook> {
  const brief = await getBrief();
  const subs = brief.sections.find((s) => s.key === 'subreddits')?.text.split('\n').map((l) => l.split(':')[0].trim()).filter(Boolean).join(', ') ?? '';
  const focus = RESEARCH_FOCUS[channel].replace('{SUBS}', subs);
  log(`Researching ${SPECS[channel].name}. This takes 2 to 5 minutes.`);

  const system = `${WRITER_ROLE}

Right now you are a researcher. Use web search and page fetches to find CURRENT (last 12 months) evidence about what content performs. Prefer primary sources (platform docs and engineering posts), large studies of posts, and successful creators explaining what worked. Read at least 6 sources. Describe patterns in your own words; do not copy posts.`;

  const prompt = `Research this channel: ${focus}

The founder's product, for relevance:
${briefText(brief).slice(0, 2500)}

When you are done, reply with ONLY this JSON (no fence, no prose):
{
  "summary": "3 to 4 sentences: what wins on this channel right now and why",
  "algorithm": ["short facts about how distribution works now"],
  "formats": [{"name": "", "why": "", "pattern": "a reusable template in one line"}],
  "hooks": ["first-line patterns that work, as templates"],
  "length": "the length that performs best, with numbers",
  "doList": ["specific do's"],
  "dontList": ["specific don'ts, including what gets reach cut or accounts banned"],
  "cadence": "how often and when to post",
  "communities": [{"name": "", "fit": "why it fits Overload", "rules": "self-promo rules in short"}],
  "examples": [{"pattern": "what a top post in this niche did, described not copied", "why": "why it worked"}],
  "sources": [{"title": "", "url": ""}]
}
For X, communities means X Communities worth posting in. For LinkedIn it may be empty.`;

  const text = await runLLM({ system, prompt, web: true, onProgress: log, timeoutMs: 15 * 60_000 });
  const raw = extractJson<Omit<Playbook, 'channel' | 'updatedAt'>>(text);
  const playbook: Playbook = {
    channel,
    updatedAt: new Date().toISOString(),
    summary: cleanDashes(raw.summary ?? ''),
    algorithm: raw.algorithm ?? [],
    formats: raw.formats ?? [],
    hooks: raw.hooks ?? [],
    length: raw.length ?? '',
    doList: raw.doList ?? [],
    dontList: raw.dontList ?? [],
    cadence: raw.cadence ?? '',
    communities: raw.communities ?? [],
    examples: raw.examples ?? [],
    sources: raw.sources ?? [],
  };
  await update<Partial<Record<Channel, Playbook>>>('playbooks', {}, (cur) => ({ ...cur, [channel]: playbook }));
  log('Saved.');
  return playbook;
}

// ---------- Topics ----------

export async function suggestTopics(
  opts: { pillars: Pillar[]; count: number; steer?: string },
  log: (s: string) => void,
): Promise<Topic[]> {
  const [ctx, rules, books, existing] = await Promise.all([context(), stickRules(), playbooks(), read<Topic[]>('topics', [])]);
  const pillars = opts.pillars.length ? PILLARS.filter((p) => opts.pillars.includes(p.key)) : PILLARS;
  log(`Thinking up ${opts.count} topics.`);

  const system = `${WRITER_ROLE}\n\n# The Made to Stick rules you apply\n${rules}`;
  const prompt = `${ctx}

# What works on each channel (from research)
${CHANNELS.map((c) => `## ${SPECS[c].name}\n${playbookText(books[c])}`).join('\n\n')}

# Topics already suggested (do not repeat these ideas)
${existing.slice(-80).map((t) => `- ${t.title}`).join('\n') || '(none)'}

# Your task
Suggest ${opts.count} distinct post topics that would make lifters and builders care about Overload.
Spread them across these content pillars:
${pillars.map((p) => `- ${p.key}: ${p.label} (${p.hint})`).join('\n')}
${opts.steer ? `\nThe founder asks for this focus: ${opts.steer}\n` : ''}
For each topic, find the ONE core idea (commander's intent), then make it sticky. Prefer topics with a real, specific detail from the brief or the recent work. The "building" pillar should use the recent work log. At least one third of topics should give value even to someone who never uses the app.

Reply with ONLY a JSON array:
[{
  "title": "short working title",
  "pillar": "one of: ${pillars.map((p) => p.key).join(', ')}",
  "coreIdea": "the one sentence the reader must remember",
  "hook": "a first line that stops the scroll",
  "angle": "how the post unfolds, in 1 to 2 sentences",
  "stick": {"simple": "", "unexpected": "", "concrete": "", "credible": "", "emotional": "", "story": ""},
  "channels": ["x", "linkedin", "reddit" (only the ones it truly fits, best first)],
  "whyItWorks": "one sentence tying it to what works on the best channel"
}]
In "stick", say in a few words how the topic uses each principle, or leave it "" if it does not.`;

  const text = await runLLM({ system, prompt, onProgress: log, timeoutMs: 8 * 60_000 });
  const raw = extractJson<Partial<Topic>[]>(text);
  const now = new Date().toISOString();
  const topics: Topic[] = raw.map((t) => ({
    id: id('t'),
    title: cleanDashes(t.title ?? 'Untitled'),
    pillar: (PILLARS.some((p) => p.key === t.pillar) ? t.pillar : 'feature') as Pillar,
    coreIdea: cleanDashes(t.coreIdea ?? ''),
    hook: cleanDashes(t.hook ?? ''),
    angle: cleanDashes(t.angle ?? ''),
    stick: {
      simple: '', unexpected: '', concrete: '', credible: '', emotional: '', story: '',
      ...Object.fromEntries(Object.entries(t.stick ?? {}).map(([k, v]) => [k, cleanDashes(String(v ?? ''))])),
    },
    channels: (t.channels ?? []).filter((c): c is Channel => CHANNELS.includes(c as Channel)),
    whyItWorks: cleanDashes(t.whyItWorks ?? ''),
    status: 'new',
    createdAt: now,
  }));
  await update<Topic[]>('topics', [], (cur) => [...topics, ...cur]);
  log(`Saved ${topics.length} topics.`);
  return topics;
}

// ---------- Drafts ----------

interface DraftJson {
  title?: string;
  subreddit?: string;
  parts: string[];
  rationale: string;
  altHooks: string[];
  scores: Record<string, number>;
}

function draftContract(channel: Channel): string {
  const spec = SPECS[channel];
  const shape =
    channel === 'x'
      ? '"parts": ["post 1", "post 2 (only if a thread)", ...] (each at most 280 characters, a URL counts as 23)'
      : channel === 'linkedin'
        ? '"parts": ["the whole post, with \\n\\n between paragraphs"] (one entry, at most 3000 characters)'
        : '"subreddit": "r/Name", "title": "post title (at most 300 characters)", "parts": ["the whole body in markdown"] (one entry)';
  return `Reply with ONLY this JSON:
{
  ${shape},
  "rationale": "2 to 3 sentences: the core idea and why this version should work on ${spec.name}",
  "altHooks": ["3 other first lines the founder could swap in"],
  "scores": {"simple": 0-2, "unexpected": 0-2, "concrete": 0-2, "credible": 0-2, "emotional": 0-2, "story": 0-2}
}
Score honestly: 2 = done well, 1 = partly, 0 = missing.`;
}

async function writeWith(system: string, prompt: string, log: (s: string) => void): Promise<DraftJson> {
  const text = await runLLM({ system, prompt, onProgress: log, timeoutMs: 8 * 60_000 });
  const raw = extractJson<DraftJson>(text);
  return {
    ...raw,
    title: raw.title ? cleanDashes(raw.title) : undefined,
    parts: (raw.parts ?? []).map((p) => cleanDashes(String(p))).filter((p) => p.trim()),
    rationale: cleanDashes(raw.rationale ?? ''),
    altHooks: (raw.altHooks ?? []).map((h) => cleanDashes(String(h))),
    scores: raw.scores ?? {},
  };
}

async function draftSystem(channel: Channel): Promise<string> {
  const [rules, books] = await Promise.all([stickRules(), playbooks()]);
  const spec = SPECS[channel];
  return `${WRITER_ROLE}

# The Made to Stick rules you apply
${rules}

# ${spec.name}: hard format rules
${spec.rules}

# ${spec.name}: what works right now (research)
${playbookText(books[channel])}`;
}

export async function writeDraft(
  opts: { topicId: string; channel: Channel; steer?: string },
  log: (s: string) => void,
): Promise<Draft> {
  const topics = await read<Topic[]>('topics', []);
  const topic = topics.find((t) => t.id === opts.topicId);
  if (!topic) throw new Error('That topic no longer exists.');
  const spec = SPECS[opts.channel];
  log(`Writing a ${spec.name} post.`);

  const prompt = `${await context()}

# The topic
Title: ${topic.title}
Core idea: ${topic.coreIdea}
Suggested hook: ${topic.hook}
Angle: ${topic.angle}
Sticky angles: ${Object.entries(topic.stick).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('; ')}
${opts.steer ? `\nThe founder asks: ${opts.steer}\n` : ''}
# Your task
Write the best possible ${spec.name} post for this topic. Keep the core idea. Make it concrete and specific. Put the strongest line first.
${opts.channel === 'reddit' ? 'Pick the subreddit from the founder\'s list that fits best and follow its rules. If it bans promotion, do not mention the app at all.' : ''}

${draftContract(opts.channel)}`;

  const out = await writeWith(await draftSystem(opts.channel), prompt, log);
  const now = new Date().toISOString();
  const draft: Draft = {
    id: id('d'),
    topicId: topic.id,
    topicTitle: topic.title,
    channel: opts.channel,
    title: out.title,
    subreddit: out.subreddit,
    parts: out.parts,
    rationale: out.rationale,
    altHooks: out.altHooks,
    scores: out.scores,
    history: [],
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
  await update<Draft[]>('drafts', [], (cur) => [draft, ...cur]);
  await update<Topic[]>('topics', [], (cur) => cur.map((t) => (t.id === topic.id && t.status === 'new' ? { ...t, status: 'used' } : t)));
  log('Saved.');
  return draft;
}

export async function refineDraft(opts: { draftId: string; instruction: string }, log: (s: string) => void): Promise<Draft> {
  const drafts = await read<Draft[]>('drafts', []);
  const d = drafts.find((x) => x.id === opts.draftId);
  if (!d) throw new Error('That draft no longer exists.');
  log('Rewriting.');

  const prompt = `${await context()}

# The current ${SPECS[d.channel].name} draft
${d.subreddit ? `Subreddit: ${d.subreddit}\n` : ''}${d.title ? `Title: ${d.title}\n` : ''}${d.parts.map((p, i) => (d.parts.length > 1 ? `[${i + 1}] ${p}` : p)).join('\n\n')}

# What the founder wants changed
${opts.instruction}

Rewrite the draft to do exactly that. Keep everything else that works.

${draftContract(d.channel)}`;

  const out = await writeWith(await draftSystem(d.channel), prompt, log);
  const now = new Date().toISOString();
  let saved: Draft | undefined;
  await update<Draft[]>('drafts', [], (cur) =>
    cur.map((x) => {
      if (x.id !== d.id) return x;
      saved = {
        ...x,
        history: [{ title: x.title, subreddit: x.subreddit, parts: x.parts, at: x.updatedAt, note: opts.instruction }, ...x.history].slice(0, 20),
        title: out.title ?? x.title,
        subreddit: out.subreddit ?? x.subreddit,
        parts: out.parts.length ? out.parts : x.parts,
        rationale: out.rationale || x.rationale,
        altHooks: out.altHooks.length ? out.altHooks : x.altHooks,
        scores: Object.keys(out.scores).length ? out.scores : x.scores,
        updatedAt: now,
      };
      return saved;
    }),
  );
  log('Saved.');
  return saved!;
}
