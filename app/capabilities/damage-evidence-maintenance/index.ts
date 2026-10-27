import { join } from 'node:path';
import { z } from 'zod';
import type {
  ToolContext,
  TaskRuntimeExtensionHost,
  TaskRuntimeExtension,
} from '../../orchestration/ports.js';
import {
  TaskError,
  type TaskIdentity,
  type TaskRecord,
} from '../../contracts/tasks.js';
import { boundedJsonSchema } from '../../contracts/artifacts.js';
import { contractHash } from '../../contracts/json.js';
import {
  DamageEvidenceArchive,
  evidenceRequestKey,
  evidenceSha256,
} from '../damage-evidence/archive.js';
import type {
  AcquisitionRequest,
  EvidenceCapture,
} from '../damage-evidence/contracts.js';
import { evidencePeriodSchema } from '../damage-evidence/contracts.js';
import { damageEvidenceSource } from '../damage-evidence/registry.js';
import {
  acquireDamageEvidence,
  type AcquireDamageEvidenceOptions,
} from '../damage-evidence/acquisition.js';
import {
  createDamageEvidenceTools,
  damageEvidenceArchiveForIdentity,
} from '../damage-evidence/tools.js';
import { fetchTavilySearch } from '../../adapters/haze-sources/tavily.js';
import type {
  HazeOpsService,
  EvidenceWatcher,
} from '../../agents/hazeops/service.js';
import type { WatcherSpec } from '../evidence-collection/types.js';

type Subscription = {
  id: string;
  task_id: string;
  identity: TaskIdentity;
  request: AcquisitionRequest;
  capture_id: string;
};
type RevisionJob = {
  id: string;
  subscription: Subscription;
  capture_id: string;
  state: 'pending' | 'completed' | 'waiting' | 'superseded';
  attempts: number;
  error: string | null;
};
/** Numerical changes depend on selected values and support, never raw row order or HTTP metadata. */
export const damageEvidenceNumericalFingerprint = (
  capture: EvidenceCapture,
): string =>
  contractHash({
    source_id: capture.source_id,
    request_key: capture.request_key,
    evidence_origin: capture.evidence_origin,
    values: capture.normalized_values
      .map(
        ({
          input,
          value,
          unit,
          period,
          geography,
          strata,
          currency,
          price_year,
        }) => ({
          input,
          value,
          unit,
          period,
          geography,
          strata,
          currency,
          price_year,
        }),
      )
      .sort((a, b) => contractHash(a).localeCompare(contractHash(b))),
  });
const currentScope = (task: TaskRecord) =>
  task.corrections.length
    ? task.corrections.at(-1)!.scope
    : task.original_request.scope;
function accountOccurrencePeriod(task: TaskRecord) {
  const scope = currentScope(task);
  if (!scope || typeof scope !== 'object' || Array.isArray(scope))
    return undefined;
  const accountScope =
    'account_scope' in scope &&
    scope.account_scope &&
    typeof scope.account_scope === 'object' &&
    !Array.isArray(scope.account_scope)
      ? scope.account_scope
      : scope;
  const parsed = evidencePeriodSchema.safeParse(
    accountScope.occurrence_period ?? accountScope.effect_period,
  );
  return parsed.success ? parsed.data : undefined;
}
const coverage = (changed: boolean) => ({
  requested: 1,
  covered: 1,
  excluded: [],
  gaps: changed
    ? ['New evidence requires fresh scientific and arithmetic review.']
    : [],
});

/** Durable collection dependencies. New evidence corrects the task through its normal revision API. */
export class DamageEvidenceMaintenance {
  readonly archive: DamageEvidenceArchive;
  private scheduler: HazeOpsService | undefined;
  private readonly activeRefreshes = new Set<{
    request: AcquisitionRequest;
    identity: TaskIdentity;
    controller: AbortController;
  }>();
  constructor(
    private readonly host: TaskRuntimeExtensionHost,
    private readonly env: NodeJS.ProcessEnv = {},
  ) {
    this.archive = new DamageEvidenceArchive(
      join(host.store.directory, 'damage-evidence'),
    );
    host.store.db
      .exec(`CREATE TABLE IF NOT EXISTS damage_evidence_subscriptions(id TEXT PRIMARY KEY, mode TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS damage_evidence_revision_jobs(id TEXT PRIMARY KEY, mode TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS damage_evidence_news(id TEXT PRIMARY KEY, mode TEXT NOT NULL, body TEXT NOT NULL);`);
  }
  private subscriptions(): Subscription[] {
    return (
      this.host.store.db
        .prepare('SELECT body FROM damage_evidence_subscriptions WHERE mode=?')
        .all(this.host.mode) as { body: string }[]
    ).map((r) => JSON.parse(r.body) as Subscription);
  }
  private archiveFor(identity: TaskIdentity): DamageEvidenceArchive {
    return damageEvidenceArchiveForIdentity(this.archive.root, identity);
  }
  private matchingSubscriptions(
    request: AcquisitionRequest,
    identity: TaskIdentity,
  ): Subscription[] {
    return this.subscriptions().filter(
      (s) =>
        s.identity.principal === identity.principal &&
        s.identity.workspace === identity.workspace &&
        evidenceRequestKey(s.request) === evidenceRequestKey(request),
    );
  }
  private eligibility(subscription: Subscription): {
    task?: TaskRecord;
    reason: string | null;
  } {
    try {
      const task = this.host.readTask(
        subscription.task_id,
        subscription.identity,
      );
      if (['paused', 'cancelled', 'failed', 'timed_out'].includes(task.status))
        return {
          task,
          reason:
            'Task must be resumed before collecting or revising its evidence.',
        };
      if (!task.permissions.tools.includes('haze-damage-data-acquire'))
        return {
          task,
          reason: 'Numerical acquisition permission is revoked or unavailable.',
        };
      if (
        task.corrections.length &&
        task.corrections.at(-1)!.scope === undefined
      )
        return {
          task,
          reason:
            'The latest correction needs an explicit structured scope before collecting or revising evidence.',
        };
      const occurrence = accountOccurrencePeriod(task);
      if (
        occurrence &&
        (occurrence.start > subscription.request.selection.period.end ||
          occurrence.end < subscription.request.selection.period.start)
      )
        return {
          task,
          reason:
            'Subscription no longer overlaps the corrected account occurrence period.',
        };
      const scope = currentScope(task);
      if (scope && typeof scope === 'object' && !Array.isArray(scope)) {
        const accountScope =
          'account_scope' in scope &&
          scope.account_scope &&
          typeof scope.account_scope === 'object' &&
          !Array.isArray(scope.account_scope)
            ? scope.account_scope
            : scope;
        const geography = z
          .object({ level: z.string(), name: z.string() })
          .safeParse(accountScope.geography);
        if (geography.success) {
          const selectedName =
            geography.data.level === 'district'
              ? subscription.request.selection.district
              : geography.data.level === 'state'
                ? subscription.request.selection.state
                : undefined;
          if (
            selectedName &&
            selectedName.trim().toLocaleLowerCase() !==
              geography.data.name.trim().toLocaleLowerCase()
          )
            return {
              task,
              reason:
                'Subscription geography no longer matches the corrected account.',
            };
        }
      }
      return { task, reason: null };
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error) };
    }
  }
  /** Task controls fence active network work as well as queued numerical revisions. */
  reconcileActiveRefreshes(): void {
    for (const active of this.activeRefreshes)
      if (
        !this.matchingSubscriptions(active.request, active.identity).some(
          (s) => this.eligibility(s).reason === null,
        )
      )
        active.controller.abort(
          new Error(
            'All subscribing tasks are cancelled, paused, corrected or have revoked acquisition permission.',
          ),
        );
  }
  private saveJob(job: RevisionJob): void {
    this.host.store.db
      .prepare(
        'INSERT INTO damage_evidence_revision_jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(job.id, this.host.mode, JSON.stringify(job));
  }
  track(
    capture: EvidenceCapture,
    request: AcquisitionRequest,
    context: ToolContext,
  ): void {
    const subscription: Subscription = {
      id: contractHash({
        mode: this.host.mode,
        task: context.taskId,
        identity: context.identity,
        request_key: evidenceRequestKey(request),
      }),
      task_id: context.taskId,
      identity: context.identity,
      request,
      capture_id: capture.capture_id,
    };
    this.host.store.db
      .prepare(
        'INSERT INTO damage_evidence_subscriptions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(subscription.id, this.host.mode, JSON.stringify(subscription));
    if (this.scheduler) this.registerNumerical(subscription);
  }
  private numericalSpec(subscription: Subscription): WatcherSpec {
    const source = damageEvidenceSource(subscription.request.source_id);
    return {
      id: `damage-data-${contractHash({ identity: subscription.identity, request: evidenceRequestKey(subscription.request) })}`,
      source: {
        id: `damage-${source.id}`,
        name: source.title,
        kind: 'government',
        evidenceKind: 'report',
        organisation: source.title,
        cadence: `Every ${source.refresh_cadence_seconds} seconds`,
        licenceNote:
          source.access_requirements.join('; ') ||
          'Public provider terms apply.',
        reliabilityNote: source.limitations.join('; '),
        url: source.documentation_url,
      },
      requiresEnv: [],
      query: source.id,
      placeSelector: JSON.stringify(subscription.request.selection),
      timeSelector:
        'Dataset observation period; publication dates remain separate',
      cadenceSec: source.refresh_cadence_seconds,
      rateLimit: `${source.minimum_request_interval_ms} milliseconds between provider requests`,
      freshnessMinutes: source.refresh_cadence_seconds / 60,
    };
  }
  private registerNumerical(subscription: Subscription): void {
    const spec = this.numericalSpec(subscription);
    if (this.host.mode !== 'live' || this.env.SAMPLE_MODE === 'true') {
      this.scheduler!.registerDisabled(
        spec,
        'Recurring public acquisition requires live mode with SAMPLE_MODE disabled.',
      );
      return;
    }
    this.scheduler!.registerEvidenceWatcher({
      spec,
      run: ({ signal }) =>
        this.refresh(subscription.request, subscription.identity, signal),
    });
  }
  attach(scheduler: HazeOpsService): void {
    this.scheduler = scheduler;
    for (const subscription of this.subscriptions())
      this.registerNumerical(subscription);
    const news = this.newsWatcher();
    if (
      this.host.mode !== 'live' ||
      this.env.SAMPLE_MODE === 'true' ||
      !this.env.TAVILY_API_KEY?.trim()
    )
      scheduler.registerDisabled(
        news.spec,
        'News collection requires live mode, SAMPLE_MODE disabled and TAVILY_API_KEY.',
      );
    else scheduler.registerEvidenceWatcher(news);
    scheduler.registerEvidenceWatcher({
      spec: {
        ...news.spec,
        id: 'damage-evidence-revisions',
        source: {
          ...news.spec.source,
          id: 'damage-evidence-revisions',
          name: 'Damage evidence revision worker',
          kind: 'data_platform',
        },
        cadenceSec: 30,
        requiresEnv: [],
        query: 'Pending validated numerical revisions',
      },
      run: ({ signal }) => {
        signal.throwIfAborted();
        const count = this.drain();
        return Promise.resolve({
          changed: count > 0,
          coverage: coverage(count > 0),
        });
      },
    });
  }
  async refresh(
    request: AcquisitionRequest,
    identity: TaskIdentity,
    signal: AbortSignal,
    options: Omit<AcquireDamageEvidenceOptions, 'signal'> = {},
  ) {
    if (
      !this.matchingSubscriptions(request, identity).some(
        (s) => this.eligibility(s).reason === null,
      )
    )
      return {
        changed: false,
        coverage: {
          requested: 1,
          covered: 0,
          excluded: [],
          gaps: [
            'No active subscribed task currently authorizes this acquisition.',
          ],
        },
      };
    const active = { request, identity, controller: new AbortController() };
    this.activeRefreshes.add(active);
    const activeSignal = AbortSignal.any([signal, active.controller.signal]);
    try {
      const result = await acquireDamageEvidence(
        this.archiveFor(identity),
        request,
        { ...options, signal: activeSignal },
      );
      activeSignal.throwIfAborted();
      // Acquisition validation is necessary for a revision, but cannot qualify the resulting science.
      if (result.capture.stage === 'validated') {
        for (const subscription of this.matchingSubscriptions(
          request,
          identity,
        )) {
          if (this.eligibility(subscription).reason !== null) continue;
          if (subscription.capture_id === result.capture.capture_id) continue;
          const previous = this.archiveFor(identity).capture(
            subscription.capture_id,
          );
          if (
            damageEvidenceNumericalFingerprint(previous) ===
            damageEvidenceNumericalFingerprint(result.capture)
          )
            continue;
          const id = contractHash({
            subscription: subscription.id,
            capture: result.capture.capture_id,
          });
          const prior = this.host.store.db
            .prepare('SELECT id FROM damage_evidence_revision_jobs WHERE id=?')
            .get(id);
          if (!prior)
            this.saveJob({
              id,
              subscription,
              capture_id: result.capture.capture_id,
              state: 'pending',
              attempts: 0,
              error: null,
            });
        }
      }
      this.drain();
      return {
        changed: !result.unchanged,
        coverage: { ...coverage(!result.unchanged), gaps: result.capture.gaps },
      };
    } finally {
      this.activeRefreshes.delete(active);
    }
  }
  drain(): number {
    const rows = this.host.store.db
      .prepare('SELECT body FROM damage_evidence_revision_jobs WHERE mode=?')
      .all(this.host.mode) as { body: string }[];
    let completed = 0;
    for (const row of rows) {
      const job = JSON.parse(row.body) as RevisionJob;
      if (job.state === 'completed' || job.state === 'superseded') continue;
      job.attempts++;
      try {
        const { subscription } = job;
        const eligibility = this.eligibility(subscription);
        if (eligibility.reason !== null || !eligibility.task) {
          job.state = 'waiting';
          job.error = eligibility.reason;
          this.saveJob(job);
          continue;
        }
        const task = eligibility.task;
        const capture = this.archiveFor(subscription.identity).capture(
          job.capture_id,
        );
        const currentSubscription = this.subscriptions().find(
          (s) => s.id === subscription.id,
        );
        if (!currentSubscription) {
          job.state = 'superseded';
          job.error = 'The evidence subscription no longer exists.';
          this.saveJob(job);
          continue;
        }
        subscription.capture_id = currentSubscription.capture_id;
        const pinnedCapture = this.archiveFor(subscription.identity).capture(
          subscription.capture_id,
        );
        if (
          damageEvidenceNumericalFingerprint(pinnedCapture) ===
          damageEvidenceNumericalFingerprint(capture)
        ) {
          job.state = 'completed';
          job.error = null;
          this.saveJob(job);
          continue;
        }
        const latest = this.archiveFor(subscription.identity).latest(
          subscription.request,
        );
        if (!latest || latest.stage !== 'validated') {
          job.state = 'waiting';
          job.error = 'Latest source evidence is unavailable or not validated.';
          this.saveJob(job);
          continue;
        }
        if (
          damageEvidenceNumericalFingerprint(capture) !==
          damageEvidenceNumericalFingerprint(latest)
        ) {
          job.state = 'superseded';
          job.error =
            'A later validated source revision superseded this queued numerical update.';
          this.saveJob(job);
          continue;
        }
        const occurrence = accountOccurrencePeriod(task);
        const scope = currentScope(task);
        this.host.atomic(() => {
          const artifact = this.host.store.saveArtifact(
            task.id,
            subscription.identity,
            {
              kind: 'damage.evidence.capture',
              content: boundedJsonSchema.parse(capture),
              producer: { kind: 'service', id: 'damage-evidence-maintenance' },
              evidence_origin: capture.evidence_origin,
            },
          );
          const current = this.host.readTask(task.id, subscription.identity);
          this.host.updateTask(
            task.id,
            {
              schema_version: 'haze.task.update.v3',
              kind: 'correction',
              expected_objective_revision: current.objective_revision,
              expected_run_id: current.current_run_id,
              expected_generation: current.generation,
              expected_state_revision: current.state_revision,
              ...(scope === undefined
                ? {}
                : {
                    scope,
                  }),
              passage: `Revised numerical evidence ${capture.source_id}, capture ${capture.capture_id}, replaces capture ${subscription.capture_id}. Recalculate the baseline and reassess both interventions with fresh scientific and arithmetic reviews. ${occurrence ? `Damage remains assigned to occurrence period ${occurrence.start} through ${occurrence.end}.` : `The acquisition observation window is ${subscription.request.selection.period.start} through ${subscription.request.selection.period.end}; no account occurrence period is inferred.`} This acquisition does not establish scientific applicability.`,
              context_refs: [
                {
                  id: artifact.id,
                  version: artifact.version,
                  sha256: artifact.sha256,
                },
              ],
            },
            `evidence-revision-${job.id}`,
            subscription.identity,
          );
          job.state = 'completed';
          job.error = null;
          this.saveJob(job);
          subscription.capture_id = capture.capture_id;
          this.host.store.db
            .prepare(
              'UPDATE damage_evidence_subscriptions SET body=? WHERE id=?',
            )
            .run(JSON.stringify(subscription), subscription.id);
        });
        completed++;
      } catch (error) {
        job.state = 'waiting';
        job.error = error instanceof Error ? error.message : String(error);
        this.saveJob(job);
      }
    }
    return completed;
  }
  private newsWatcher(): EvidenceWatcher {
    return {
      spec: {
        id: 'damage-evidence-news',
        source: {
          id: 'damage-evidence-news',
          name: 'Malaysia haze news discovery',
          kind: 'news',
          evidenceKind: 'report',
          organisation: 'Tavily public search',
          cadence: 'Every 10 minutes',
          licenceNote:
            'Original publishers retain rights; retained bounded excerpts.',
          reliabilityNote:
            'Unreviewed discovery leads; never numerical accounting inputs.',
          url: 'https://docs.tavily.com/documentation/api-reference/endpoint/search',
        },
        requiresEnv: ['TAVILY_API_KEY'],
        query: 'Malaysia haze jerebu kesihatan kebakaran',
        placeSelector: 'Malaysia',
        timeSelector: 'Publication dates from the preceding day',
        cadenceSec: 600,
        rateLimit: 'One bounded search per ten minutes',
        freshnessMinutes: 20,
      },
      run: async ({ signal }) => {
        const fetched = await fetchTavilySearch(
          this.env.TAVILY_API_KEY!.trim(),
          {
            query: 'Malaysia haze jerebu kesihatan kebakaran',
            max_results: 5,
            recency_days: 1,
            topic: 'news',
          },
          signal,
        );
        signal.throwIfAborted();
        return this.retainNewsResponse(fetched.raw, fetched.retrievedAt);
      },
    };
  }
  /** Deterministic retention boundary: an edited article creates a new investigation, never a numerical revision. */
  retainNewsResponse(bytes: Uint8Array, retrievedAt: string) {
    const parsed = z
      .object({
        results: z
          .array(
            z.object({
              url: z
                .string()
                .url()
                .refine((value) => {
                  const url = new URL(value);
                  return (
                    ['https:', 'http:'].includes(url.protocol) &&
                    !url.username &&
                    !url.password
                  );
                }),
              title: z.string().optional(),
              content: z.string().optional(),
              published_date: z.string().nullable().optional(),
            }),
          )
          .max(200),
      })
      .parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
    const raw = this.archive.writeRaw(bytes);
    let changed = false;
    for (const entry of parsed.results.slice(0, 5)) {
      const url = new URL(entry.url);
      url.hash = '';
      for (const key of [...url.searchParams.keys()])
        if (key.startsWith('utm_')) url.searchParams.delete(key);
      const id = contractHash({
        mode: this.host.mode,
        url: url.href,
        title: entry.title?.slice(0, 400) ?? url.href,
        content_sha256: evidenceSha256(entry.content ?? ''),
        published_at: entry.published_date ?? null,
      });
      const inserted = this.host.store.db
        .prepare('INSERT OR IGNORE INTO damage_evidence_news VALUES(?,?,?)')
        .run(
          id,
          this.host.mode,
          JSON.stringify({
            id,
            ...raw,
            url: url.href,
            title: entry.title?.slice(0, 400) ?? url.href,
            excerpt: entry.content?.slice(0, 4000) ?? '',
            published_at: entry.published_date ?? null,
            retrieved_at: retrievedAt,
            disposition: 'investigation_required',
            numerical_recalculation: false,
          }),
        );
      changed ||= Number(inserted.changes) > 0;
    }
    return { changed, coverage: coverage(false) };
  }
  view(identity: TaskIdentity) {
    const subscriptions = this.subscriptions().filter(
      (s) =>
        s.identity.principal === identity.principal &&
        s.identity.workspace === identity.workspace,
    );
    const ids = new Set(subscriptions.map((s) => s.id));
    return {
      subscriptions: subscriptions.map((s) => ({
        ...s,
        availability: this.archiveFor(identity).availability(s.request),
      })),
      revision_jobs: (
        this.host.store.db
          .prepare(
            'SELECT body FROM damage_evidence_revision_jobs WHERE mode=?',
          )
          .all(this.host.mode) as { body: string }[]
      )
        .map((r) => JSON.parse(r.body) as RevisionJob)
        .filter((j) => ids.has(j.subscription.id)),
      investigations: (
        this.host.store.db
          .prepare(
            'SELECT body FROM damage_evidence_news WHERE mode=? ORDER BY rowid DESC LIMIT 50',
          )
          .all(this.host.mode) as { body: string }[]
      ).map((r) => JSON.parse(r.body) as unknown),
    };
  }
}

export function createDamageEvidenceMaintenanceExtension(
  env: NodeJS.ProcessEnv = {},
) {
  return (host: TaskRuntimeExtensionHost): TaskRuntimeExtension => {
    const service = new DamageEvidenceMaintenance(host, env);
    return {
      id: 'damage-evidence-maintenance',
      service,
      tools: createDamageEvidenceTools({
        archiveRoot: service.archive.root,
        mode: host.mode,
        resolveArtifact: (ref, context) =>
          host.store.artifact(ref.id, context.identity, ref),
        onCapture: (result, request, context) => {
          service.track(result.capture, request, context);
          return Promise.resolve();
        },
      }).map((tool) => ({
        ...tool,
        execute: async (input, context) => {
          if (
            env.SAMPLE_MODE === 'true' &&
            tool.id !== 'haze-damage-evidence-plan'
          )
            throw new Error(
              'SAMPLE_MODE=true disables public evidence acquisition.',
            );
          return tool.execute(input, context);
        },
      })),
      handlesHttp: (path) => path === '/api/damage-evidence/maintenance',
      mutateTask: (_context, perform) => {
        const receipt = perform();
        host.afterCommit(() => service.reconcileActiveRefreshes());
        return receipt;
      },
      handleHttp: (request) => {
        if (request.method !== 'GET')
          throw new TaskError(
            405,
            'method_not_allowed',
            'Evidence maintenance accepts GET.',
          );
        if (request.query.size)
          throw new TaskError(
            400,
            'invalid_query',
            'Evidence maintenance accepts no query parameters.',
          );
        return { status: 200, body: service.view(request.identity) };
      },
      taskViews: {
        'damage-evidence': (taskId, identity) => {
          host.readTask(taskId, identity);
          const view = service.view(identity);
          return {
            ...view,
            subscriptions: view.subscriptions.filter(
              (s) => s.task_id === taskId,
            ),
            revision_jobs: view.revision_jobs.filter(
              (j) => j.subscription.task_id === taskId,
            ),
          };
        },
      },
    };
  };
}
