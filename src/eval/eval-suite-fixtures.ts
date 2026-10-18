/** Hand-written memories and builders for the synthetic feature corpus in eval-suite.ts. */

import { createMemory, Layer, type MemoryEntry } from '../core/memory.js';
import { DAY_MS } from '../util/time.js';

const BASE_DATE = new Date('2026-01-15T10:00:00Z');

export function dateOffset(days: number): string {
  const d = new Date(BASE_DATE.getTime() + days * DAY_MS);
  return d.toISOString();
}

export function mem(
  id: string,
  content: string,
  opts: {
    layer?: Layer;
    tags?: string[];
    created?: string;
    extractedFrom?: string;
    dagLevel?: number;
    dagParentId?: string;
  } = {},
): MemoryEntry {
  const entry = createMemory(content, {
    layer: opts.layer ?? Layer.Episodic,
    tags: opts.tags ?? [],
    baseHalfLifeDays: 30,
    extractedFrom: opts.extractedFrom,
    dagLevel: opts.dagLevel,
    dagParentId: opts.dagParentId,
  });
  entry.id = id;
  if (opts.created) entry.created = opts.created;
  return entry;
}

export function infrastructureMeetingEntries(): MemoryEntry[] {
  return [
    mem(
      'ep-src-1',
      'speaker:Alice: So we had this big meeting yesterday about the deployment pipeline and Bob mentioned that the ' +
        'staging environment is ' +
        'using Kubernetes 1.28 and we should upgrade to 1.30 before the end of Q2 because of the security patches',
      {
        created: dateOffset(10),
        tags: ['speaker:Alice', 'topic:infrastructure', 'session:meeting-1'],
      },
    ),
    mem(
      'ep-ext-1',
      'The staging environment runs Kubernetes 1.28 and needs to be upgraded to 1.30 before end of Q2 for security ' +
        'patches',
      {
        created: dateOffset(10),
        layer: Layer.Semantic,
        tags: ['speaker:Alice', 'topic:infrastructure', 'extracted'],
        extractedFrom: 'ep-src-1',
      },
    ),
  ];
}

export function monitoringMeetingEntries(): MemoryEntry[] {
  return [
    mem(
      'ep-src-2',
      'speaker:Bob: Yeah and the thing about the monitoring is that we switched from Datadog to Grafana last month ' +
        'and the alerting rules ' +
        'still need to be migrated, Carol was supposed to handle that but she has been busy with the frontend rewrite',
      {
        created: dateOffset(11),
        tags: ['speaker:Bob', 'topic:monitoring', 'session:meeting-1'],
      },
    ),
    mem(
      'ep-ext-2',
      'The team switched from Datadog to Grafana last month but alerting rules have not been migrated yet. Carol is ' +
        'responsible but blocked ' +
        'by the frontend rewrite.',
      {
        created: dateOffset(11),
        layer: Layer.Semantic,
        tags: ['speaker:Bob', 'topic:monitoring', 'extracted'],
        extractedFrom: 'ep-src-2',
      },
    ),
  ];
}

export function authMeetingEntries(): MemoryEntry[] {
  return [
    mem(
      'ep-src-3',
      'speaker:Carol: The login page redesign is almost done, I just need to wire up the OAuth2 PKCE flow with the ' +
        'new identity provider and ' +
        'write the integration tests',
      {
        created: dateOffset(12),
        tags: ['speaker:Carol', 'topic:auth', 'session:meeting-2'],
      },
    ),
    mem(
      'ep-ext-3',
      'Carol is nearly done with the login page redesign. Remaining work: wire up OAuth2 PKCE flow with the new ' +
        'identity provider and write ' +
        'integration tests.',
      {
        created: dateOffset(12),
        layer: Layer.Semantic,
        tags: ['speaker:Carol', 'topic:auth', 'extracted'],
        extractedFrom: 'ep-src-3',
      },
    ),
  ];
}

/** Multi-hop: entity chaining across sessions. */
export function multiHopEntries(): MemoryEntry[] {
  return [
    mem(
      'mh-1',
      'speaker:Alice works on the payment gateway integration with Stripe. She found a webhook signature validation ' +
        'bug.',
      {
        created: dateOffset(25),
        tags: ['speaker:Alice', 'topic:payments'],
      },
    ),
    mem(
      'mh-2',
      'speaker:Bob reviewed the Stripe webhook code and confirmed the signature validation uses the wrong secret key ' +
        'from the test environment.',
      {
        created: dateOffset(26),
        tags: ['speaker:Bob', 'topic:payments'],
      },
    ),
    mem(
      'mh-3',
      'speaker:Alice fixed the Stripe webhook by switching to the production secret key. Payment confirmations now ' +
        'arrive within 2 seconds.',
      {
        created: dateOffset(27),
        tags: ['speaker:Alice', 'topic:payments'],
      },
    ),
    mem(
      'mh-4',
      'speaker:Carol reported that the billing dashboard shows incorrect revenue numbers because it reads from the ' +
        'payments_raw table instead of ' +
        'payments_reconciled.',
      {
        created: dateOffset(28),
        tags: ['speaker:Carol', 'topic:billing'],
      },
    ),
  ];
}

function directRecallLateEntries(): MemoryEntry[] {
  return [
    mem(
      'dr-5',
      'The JWT token expiration was set to 24 hours but should be reduced to 1 hour for security compliance',
      {
        created: dateOffset(5),
        tags: ['topic:security'],
      },
    ),
    mem('dr-6', 'Webpack bundle size grew to 2.3MB because lodash was imported as a whole instead of cherry-picking', {
      created: dateOffset(6),
      tags: ['topic:frontend'],
    }),
    mem('dr-7', 'The Redis cache TTL for user sessions should match the JWT expiration to prevent stale sessions', {
      created: dateOffset(7),
      tags: ['topic:caching'],
    }),
    mem('dr-8', 'GraphQL resolver for nested comments has N+1 query problem solved by DataLoader batching', {
      created: dateOffset(8),
      tags: ['topic:api'],
    }),
  ];
}

/** Direct recall: basic keyword matching. */
export function directRecallEntries(): MemoryEntry[] {
  return [
    mem(
      'dr-1',
      'The PostgreSQL database migration failed because the users table had a NOT NULL constraint on the email column',
      {
        created: dateOffset(1),
        tags: ['topic:database'],
      },
    ),
    mem(
      'dr-2',
      'React component rendering performance improved by 40% after memoizing the expensive computation in useMemo',
      {
        created: dateOffset(2),
        tags: ['topic:frontend'],
      },
    ),
    mem(
      'dr-3',
      'The API rate limiter should use a sliding window algorithm instead of fixed window to prevent burst traffic',
      {
        created: dateOffset(3),
        tags: ['topic:api'],
      },
    ),
    mem('dr-4', 'Docker container memory limits need to be set to 512MB for the worker service to prevent OOM kills', {
      created: dateOffset(4),
      tags: ['topic:devops'],
    }),
    ...directRecallLateEntries(),
  ];
}
