import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { agentRoleSchema, type AgentRole } from '../contracts/capabilities.js';
import { nightshiftCloudLaneSchema } from '../contracts/nightshift.js';
import { canonicalJson, parseContractJson } from '../contracts/json.js';
import {
  automaticReadinessV2Schema,
  automaticReleaseBlocked,
  automaticScopeSchema,
  withinInitialScope,
  AUTOMATIC_RELEASE_GATES,
  type AutomaticReadiness,
  type AutomaticReleaseGateId,
  type AutomaticReleasePolicy,
  type AutomaticScope,
} from '../contracts/nightshift-automatic.js';
import type {
  ExecutionRegistry,
  NightshiftJobPort,
} from '../orchestration/ports.js';
import type { ModelRouteService } from '../orchestration/model-service.js';
import {
  roleEvaluationEvidenceSchema,
  validateRoleEvaluation,
} from './nightshift-role-evidence.js';
import {
  retainedDomainEvidenceSchema,
  validateDomainDemonstration,
} from './nightshift-domain-evidence.js';

/** Strict role verification and demonstration routes use this exact identity. */
export const NVIDIA_ULTRA_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
export const STRICT_RELEASE_ROLES: readonly AgentRole[] = [
  'Manager',
  'EvidenceCritic',
  'DamageAccountant',
];
export const RELEASE_DIRECTORY = 'nightshift-release';
const MANIFEST_FILE = 'current.json';
const MANIFEST_MAX_BYTES = 65_536;
const EVIDENCE_MAX_BYTES = 4_194_304;
const INTERACTIVE_LATENCY_GATE_MS = 90_000;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().trim().min(1).max(4096);
const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

export const releaseBindingsSchema = z.strictObject({
  build_sha256: sha256,
  instructions_sha256: sha256,
  contracts_sha256: sha256,
  routes: z.partialRecord(
    agentRoleSchema,
    z.strictObject({
      route_id: z.string().min(1).max(160),
      provider: z.string().min(1).max(64),
      requested_model: z.string().min(1).max(256).nullable(),
    }),
  ),
  nightshift: z.strictObject({
    runtime_version: z.string().min(1).max(64),
    schema_hash: sha256,
    installation_fingerprint: sha256,
    roster_fingerprint: sha256,
    cloud_lanes: z.array(nightshiftCloudLaneSchema).min(1).max(128),
  }),
});
export type ReleaseBindings = z.infer<typeof releaseBindingsSchema>;

const modelCallsSchema = z.partialRecord(
  agentRoleSchema,
  z.number().int().nonnegative(),
);
const demonstrationSchema = z.strictObject({
  workflow: z.enum(['pm25', 'damage-accounting']),
  task_id: z.uuid(),
  status: z.literal('completed'),
  completion: z.literal('full'),
  review_status: z.literal('supported'),
  data_origin: z.enum(['external_source', 'supplied']),
  answer_rendered: z.literal(true),
  model_calls_by_role: modelCallsSchema,
  artifacts: z.array(sha256).min(1).max(256),
  restart_readback: z.literal(true),
  retained_report: retainedDomainEvidenceSchema,
});
/** Kind-specific payloads; each slot proves one release gate with live data only. */
const payloads = {
  role_evaluation: roleEvaluationEvidenceSchema,
  independent_review: z.strictObject({
    reviewer: text,
    verdict: z.literal('supported'),
    reviewed_evaluation_sha256: sha256,
    reviewed_output_sha256s: z.array(sha256).min(1).max(512),
    findings: z.array(text).max(256),
  }),
  pm25_demonstration: demonstrationSchema.extend({
    workflow: z.literal('pm25'),
    data_origin: z.literal('external_source'),
  }),
  damage_demonstration: demonstrationSchema.extend({
    workflow: z.literal('damage-accounting'),
    data_origin: z.literal('supplied'),
    planning: demonstrationSchema.extend({
      workflow: z.literal('damage-reduction'),
      data_origin: z.literal('supplied'),
    }),
  }),
  cloud_generation: z.strictObject({
    task_id: z.uuid(),
    chain_id: z.uuid(),
    job_id: z.uuid(),
    remote_id: z.string().min(1).max(160),
    privacy: z.literal('cloud-ok'),
    execution_state: z.literal('completed'),
    attempts: z
      .array(
        z.strictObject({
          lane: z.string().min(1).max(256),
          model: z.string().min(1).max(256),
          kind: z.literal('cloud'),
        }),
      )
      .min(1)
      .max(16),
    review_status: z.literal('unreviewed'),
  }),
  wait_wakeup: z.strictObject({
    task_id: z.uuid(),
    chain_id: z.uuid(),
    job_id: z.uuid(),
    wait_id: z.uuid(),
    parked: z.literal(true),
    capacity_released: z.literal(true),
    completion_captured: z.literal(true),
    woke: z.literal(true),
    candidate_reviewed: z.literal(true),
  }),
  interactive_latency: z.strictObject({
    task_id: z.uuid(),
    chain_id: z.uuid(),
    job_id: z.uuid(),
    background_active: z.literal(true),
    samples_ms: z.array(z.number().nonnegative()).min(1).max(256),
    gate_ms: z.literal(INTERACTIVE_LATENCY_GATE_MS),
  }),
  automatic_chain: z.strictObject({
    task_id: z.uuid(),
    chain_id: z.uuid(),
    job_id: z.uuid(),
    opted_in: z.literal(true),
    successors_admitted: z.literal(1),
    grant: z.strictObject({
      privacy: z.literal('cloud-ok'),
      total_runs: z.number().int().positive(),
      automatic_followup_runs: z.number().int().positive(),
      max_jobs: z.number().int().positive(),
      max_attempts: z.number().int().positive(),
      lifetime_seconds: z.number().int().positive(),
    }),
  }),
  crash_restart: z.strictObject({
    task_id: z.uuid(),
    chain_id: z.uuid(),
    job_id: z.uuid(),
    remote_id: z.string().min(1).max(160),
    restart_verified: z.literal(true),
    identities_preserved: z.literal(true),
    accounting_preserved: z.literal(true),
    results_preserved: z.literal(true),
  }),
} as const;
export type ReleaseEvidenceSlot = keyof typeof payloads;
export const RELEASE_EVIDENCE_SLOTS = Object.keys(
  payloads,
) as ReleaseEvidenceSlot[];
const SLOT_GATES: Record<ReleaseEvidenceSlot, AutomaticReleaseGateId> = {
  role_evaluation: 'routing-live-contracts',
  independent_review: 'routing-live-contracts',
  pm25_demonstration: 'domain-demonstrations',
  damage_demonstration: 'domain-demonstrations',
  cloud_generation: 'cloud-background-generation',
  wait_wakeup: 'wait-and-interactive-latency',
  interactive_latency: 'wait-and-interactive-latency',
  automatic_chain: 'automatic-chain-live-trace',
  crash_restart: 'crash-restart',
};

export const releaseEvidenceSchema = z.strictObject({
  schema_version: z.literal('haze.nightshift.release.evidence.v1'),
  slot: z.enum(RELEASE_EVIDENCE_SLOTS as [ReleaseEvidenceSlot]),
  /** Fixture and provisional verification evidence can never release production. */
  evidence_kind: z.literal('live'),
  recorded_at: z.iso.datetime(),
  bindings_sha256: sha256,
  payload: z.unknown(),
});
export const releaseManifestSchema = z.strictObject({
  schema_version: z.literal('haze.nightshift.release.manifest.v1'),
  release_id: z.uuid(),
  published_at: z.iso.datetime(),
  bindings: releaseBindingsSchema,
  strict_roles: z.array(agentRoleSchema).min(1).max(8),
  scope: automaticScopeSchema,
  evidence: z.strictObject(
    Object.fromEntries(
      RELEASE_EVIDENCE_SLOTS.map((slot) => [slot, sha256]),
    ) as Record<ReleaseEvidenceSlot, typeof sha256>,
  ),
});
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

class ReleaseRejection extends Error {
  constructor(
    readonly gate: AutomaticReleaseGateId | null,
    message: string,
  ) {
    super(message);
  }
}
const reject = (
  gate: AutomaticReleaseGateId | null,
  message: string,
): never => {
  throw new ReleaseRejection(gate, message);
};

function readBounded(path: string, maximum: number): Buffer | null {
  let descriptor: number;
  try {
    descriptor = openSync(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximum)
      reject(null, `Release file exceeds its ${maximum}-byte bound.`);
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function strictRoutes(
  manifest: ReleaseManifest,
  bindings: ReleaseBindings,
): void {
  for (const role of manifest.strict_roles) {
    const route = bindings.routes[role];
    if (!route || route.requested_model !== NVIDIA_ULTRA_MODEL)
      reject(
        'routing-live-contracts',
        `The strict ${role} route must request exactly ${NVIDIA_ULTRA_MODEL}.`,
      );
  }
  for (const role of STRICT_RELEASE_ROLES)
    if (!manifest.strict_roles.includes(role))
      reject(
        'routing-live-contracts',
        `The release must cover the strict ${role} role.`,
      );
}

/** Validates every reference and gate. Throws ReleaseRejection on the first failure. */
export function validateRelease(
  manifest: ReleaseManifest,
  evidence: Readonly<Record<ReleaseEvidenceSlot, Buffer>>,
  current: ReleaseBindings,
): void {
  const changed = (
    [
      ['build', manifest.bindings.build_sha256 !== current.build_sha256],
      [
        'instructions',
        manifest.bindings.instructions_sha256 !== current.instructions_sha256,
      ],
      [
        'contracts',
        manifest.bindings.contracts_sha256 !== current.contracts_sha256,
      ],
      [
        'routes',
        canonicalJson(manifest.bindings.routes) !==
          canonicalJson(current.routes),
      ],
      [
        'runtime',
        manifest.bindings.nightshift.runtime_version !==
          current.nightshift.runtime_version ||
          manifest.bindings.nightshift.schema_hash !==
            current.nightshift.schema_hash ||
          manifest.bindings.nightshift.installation_fingerprint !==
            current.nightshift.installation_fingerprint,
      ],
      [
        'roster',
        manifest.bindings.nightshift.roster_fingerprint !==
          current.nightshift.roster_fingerprint ||
          canonicalJson(manifest.bindings.nightshift.cloud_lanes) !==
            canonicalJson(current.nightshift.cloud_lanes),
      ],
    ] as const
  )
    .filter(([, differs]) => differs)
    .map(([name]) => name);
  if (changed.length)
    reject(
      null,
      `Release evidence no longer matches the current ${changed.join(', ')}; regenerate the affected evidence.`,
    );
  if (!withinInitialScope(manifest.scope))
    reject(
      'automatic-chain-live-trace',
      'The manifest scope exceeds the supported initial automatic release.',
    );
  strictRoutes(manifest, current);
  const bindingsHash = hash(canonicalJson(manifest.bindings));
  const parsed = {} as {
    [K in ReleaseEvidenceSlot]: z.infer<(typeof payloads)[K]>;
  };
  for (const slot of RELEASE_EVIDENCE_SLOTS) {
    const gate = SLOT_GATES[slot];
    const bytes = evidence[slot];
    if (hash(bytes) !== manifest.evidence[slot])
      reject(gate, `The ${slot} evidence hash does not match the manifest.`);
    let record: z.infer<typeof releaseEvidenceSchema>;
    try {
      record = releaseEvidenceSchema.parse(
        parseContractJson(bytes.toString('utf8'), EVIDENCE_MAX_BYTES),
      );
    } catch {
      return reject(
        gate,
        `The ${slot} evidence is not retained live release evidence.`,
      );
    }
    if (record.slot !== slot)
      reject(gate, `The ${slot} reference names ${record.slot} evidence.`);
    if (record.bindings_sha256 !== bindingsHash)
      reject(gate, `The ${slot} evidence was recorded for different bindings.`);
    const payload = payloads[slot].safeParse(record.payload);
    if (!payload.success)
      reject(gate, `The ${slot} evidence does not prove its release gate.`);
    (parsed as Record<string, unknown>)[slot] = payload.data;
  }
  const evaluation = parsed.role_evaluation;
  const review = parsed.independent_review;
  try {
    validateRoleEvaluation(
      evaluation,
      current,
      manifest.strict_roles,
      NVIDIA_ULTRA_MODEL,
    );
  } catch (error) {
    reject(
      'routing-live-contracts',
      error instanceof Error
        ? error.message
        : 'Current frozen role comparison could not be verified.',
    );
  }
  if (
    review.reviewer.trim().toLowerCase() ===
    evaluation.evaluator.trim().toLowerCase()
  )
    reject(
      'routing-live-contracts',
      'The role evaluation requires a separate independent reviewer.',
    );
  const outputs = evaluation.outputs.map((output) => output.output_sha256);
  if (
    review.reviewed_evaluation_sha256 !== manifest.evidence.role_evaluation ||
    canonicalJson([...new Set(review.reviewed_output_sha256s)].sort()) !==
      canonicalJson([...new Set(outputs)].sort())
  )
    reject(
      'routing-live-contracts',
      'The independent review is not tied to the exact evaluated outputs.',
    );
  for (const [demonstration, workflow] of [
    [parsed.pm25_demonstration, 'pm25'],
    [parsed.damage_demonstration, 'damage-accounting'],
    [parsed.damage_demonstration.planning, 'damage-reduction'],
  ] as const) {
    try {
      validateDomainDemonstration(
        demonstration,
        workflow,
        current,
        NVIDIA_ULTRA_MODEL,
      );
    } catch (error) {
      reject(
        'domain-demonstrations',
        error instanceof Error
          ? error.message
          : 'Retained live domain evidence could not be verified.',
      );
    }
  }
  // Separate successful traces cannot be combined to claim one verified chain.
  // Every lifecycle gate must identify the same original task, chain and job.
  const generation = parsed.cloud_generation;
  const cloudRoster = current.nightshift.cloud_lanes;
  const rosterBytes = JSON.stringify(
    cloudRoster
      .map(({ lane, provider, model }) => [lane, provider, model])
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
  );
  if (
    new Set(cloudRoster.map(({ lane }) => lane)).size !== cloudRoster.length ||
    hash(rosterBytes) !== current.nightshift.roster_fingerprint ||
    generation.attempts.some(
      (attempt) =>
        !cloudRoster.some(
          (lane) => lane.lane === attempt.lane && lane.model === attempt.model,
        ),
    )
  )
    reject(
      'cloud-background-generation',
      'The selected native attempt must belong to the reviewed cloud roster.',
    );
  if (generation.attempts.length > manifest.scope.max_attempts_per_job)
    reject(
      'cloud-background-generation',
      'The verified cloud job exceeds the released attempts-per-job ceiling.',
    );
  for (const slot of [
    'wait_wakeup',
    'interactive_latency',
    'automatic_chain',
    'crash_restart',
  ] as const) {
    const trace = parsed[slot];
    if (
      trace.task_id !== generation.task_id ||
      trace.chain_id !== generation.chain_id ||
      trace.job_id !== generation.job_id
    )
      reject(
        SLOT_GATES[slot],
        `The ${slot} trace does not identify the verified cloud task, chain and job.`,
      );
  }
  if (parsed.crash_restart.remote_id !== generation.remote_id)
    reject(
      'crash-restart',
      'Restart readback must preserve the verified native remote job identity.',
    );
  if (
    Math.max(...parsed.interactive_latency.samples_ms) >
    INTERACTIVE_LATENCY_GATE_MS
  )
    reject(
      'wait-and-interactive-latency',
      'Interactive latency under background execution exceeded the 90-second gate.',
    );
  const { grant } = parsed.automatic_chain;
  if (
    grant.total_runs > manifest.scope.max_total_runs ||
    grant.automatic_followup_runs > manifest.scope.max_automatic_followups ||
    grant.max_jobs > manifest.scope.max_jobs ||
    grant.max_attempts >
      manifest.scope.max_jobs * manifest.scope.max_attempts_per_job ||
    grant.lifetime_seconds > manifest.scope.max_lifetime_seconds
  )
    reject(
      'automatic-chain-live-trace',
      'The verified chain grant exceeds the released scope.',
    );
}

function failedReadiness(error: unknown): AutomaticReadiness {
  // Validation stops at the first failure, so no other gate is reported as passed.
  if (error instanceof ReleaseRejection)
    return automaticReleaseBlocked(
      error.message,
      [],
      error.gate ? { [error.gate]: error.message } : {},
    );
  return automaticReleaseBlocked(
    'Release evidence could not be read or validated.',
  );
}

function releasePaths(stateDirectory: string) {
  const root = join(stateDirectory, RELEASE_DIRECTORY);
  return {
    root,
    manifest: join(root, MANIFEST_FILE),
    evidence: (digest: string) => join(root, 'evidence', `${digest}.json`),
  };
}

/** Reads the fixed manifest and content-addressed files beneath the state directory. */
export function loadRelease(stateDirectory: string): {
  manifest: ReleaseManifest;
  evidence: Record<ReleaseEvidenceSlot, Buffer>;
} | null {
  const paths = releasePaths(stateDirectory);
  const bytes = readBounded(paths.manifest, MANIFEST_MAX_BYTES);
  if (!bytes) return null;
  let manifest: ReleaseManifest;
  try {
    manifest = releaseManifestSchema.parse(
      parseContractJson(bytes.toString('utf8'), MANIFEST_MAX_BYTES),
    );
  } catch {
    return reject(null, 'The release manifest is malformed.');
  }
  const evidence = {} as Record<ReleaseEvidenceSlot, Buffer>;
  for (const slot of RELEASE_EVIDENCE_SLOTS) {
    const file = readBounded(
      paths.evidence(manifest.evidence[slot]),
      EVIDENCE_MAX_BYTES,
    );
    if (!file)
      reject(SLOT_GATES[slot], `The referenced ${slot} evidence is missing.`);
    evidence[slot] = file!;
  }
  return { manifest, evidence };
}

/**
 * Production release policy. Browser requests, model outputs and task inputs
 * have no path to this directory; only the trusted assembler publishes it.
 */
export function createNightshiftReleasePolicy(options: {
  stateDirectory: string;
  bindings: () => Promise<ReleaseBindings | null>;
}): AutomaticReleasePolicy {
  return async () => {
    try {
      const release = loadRelease(options.stateDirectory);
      if (!release)
        return automaticReleaseBlocked(
          'No production Nightshift release manifest is installed.',
        );
      const current = await options.bindings();
      if (!current)
        return automaticReleaseBlocked(
          'Current build, route or Nightshift runtime identity could not be established.',
        );
      validateRelease(release.manifest, release.evidence, current);
      return automaticReadinessV2Schema.parse({
        schema_version: 'haze.nightshift.automatic.readiness.v2',
        released: true,
        ready: true,
        reason: null,
        evidence_id: `release:${release.manifest.release_id}`,
        evidence_kind: 'live',
        scope: release.manifest.scope,
        gates: AUTOMATIC_RELEASE_GATES.map((gate) => ({
          id: gate.id,
          label: gate.label,
          passed: true,
          reason: null,
        })),
      });
    } catch (error) {
      return failedReadiness(error);
    }
  };
}

/** Writes content-addressed evidence, then atomically replaces the manifest. */
export function publishNightshiftRelease(options: {
  stateDirectory: string;
  bindings: ReleaseBindings;
  scope: AutomaticScope;
  evidence: Readonly<Record<ReleaseEvidenceSlot, Buffer>>;
  strictRoles?: readonly AgentRole[];
}): ReleaseManifest {
  const manifest = releaseManifestSchema.parse({
    schema_version: 'haze.nightshift.release.manifest.v1',
    release_id: randomUUID(),
    published_at: new Date().toISOString(),
    bindings: options.bindings,
    strict_roles: [...(options.strictRoles ?? STRICT_RELEASE_ROLES)],
    scope: options.scope,
    evidence: Object.fromEntries(
      RELEASE_EVIDENCE_SLOTS.map((slot) => [
        slot,
        hash(options.evidence[slot]),
      ]),
    ),
  });
  // Nothing is written unless every gate passes against the current bindings.
  validateRelease(manifest, options.evidence, options.bindings);
  const paths = releasePaths(options.stateDirectory);
  mkdirSync(join(paths.root, 'evidence'), { recursive: true });
  const durable = (path: string, bytes: Buffer | string) => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporary, 'wx');
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
  };
  for (const slot of RELEASE_EVIDENCE_SLOTS)
    durable(paths.evidence(manifest.evidence[slot]), options.evidence[slot]);
  durable(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Evidence files record the exact bindings they were captured under. */
export function releaseEvidenceRecord(
  slot: ReleaseEvidenceSlot,
  bindings: ReleaseBindings,
  payload: unknown,
): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      releaseEvidenceSchema.parse({
        schema_version: 'haze.nightshift.release.evidence.v1',
        slot,
        evidence_kind: 'live',
        recorded_at: new Date().toISOString(),
        bindings_sha256: hash(canonicalJson(bindings)),
        payload: payloads[slot].parse(payload),
      }),
      null,
      2,
    )}\n`,
  );
}

let buildDigest: string | undefined;
/** Hash of every compiled application module; a changed build invalidates evidence. */
export function applicationBuildDigest(
  root = dirname(dirname(fileURLToPath(import.meta.url))),
): string {
  if (buildDigest && root === dirname(dirname(fileURLToPath(import.meta.url))))
    return buildDigest;
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') visit(path);
      } else if (
        /\.(?:js|mjs|json|ts)$/u.test(entry.name) &&
        !entry.name.endsWith('.d.ts')
      )
        files.push(path);
      if (files.length > 20_000)
        throw new Error('Build digest bound exceeded.');
    }
  };
  visit(root);
  const digest = createHash('sha256');
  for (const file of files.sort()) {
    if (statSync(file).size > 16_777_216)
      throw new Error('Build file too large.');
    digest.update(relative(root, file).replaceAll('\\', '/'));
    digest.update('\0');
    digest.update(readFileSync(file));
    digest.update('\0');
  }
  const value = digest.digest('hex');
  if (root === dirname(dirname(fileURLToPath(import.meta.url))))
    buildDigest = value;
  return value;
}

/** Instructions and registered contract identities, independent of file layout. */
export function registryDigests(registry: ExecutionRegistry): {
  instructions_sha256: string;
  contracts_sha256: string;
} {
  const sorted = <T>(values: Iterable<[string, T]>) =>
    [...values].sort(([left], [right]) => left.localeCompare(right));
  return {
    instructions_sha256: hash(
      canonicalJson({
        agents: sorted(
          [...registry.agents].map(([id, agent]) => [
            id,
            { version: agent.version, instructions: agent.instructions },
          ]),
        ),
        assignments: sorted(
          [...registry.definitions].map(([id, definition]) => [
            id,
            {
              version: definition.version,
              instructions: definition.instructions,
            },
          ]),
        ),
      }),
    ),
    contracts_sha256: hash(
      canonicalJson({
        capabilities: sorted(
          [...registry.capabilities].map(([id, value]) => [
            id,
            value.card.version,
          ]),
        ),
        assignments: sorted(
          [...registry.definitions].map(([id, value]) => [
            id,
            {
              version: value.version,
              capability: value.capability,
              agent: value.agent,
              tools: [...value.tools].sort(),
              optional_tools: [...(value.optional_tools ?? [])].sort(),
            },
          ]),
        ),
        tools: sorted(
          [...registry.tools].map(([id, tool]) => [id, tool.version]),
        ),
        final_renderers: [...registry.finalRenderers.keys()].sort(),
      }),
    ),
  };
}

/** Current identities as the server sees them; null when any cannot be established. */
export async function currentReleaseBindings(options: {
  registry: ExecutionRegistry;
  modelRoutes: ModelRouteService;
  nightshiftJobs: NightshiftJobPort;
  signal?: AbortSignal;
}): Promise<ReleaseBindings | null> {
  const readiness = await options.nightshiftJobs.readiness(options.signal);
  if (
    !readiness.runtime_version ||
    !readiness.schema_hash ||
    !readiness.installation_fingerprint ||
    !readiness.roster_fingerprint ||
    !readiness.cloud_lanes?.length
  )
    return null;
  const snapshot = options.modelRoutes.snapshot();
  return releaseBindingsSchema.parse({
    build_sha256: applicationBuildDigest(),
    ...registryDigests(options.registry),
    routes: Object.fromEntries(
      Object.entries(snapshot.routes).map(([role, route]) => [
        role,
        {
          route_id: route.route_id,
          provider: route.provider,
          requested_model: route.requested_model,
        },
      ]),
    ),
    nightshift: {
      runtime_version: readiness.runtime_version,
      schema_hash: readiness.schema_hash,
      installation_fingerprint: readiness.installation_fingerprint,
      roster_fingerprint: readiness.roster_fingerprint,
      cloud_lanes: readiness.cloud_lanes,
    },
  });
}
