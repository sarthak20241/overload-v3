/**
 * HyDE (Hypothetical Document Embeddings) on the write side.
 *
 * The traditional retrieval setup: embed the user's query at lookup time
 * and match against document embeddings. The asymmetric problem: a casual
 * gym-question ("do I need to train to failure?") looks lexically very
 * different from a formal abstract ("Effects of repetitions in reserve on
 * muscle hypertrophy: a meta-analytic review"). Cosine similarity between
 * those is often weak even when they're semantically perfect matches.
 *
 * HyDE-on-write fixes this by embedding a passage that ALSO contains
 * query-shaped restatements of what the paper answers. We get Haiku to emit
 * those during distillation (the hyde_questions field), and concatenate them
 * into the embedded passage. Now a user asking "do I need to fail?" matches
 * the literal "do I need to train to failure for hypertrophy?" question we
 * baked into the paper's embedding.
 */
import type { Distillation, Paper } from './types.js';

export function buildHydePassage(paper: Paper, dist: Distillation): string {
  return [
    paper.title,
    `Population: ${dist.population}`,
    `Intervention: ${dist.intervention}`,
    `Key finding: ${dist.key_finding}`,
    `Practical takeaway: ${dist.practical_takeaway}`,
    `Topics: ${dist.topic_tags.join(', ')}`,
    `Study design: ${dist.study_design}`,
    `Questions this paper answers:`,
    ...dist.hyde_questions.map((q) => `- ${q}`),
  ].join('\n\n');
}
