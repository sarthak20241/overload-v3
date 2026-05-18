/**
 * Haiku 4.5 distillation via Anthropic tool-use. Takes a paper (title +
 * abstract + minimal metadata) and emits the structured fields that go
 * straight into research_kb_pending.
 *
 * Tool-use (rather than "respond in JSON") gives us:
 *   - Constrained decoding → output ALWAYS matches the schema
 *   - No markdown-wrapped JSON to strip
 *   - Cheaper than asking the model to write its own JSON
 *
 * We use Haiku 4.5 (not Sonnet) because distillation is structured pattern-
 * extraction — Haiku handles it well at ~10× lower cost than Sonnet.
 */
import { ANTHROPIC_API_KEY } from './env.js';
import type { Distillation, Paper } from './types.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 1024;

const DISTILL_TOOL = {
  name: 'submit_distillation',
  description:
    'Emit the structured fields for this research paper. Be specific and grounded in the abstract — do not generalize. If a field is unknown from the abstract, give your best inference from the title and topic.',
  input_schema: {
    type: 'object' as const,
    properties: {
      population: {
        type: 'string',
        description:
          'One-line description of the study subjects. Examples: "Trained male lifters (n=43, avg 4 yrs training)", "Untrained adults (n=120, both sexes)", "N/A (review)". Be specific where the abstract is specific.',
      },
      intervention: {
        type: 'string',
        description:
          'One-line description of what was manipulated/compared. Examples: "Low (5 RIR) vs. high (0-1 RIR) proximity to failure", "20 vs. 30 sets/week for chest", "8 weeks of fasted vs. fed resistance training". For reviews/meta-analyses, describe what they synthesized.',
      },
      key_finding: {
        type: 'string',
        description:
          'The headline result in 1-2 plain sentences. Cite numbers when available. Avoid weasel words. Examples: "No significant difference in muscle thickness between RIR 3 and RIR 0 groups after 8 weeks (effect size d=0.12).", "Volume above MAV (22+ sets/week) showed diminishing returns; 16-20 was the sweet spot."',
      },
      practical_takeaway: {
        type: 'string',
        description:
          '1-2 sentences that a coach could deliver to a trainee. Translate the finding into action. Examples: "You don\'t need to grind every set to failure — staying within 2-3 RIR delivers equivalent hypertrophy with better recovery.", "If you\'re already doing 16-20 sets/week per muscle, adding more probably won\'t help."',
      },
      study_design: {
        type: 'string',
        enum: ['meta-analysis', 'systematic-review', 'RCT', 'crossover', 'cohort', 'observational', 'narrative-review', 'preprint', 'other'],
        description: 'The most specific category that fits.',
      },
      confidence: {
        type: 'string',
        enum: ['replicated', 'single-study', 'established', 'preliminary'],
        description:
          '"replicated" = meta-analysis or systematic review of multiple RCTs. "single-study" = one RCT or one cohort. "established" = widely accepted (textbook). "preliminary" = preprint or pilot.',
      },
      topic_tags: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Lowercase, kebab-case topic tags. Use 3-6 tags. Pick from common terms like: hypertrophy, strength, volume, frequency, rep-range, rir, proximity-to-failure, fat-loss, protein, sleep, recovery, deload, periodization, conditioning, vo2max, zone-2, beginners, intermediates, advanced, female-lifters, older-adults, injury-prevention. Add specific tags for major exercises if relevant (e.g. squat, bench, deadlift).',
      },
      hyde_questions: {
        type: 'array',
        items: { type: 'string' },
        description:
          '2-3 short, natural-language questions a lifter might ask their coach that THIS paper would answer. Used for query-mode retrieval matching. Examples: "do I need to train to failure for hypertrophy?", "how much volume per muscle group per week?". Casual gym-speak, not formal-language.',
      },
    },
    required: [
      'population', 'intervention', 'key_finding', 'practical_takeaway',
      'study_design', 'confidence', 'topic_tags', 'hyde_questions',
    ],
  },
};

const SYSTEM_PROMPT = `You are a research distillation assistant for a strength and hypertrophy training app. You read peer-reviewed exercise-science papers and extract structured summary fields. Your output goes into a vector knowledge base that an AI coach retrieves from at inference time.

Style:
- Specific over general. If the paper says "n=43 trained male lifters", say so. Don't say "some lifters".
- Numbers when present. Effect sizes, sample sizes, durations.
- Plain language in practical_takeaway. Coaches talk to humans, not journals.
- No spin. If the finding is null, say so.`;

export async function distill(paper: Paper): Promise<Distillation> {
  const userMessage = `Title: ${paper.title}
Authors: ${paper.authors.join(', ')}
Journal: ${paper.journal ?? 'unknown'}
Year: ${paper.pub_year ?? 'unknown'}

Abstract:
${paper.abstract}

Extract the structured fields via submit_distillation.`;

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: [DISTILL_TOOL],
      tool_choice: { type: 'tool', name: 'submit_distillation' },
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  const toolUse = (body.content as any[]).find((b) => b.type === 'tool_use');
  if (!toolUse) {
    throw new Error('Haiku did not emit submit_distillation tool_use block');
  }
  return toolUse.input as Distillation;
}
