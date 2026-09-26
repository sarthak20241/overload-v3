export type Channel = 'x' | 'linkedin' | 'reddit';
export const CHANNELS: Channel[] = ['x', 'linkedin', 'reddit'];

export type Pillar =
  | 'intent'
  | 'problem'
  | 'feature'
  | 'building'
  | 'vision'
  | 'founder'
  | 'lesson'
  | 'value';

export const PILLARS: { key: Pillar; label: string; hint: string }[] = [
  { key: 'intent', label: "Commander's intent", hint: 'The one big reason Overload exists' },
  { key: 'problem', label: 'The problem', hint: 'The pain lifters feel today' },
  { key: 'feature', label: 'A feature', hint: 'Something live you can show' },
  { key: 'building', label: 'Building now', hint: 'What shipped or is in progress this week' },
  { key: 'vision', label: 'Future vision', hint: 'Where Overload is going' },
  { key: 'founder', label: "Founder's story", hint: 'You, why you build this, the ups and downs' },
  { key: 'lesson', label: 'Build lesson', hint: 'Something you learned building it' },
  { key: 'value', label: 'Lifting value', hint: 'Useful training advice, no pitch' },
];

export interface BriefSection {
  key: string;
  label: string;
  hint: string;
  text: string;
}

export interface Brief {
  sections: BriefSection[];
  updatedAt: string;
}

export interface Playbook {
  channel: Channel;
  updatedAt: string;
  summary: string;
  algorithm: string[];
  formats: { name: string; why: string; pattern: string }[];
  hooks: string[];
  length: string;
  doList: string[];
  dontList: string[];
  cadence: string;
  communities: { name: string; fit: string; rules: string }[];
  examples: { pattern: string; why: string }[];
  sources: { title: string; url: string }[];
}

export interface StickCheck {
  simple: string;
  unexpected: string;
  concrete: string;
  credible: string;
  emotional: string;
  story: string;
}

export interface Topic {
  id: string;
  title: string;
  pillar: Pillar;
  coreIdea: string;
  hook: string;
  angle: string;
  stick: StickCheck;
  channels: Channel[];
  whyItWorks: string;
  status: 'new' | 'starred' | 'used' | 'archived';
  createdAt: string;
}

export interface DraftVersion {
  title?: string;
  subreddit?: string;
  parts: string[];
  at: string;
  note?: string;
}

export interface Draft {
  id: string;
  topicId: string;
  topicTitle: string;
  channel: Channel;
  title?: string;
  subreddit?: string;
  /** X: one entry per post in the thread. LinkedIn and Reddit: one entry. */
  parts: string[];
  rationale: string;
  altHooks: string[];
  scores: Partial<Record<keyof StickCheck, number>>;
  history: DraftVersion[];
  status: 'draft' | 'posted';
  postedUrl?: string;
  postedAt?: string;
  createdAt: string;
  updatedAt: string;
}
