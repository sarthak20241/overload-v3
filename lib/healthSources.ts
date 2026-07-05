/**
 * The user-facing "connect your data" source catalog.
 *
 * We integrate with TWO hubs only: Apple HealthKit (iOS) and Android Health
 * Connect. Every app below feeds data THROUGH a hub, not via a direct vendor
 * integration. Naming an app here is a UI affordance over the hub so the user
 * sees recognizable brands ("works with Google Fit"), not a separate pipeline.
 *
 * Notably Google Fit's own API is closed to new apps (since 2024-05-01) and
 * shuts down end of 2026, so Google Fit is reached via Health Connect, never
 * directly. Samsung Health and Fitbit likewise sync into Health Connect.
 *
 * Drives the connect screen + marketing copy. Setup hints / icons are
 * provisional (revisit in the UI + icon polish pass). Plan:
 * .planning/holistic-tracking-plan.md (section 2, "Source apps").
 */
import type { MetricSource } from './dailyMetrics';

/** A platform hub a source's data flows through. Aligns with MetricSource. */
export type HealthHub = Extract<MetricSource, 'healthkit' | 'health_connect'>;

export interface HealthSourceDef {
  id: string;
  /** Brand name shown to the user. */
  name: string;
  /** Which hub(s) carry this source's data. */
  hubs: HealthHub[];
  /** Brand/Feather glyph (provisional). */
  icon: string;
  /** Short, plain setup hint for the connect screen (Drona voice, no em dashes). */
  setupHint: string;
  /** Notable coverage caveat the connect screen should surface honestly. */
  caveat?: string;
}

export const HEALTH_SOURCES: HealthSourceDef[] = [
  {
    id: 'apple_health', name: 'Apple Health', hubs: ['healthkit'], icon: 'heart',
    setupHint: 'On as soon as you let Overload read Apple Health.',
  },
  {
    id: 'apple_watch', name: 'Apple Watch', hubs: ['healthkit'], icon: 'watch',
    setupHint: 'Comes through Apple Health. Your best source for HRV and sleep stages.',
  },
  {
    id: 'google_fit', name: 'Google Fit', hubs: ['health_connect'], icon: 'activity',
    setupHint: 'Turn on Health Connect sync inside Google Fit, then connect Health Connect here.',
    caveat: 'Google Fit is winding down. Its data now flows through Health Connect.',
  },
  {
    id: 'samsung_health', name: 'Samsung Health', hubs: ['health_connect'], icon: 'smartphone',
    setupHint: 'In Samsung Health, open Settings then Health Connect and allow sharing.',
  },
  {
    id: 'fitbit', name: 'Fitbit', hubs: ['health_connect'], icon: 'activity',
    setupHint: 'Enable Health Connect in the Fitbit app, then connect Health Connect here.',
  },
  {
    id: 'garmin', name: 'Garmin', hubs: ['healthkit', 'health_connect'], icon: 'watch',
    setupHint: 'Comes through Apple Health or Health Connect. A strong source for HRV.',
  },
  {
    id: 'oura', name: 'Oura', hubs: ['healthkit', 'health_connect'], icon: 'circle',
    setupHint: 'Comes through Apple Health or Health Connect.',
    caveat: 'Sleep and resting heart rate flow through; its own readiness score does not.',
  },
  {
    id: 'whoop', name: 'Whoop', hubs: ['healthkit', 'health_connect'], icon: 'circle',
    setupHint: 'Comes through Apple Health or Health Connect.',
    caveat: 'Recovery, sleep and resting heart rate flow through; steps and SDNN HRV do not.',
  },
  {
    id: 'smart_scale', name: 'Smart scale', hubs: ['healthkit', 'health_connect'], icon: 'trending-up',
    setupHint: 'Withings, and similar scales write bodyweight through Apple Health or Health Connect.',
  },
];

/** Sources available on a given hub, for rendering the platform-appropriate list. */
export function sourcesForHub(hub: HealthHub): HealthSourceDef[] {
  return HEALTH_SOURCES.filter((s) => s.hubs.includes(hub));
}
