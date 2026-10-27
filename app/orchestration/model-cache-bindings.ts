import { createHash } from 'node:crypto';
import type {
  AgentModelCacheContext,
  AgentModelInput,
} from '../adapters/agent-model.js';
import type { ModelCacheNormalizer } from '../adapters/model-cache.js';
import {
  artifactRefSchema,
  type Artifact,
  type ArtifactRef,
} from '../contracts/artifacts.js';
import type { TaskRecord } from '../contracts/tasks.js';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const ordered = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(ordered)
    : record(value)
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, ordered(item)]),
        )
      : value;
const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(ordered(value)))
    .digest('hex');
const userTextEvidence = (context: unknown) => {
  const request =
    record(context) && record(context.request) ? context.request : {};
  const corrections: unknown[] =
    record(context) && Array.isArray(context.corrections)
      ? context.corrections
      : [];
  return {
    artifact: '__haze_unmodified_user_text__',
    semantic_sha256: digest({
      objective: request.objective ?? null,
      constraints: request.constraints ?? [],
      desired_deliverables: request.desired_deliverables ?? [],
      correction_passages: corrections.map((item) =>
        record(item) ? (item.passage ?? null) : item,
      ),
    }),
  };
};

/** Reads complete immutable bodies; truncated prompt excerpts never determine evidence equivalence. */
export function createModelCacheBindings(
  context: unknown,
  task: Pick<
    TaskRecord,
    'id' | 'current_run_id' | 'identity' | 'mode' | 'permissions'
  > &
    Partial<Pick<TaskRecord, 'original_request' | 'corrections'>> & {
      assignments: Pick<
        TaskRecord['assignments'][number],
        'id' | 'definition_id' | 'role' | 'objective_revision' | 'revision'
      >[];
      artifacts: { artifact: ArtifactRef }[];
    },
  readArtifact: (ref: ArtifactRef) => Artifact,
): AgentModelCacheContext {
  const identities = new Map<string, string>();
  const bindings = new Map<string, string>();
  const bind = (actual: string | undefined, canonical: string) => {
    if (actual && !bindings.has(actual)) bindings.set(actual, canonical);
  };
  const identity = (actual: string, canonical: string) => {
    identities.set(actual, canonical);
    bind(actual, canonical);
  };
  identity(task.id, '__haze_task_current__');
  identity(task.current_run_id, '__haze_run_current__');
  const counts = new Map<string, number>();
  for (const assignment of task.assignments) {
    const group = `${assignment.definition_id}:${assignment.role}:${assignment.objective_revision}:${assignment.revision}`;
    const ordinal = counts.get(group) ?? 0;
    counts.set(group, ordinal + 1);
    identity(
      assignment.id,
      `__haze_assignment_${digest({ group, ordinal })}__`,
    );
  }
  if (record(context)) {
    if (typeof context.decision_id === 'string')
      bind(context.decision_id, '__haze_decision_current__');
    if (
      record(context.resources) &&
      record(context.resources.limits) &&
      typeof context.resources.limits.deadline === 'string'
    )
      bind(context.resources.limits.deadline, '__haze_host_deadline__');
    if (Array.isArray(context.inspections))
      context.inspections.forEach((item, index) => {
        if (record(item) && typeof item.inspected_at === 'string')
          bind(item.inspected_at, `__haze_inspection_time_${index}__`);
      });
  }

  const evidence = new Map<
    string,
    { artifact: string; semantic_sha256: string }
  >();
  const inProgress = new Set<string>();
  const groups = new Map<string, number>();
  function resolveArtifact(ref: ArtifactRef): {
    artifact: string;
    semantic_sha256: string;
  } {
    const prior = evidence.get(ref.id);
    if (prior) return prior;
    if (inProgress.has(ref.id) || evidence.size + inProgress.size >= 256)
      throw new Error('Cache evidence closure is cyclic or exceeds its bound.');
    const artifact = readArtifact(ref);
    if (
      artifact.id !== ref.id ||
      artifact.version !== ref.version ||
      artifact.sha256 !== ref.sha256
    )
      throw new Error('Cache evidence requires exact immutable references.');
    inProgress.add(ref.id);
    const producer =
      identities.get(artifact.producer.id) ?? artifact.producer.id;
    const group = digest({
      kind: artifact.kind,
      producer,
      filename: artifact.filename ?? null,
      version: artifact.version,
    });
    const ordinal = groups.get(group) ?? 0;
    groups.set(group, ordinal + 1);
    const alias = `__haze_artifact_${group}_${ordinal}__`;
    bind(artifact.id, alias);
    let content: unknown = artifact.content;
    if (
      artifact.producer.kind === 'assignment' &&
      artifact.kind === 'pm25.capture' &&
      artifact.evidence_origin === 'synthetic_fixture' &&
      record(content) &&
      content.evidence_origin === 'synthetic_fixture' &&
      record(content.selection) &&
      content.selection.backend === 'sample-file' &&
      typeof content.retrieved_at === 'string'
    ) {
      // This time records the host's fresh file read, not an observation or
      // provider timestamp. Preserve the actual artifact and rebind it on hits.
      bind(content.retrieved_at, `__haze_local_read_${alias}__`);
      content = {
        ...content,
        retrieved_at:
          bindings.get(content.retrieved_at) ?? content.retrieved_at,
      };
    }
    const semantic =
      artifact.producer.kind !== 'assignment'
        ? digest({
            kind: artifact.kind,
            version: artifact.version,
            content_sha256: artifact.sha256,
            original_byte_sha256: artifact.original_byte_sha256 ?? null,
            evidence_origin: artifact.evidence_origin ?? null,
            media_type: artifact.media_type ?? null,
            filename: artifact.filename ?? null,
            declared_origin: artifact.declared_origin ?? null,
            source_location: artifact.source_location ?? null,
          })
        : digest({
            kind: artifact.kind,
            version: artifact.version,
            producer,
            assignment_revision: artifact.assignment_revision ?? null,
            objective_revision: artifact.objective_revision ?? null,
            evidence_origin: artifact.evidence_origin ?? null,
            required_tools: artifact.required_tools,
            content: semanticContent(content),
            dependencies: artifact.dependencies.map(resolveArtifact),
            external_candidates:
              artifact.external_candidates?.map(resolveArtifact) ?? [],
          });
    const result = { artifact: alias, semantic_sha256: semantic };
    evidence.set(ref.id, result);
    inProgress.delete(ref.id);
    if (artifact.producer.kind === 'assignment')
      bind(artifact.sha256, `__haze_artifact_hash_${alias}_${semantic}__`);
    return result;
  }
  function semanticContent(value: unknown): unknown {
    const ref = artifactRefSchema.safeParse(value);
    if (ref.success) return resolveArtifact(ref.data);
    if (typeof value === 'string') return identities.get(value) ?? value;
    if (Array.isArray(value)) return value.map(semanticContent);
    if (record(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          semanticContent(item),
        ]),
      );
    return value;
  }
  // User scope text is evidence. Only typed references may vary across runs;
  // a literal that happens to contain a runtime ID must remain significant.
  function semanticScope(value: unknown): unknown {
    const ref = artifactRefSchema.safeParse(value);
    if (ref.success) return resolveArtifact(ref.data);
    if (Array.isArray(value)) return value.map(semanticScope);
    if (record(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, semanticScope(item)]),
      );
    return value;
  }
  for (const item of task.artifacts) resolveArtifact(item.artifact);
  const scopeDigest = digest({
    original: semanticScope(task.original_request?.scope ?? null),
    effective: semanticScope(
      record(context) && record(context.request)
        ? (context.request.scope ?? null)
        : null,
    ),
    corrections: (task.corrections ?? []).map((item) =>
      semanticScope(item.scope ?? null),
    ),
  });
  return {
    version: 'haze.model-cache-bindings.v1',
    bindings: [...bindings].map(([actual, canonical]) => ({
      actual,
      canonical,
    })),
    evidence: [
      userTextEvidence(context),
      { artifact: '__haze_user_scope__', semantic_sha256: scopeDigest },
      {
        artifact: '__haze_authority__',
        semantic_sha256: digest({
          identity: task.identity,
          mode: task.mode,
          permissions: task.permissions,
        }),
      },
      ...[...evidence.values()].sort((a, b) =>
        a.artifact < b.artifact ? -1 : a.artifact > b.artifact ? 1 : 0,
      ),
    ],
  };
}

function replaceStrings(
  value: unknown,
  pairs: { actual: string; canonical: string }[],
): unknown {
  if (typeof value === 'string')
    return pairs.reduce(
      (text, pair) => text.replaceAll(pair.actual, pair.canonical),
      value,
    );
  if (Array.isArray(value))
    return value.map((item) => replaceStrings(item, pairs));
  if (record(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replaceStrings(item, pairs),
      ]),
    );
  return value;
}

/** Only host identity/timing metadata is rebound; source values and full evidence digests remain in the key. */
export const managerModelCacheNormalizer: ModelCacheNormalizer = {
  version: 'haze.manager-semantic-bindings.v2',
  project(input: AgentModelInput) {
    const sidecar = input.cache_context;
    if (
      !sidecar ||
      sidecar.version !== 'haze.model-cache-bindings.v1' ||
      !record(input.context) ||
      input.context.purpose !== 'decision'
    )
      return {
        input,
        encodeOutput: (text) => text,
        decodeOutput: (text) => text,
      };
    const forward = [...sidecar.bindings]
      .filter((pair) => pair.actual.length >= 8)
      .sort((a, b) => b.actual.length - a.actual.length);
    const reverse = forward
      .map(({ actual, canonical }) => ({
        actual: canonical,
        canonical: actual,
      }))
      .sort((a, b) => b.actual.length - a.actual.length);
    const normalized = replaceStrings(input, forward) as AgentModelInput;
    normalized.cache_context = {
      version: sidecar.version,
      bindings: [],
      evidence: [
        ...sidecar.evidence.filter(
          (entry) => entry.artifact !== '__haze_unmodified_user_text__',
        ),
        userTextEvidence(input.context),
      ],
    };
    if (record(normalized.context)) {
      if (Array.isArray(normalized.context.artifacts))
        for (const artifact of normalized.context.artifacts) {
          if (
            !record(artifact) ||
            artifact.truncated !== true ||
            typeof artifact.excerpt !== 'string'
          )
            continue;
          // A context excerpt may end in the middle of an exact derived hash.
          // Bind only that typed hash prefix, backed by the complete artifact
          // digest; all visible source data and the truncation length remain.
          const prefix = /"sha256":"([a-f0-9]{8,63})$/u.exec(
            artifact.excerpt,
          )?.[1];
          if (!prefix) continue;
          const matches = forward.filter(
            (pair) =>
              /^[a-f0-9]{64}$/u.test(pair.actual) &&
              pair.actual.startsWith(prefix),
          );
          if (matches.length === 1)
            artifact.excerpt =
              artifact.excerpt.slice(0, -prefix.length) +
              matches[0]!.canonical +
              `__partial_hash_${prefix.length}__`;
        }
      normalized.context.event_cursor = 0;
      if (record(normalized.context.context_status))
        normalized.context.context_status.bytes = 0;
      if (Array.isArray(normalized.context.events))
        normalized.context.events.forEach((event, index) => {
          if (!record(event)) return;
          event.cursor = index;
          if (
            event.type === 'artifact_reviewed' &&
            record(event.data) &&
            typeof event.data.review_key === 'string'
          )
            event.data.review_key = '__haze_host_review_key__';
          if (
            record(event.data) &&
            [
              'attempt_completed',
              'manager.graph.completed',
              'specialist.graph.completed',
            ].includes(String(event.type))
          ) {
            for (const key of ['started_at', 'completed_at', 'duration_ms'])
              if (key in event.data) event.data[key] = '__haze_host_timing__';
          }
        });
    }
    const originalContext = input.context;
    return {
      input: normalized,
      encodeOutput(text) {
        let encoded = replaceStrings(text, forward) as string;
        try {
          const value: unknown = JSON.parse(encoded);
          const original: unknown = JSON.parse(text);
          if (
            record(value) &&
            record(original) &&
            original.event_cursor === originalContext.event_cursor
          ) {
            value.event_cursor = '__haze_event_cursor__';
            encoded = JSON.stringify(value);
          }
        } catch {
          /* Invalid model messages remain invalid on replay. */
        }
        return encoded;
      },
      decodeOutput(text) {
        const decoded = replaceStrings(text, reverse) as string;
        try {
          const value: unknown = JSON.parse(decoded);
          if (record(value) && value.event_cursor === '__haze_event_cursor__') {
            value.event_cursor = originalContext.event_cursor;
            return JSON.stringify(value);
          }
        } catch {
          /* The ordinary runtime validator rejects invalid output. */
        }
        return decoded;
      },
    };
  },
};
