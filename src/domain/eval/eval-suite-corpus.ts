/** The feature cases and the corpus assembled from the fixtures. */

import { DAG_LEVEL, EXTRACTED_TAG, Layer, type MemoryEntry } from '../../base/memory/entry.js';
import {
  authMeetingEntries,
  dateOffset,
  directRecallEntries,
  infrastructureMeetingEntries,
  mem,
  monitoringMeetingEntries,
  multiHopEntries,
} from './eval-suite-fixtures.js';

export type FeatureCategory =
  | 'direct-recall'
  | 'extraction-preference'
  | 'dag-drilldown'
  | 'temporal'
  | 'noise-resistance'
  | 'multi-hop';

export interface FeatureTestCase {
  id: string;
  category: FeatureCategory;
  query: string;
  expectedIds: string[];
  description: string;
}

function directRecallCase(n: number, query: string, description: string): FeatureTestCase {
  return {
    id: `dr-q${n}`,
    category: 'direct-recall',
    query,
    expectedIds: [`dr-${n}`],
    description,
  };
}

function directRecallCases(): FeatureTestCase[] {
  return [
    directRecallCase(
      1,
      'PostgreSQL migration NOT NULL constraint',
      'exact keyword match on DB migration',
    ),
    directRecallCase(2, 'React useMemo performance memoizing', 'React performance optimization'),
    directRecallCase(3, 'sliding window rate limiter API', 'API rate limiting approach'),
    directRecallCase(4, 'Docker OOM memory limits worker', 'Docker memory config'),
    directRecallCase(5, 'JWT token expiration security', 'JWT security setting'),
    directRecallCase(6, 'webpack bundle size lodash', 'bundle size issue'),
    directRecallCase(7, 'Redis cache TTL session expiration', 'cache TTL config'),
    directRecallCase(8, 'GraphQL N+1 DataLoader batching', 'GraphQL N+1 fix'),
  ];
}

function addDirectRecall(entries: MemoryEntry[], cases: FeatureTestCase[], now: Date): void {
  entries.push(...directRecallEntries(now));
  cases.push(...directRecallCases());
}

/** Extraction preference: extracted facts should rank above raw source. */
function extractionPreferenceEntries(now: Date): MemoryEntry[] {
  return [
    ...infrastructureMeetingEntries(now),
    ...monitoringMeetingEntries(now),
    ...authMeetingEntries(now),
  ];
}

function extractionPreferenceCases(): FeatureTestCase[] {
  return [
    {
      id: 'ep-q1',
      category: 'extraction-preference',
      query: 'Kubernetes upgrade staging environment',
      expectedIds: ['ep-ext-1'],
      description: 'extracted fact about K8s upgrade should rank above raw utterance',
    },
    {
      id: 'ep-q2',
      category: 'extraction-preference',
      query: 'Datadog Grafana alerting migration',
      expectedIds: ['ep-ext-2'],
      description: 'extracted fact about monitoring switch',
    },
    {
      id: 'ep-q3',
      category: 'extraction-preference',
      query: 'OAuth2 PKCE login page redesign',
      expectedIds: ['ep-ext-3'],
      description: 'extracted fact about auth work',
    },
  ];
}

function addExtractionPreference(
  entries: MemoryEntry[],
  cases: FeatureTestCase[],
  now: Date,
): void {
  entries.push(...extractionPreferenceEntries(now));
  cases.push(...extractionPreferenceCases());
}

/** Dag drill-down: summary nodes should surface children. */
function dagChildEntries(now: Date): MemoryEntry[] {
  return [
    mem(
      now,
      'dag-child-1',
      'The API response time for /users endpoint degraded from 50ms to 300ms after adding the permissions check',
      {
        created: dateOffset(15),
        layer: Layer.Semantic,
        tags: ['topic:api-performance', EXTRACTED_TAG],
        dagLevel: DAG_LEVEL.extracted,
      },
    ),
    mem(
      now,
      'dag-child-2',
      'The /orders endpoint latency spiked to 500ms because of a missing index on the orders.created_at column',
      {
        created: dateOffset(15),
        layer: Layer.Semantic,
        tags: ['topic:api-performance', EXTRACTED_TAG],
        dagLevel: DAG_LEVEL.extracted,
      },
    ),
    mem(
      now,
      'dag-child-3',
      'Batch API endpoint /reports/generate takes 8 seconds because it runs synchronously instead of using a job queue',
      {
        created: dateOffset(15),
        layer: Layer.Semantic,
        tags: ['topic:api-performance', EXTRACTED_TAG],
        dagLevel: DAG_LEVEL.extracted,
      },
    ),
  ];
}

function dagSummaryEntry(now: Date): MemoryEntry {
  return mem(
    now,
    'dag-summary-1',
    'API performance issues: /users degraded to 300ms (permissions check), /orders spiked to 500ms (missing index), ' +
      '/reports takes 8s (needs job queue)',
    {
      created: dateOffset(16),
      layer: Layer.Semantic,
      tags: ['topic:api-performance'],
      dagLevel: DAG_LEVEL.topic,
      dagParentId: undefined,
    },
  );
}

function dagEntries(now: Date): MemoryEntry[] {
  const children = dagChildEntries(now);
  const summary = dagSummaryEntry(now);
  for (const child of children) child.dagParentId = summary.id;
  return [...children, summary];
}

function dagCases(): FeatureTestCase[] {
  return [
    {
      id: 'dag-q1',
      category: 'dag-drilldown',
      query: 'API performance problems latency',
      expectedIds: ['dag-child-1', 'dag-child-2', 'dag-child-3', 'dag-summary-1'],
      description: 'summary should drill down to all children',
    },
    {
      id: 'dag-q2',
      category: 'dag-drilldown',
      query: 'endpoint response time degradation',
      expectedIds: ['dag-child-1', 'dag-child-2', 'dag-summary-1'],
      description: 'query matching summary should surface relevant children',
    },
  ];
}

function addDagDrilldown(entries: MemoryEntry[], cases: FeatureTestCase[], now: Date): void {
  entries.push(...dagEntries(now));
  cases.push(...dagCases());
}

/** Temporal: recency/oldest cues should affect ranking. */
function temporalEntries(now: Date): MemoryEntry[] {
  return [
    mem(now, 'tmp-1', 'The team decided to use TypeScript for the new service', {
      created: dateOffset(-30),
      tags: ['topic:architecture'],
    }),
    mem(now, 'tmp-2', 'The team evaluated Rust as an alternative language for the service', {
      created: dateOffset(-20),
      tags: ['topic:architecture'],
    }),
    mem(now, 'tmp-3', 'The team added Go as a candidate language for the service rewrite', {
      created: dateOffset(-10),
      tags: ['topic:architecture'],
    }),
    mem(now, 'tmp-4', 'The team finalized the language choice as Go for the service rewrite', {
      created: dateOffset(-1),
      tags: ['topic:architecture'],
    }),
  ];
}

function temporalCases(): FeatureTestCase[] {
  return [
    {
      id: 'tmp-q1',
      category: 'temporal',
      query: 'what did the team recently decide about the service language',
      expectedIds: ['tmp-4'],
      description: 'recent cue should boost newest entry',
    },
    {
      id: 'tmp-q2',
      category: 'temporal',
      query: 'what was the first language choice for the service',
      expectedIds: ['tmp-1'],
      description: 'oldest cue should boost earliest entry',
    },
    {
      id: 'tmp-q3',
      category: 'temporal',
      query: 'latest update on the service rewrite language',
      expectedIds: ['tmp-4'],
      description: 'latest should boost most recent',
    },
    {
      id: 'tmp-q4',
      category: 'temporal',
      query: 'original architecture decision for the service',
      expectedIds: ['tmp-1'],
      description: 'original should boost earliest',
    },
  ];
}

function addTemporal(entries: MemoryEntry[], cases: FeatureTestCase[], now: Date): void {
  entries.push(...temporalEntries(now));
  cases.push(...temporalCases());
}

// Noise resistance: relevant memories must be found despite these.
const NOISE_TOPICS = [
  'breakfast meeting catering ordered sandwiches',
  'office temperature thermostat adjusted',
  'printer paper refill third floor supply',
  'parking lot gate code changed 4521',
  'fire drill scheduled next Thursday morning',
  'coffee machine broken maintenance called',
  'desk booking system new policy hybrid',
  'meeting room projector HDMI adapter missing',
  'birthday celebration for Dave next Friday',
  'recycling bins moved to kitchen area',
  'badge access updated for new hires',
  'elevator maintenance scheduled weekend',
  'lunch order from Italian place confirmed',
  'desk plants watering schedule posted',
  'air conditioning unit serviced last week',
  'office carpet cleaning Friday evening',
  'new microwave installed in kitchen',
  'visitor parking available spots three',
  'holiday schedule posted on intranet',
  'team photo session Thursday afternoon',
  'chair ergonomics assessment signup sheet',
  'standing desk adjustment instructions',
  'kitchen fridge cleanup policy reminder',
  'window blinds replaced on south side',
  'bicycle rack installed in parking garage',
  'team lunch budget increased quarterly',
  'noise canceling headphones approved expense',
  'monitor arm request form updated',
  'desk drawer key replacement procedure',
  'building security hours extended',
];

function noiseEntries(now: Date): MemoryEntry[] {
  return NOISE_TOPICS.map((topic, i) =>
    mem(now, `noise-${i}`, topic, { created: dateOffset(i), tags: ['topic:office'] }),
  );
}

function noiseTargetEntries(now: Date): MemoryEntry[] {
  return [
    mem(
      now,
      'nr-1',
      'The database connection pool was exhausted because max_connections was set to 10 but the application had 25 ' +
        'concurrent requests',
      {
        created: dateOffset(20),
        tags: ['topic:database', 'topic:performance'],
      },
    ),
    mem(
      now,
      'nr-2',
      'The S3 bucket policy was misconfigured allowing public read access to customer data uploads',
      {
        created: dateOffset(21),
        tags: ['topic:security', 'topic:s3'],
      },
    ),
  ];
}

function noiseCases(): FeatureTestCase[] {
  return [
    {
      id: 'nr-q1',
      category: 'noise-resistance',
      query: 'database connection pool exhausted max connections',
      expectedIds: ['nr-1'],
      description: 'find DB issue despite 30 noise entries',
    },
    {
      id: 'nr-q2',
      category: 'noise-resistance',
      query: 'S3 bucket public access security misconfiguration',
      expectedIds: ['nr-2'],
      description: 'find S3 issue despite noise',
    },
    {
      id: 'nr-q3',
      category: 'noise-resistance',
      query: 'PostgreSQL migration constraint',
      expectedIds: ['dr-1'],
      description: 'find earlier DB entry despite noise',
    },
    {
      id: 'nr-q4',
      category: 'noise-resistance',
      query: 'JWT token security expiration',
      expectedIds: ['dr-5'],
      description: 'find security entry despite noise',
    },
  ];
}

function addNoiseResistance(entries: MemoryEntry[], cases: FeatureTestCase[], now: Date): void {
  entries.push(...noiseEntries(now), ...noiseTargetEntries(now));
  cases.push(...noiseCases());
}

function multiHopCases(): FeatureTestCase[] {
  return [
    {
      id: 'mh-q1',
      category: 'multi-hop',
      query: 'Who fixed the Stripe webhook bug and what was the root cause?',
      expectedIds: ['mh-1', 'mh-2', 'mh-3'],
      description: 'chain Alice -> Stripe -> Bob -> fix',
    },
    {
      id: 'mh-q2',
      category: 'multi-hop',
      query: 'What are all the payment-related issues the team discussed?',
      expectedIds: ['mh-1', 'mh-2', 'mh-3', 'mh-4'],
      description: 'find all payment topics across speakers',
    },
  ];
}

function addMultiHop(entries: MemoryEntry[], cases: FeatureTestCase[], now: Date): void {
  entries.push(...multiHopEntries(now));
  cases.push(...multiHopCases());
}

/** The synthetic corpus, every memory stamped at `now`. */
export function buildSyntheticCorpusAt(now: Date) {
  const entries: MemoryEntry[] = [];
  const cases: FeatureTestCase[] = [];

  addDirectRecall(entries, cases, now);
  addExtractionPreference(entries, cases, now);
  addDagDrilldown(entries, cases, now);
  addTemporal(entries, cases, now);
  addNoiseResistance(entries, cases, now);
  addMultiHop(entries, cases, now);
  return { entries, cases };
}
