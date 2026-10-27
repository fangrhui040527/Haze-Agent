import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNightshiftReleasePolicy,
  loadRelease,
  NVIDIA_ULTRA_MODEL,
  publishNightshiftRelease,
  releaseEvidenceRecord,
  RELEASE_DIRECTORY,
  RELEASE_EVIDENCE_SLOTS,
  type ReleaseBindings,
  type ReleaseEvidenceSlot,
} from '../../app/tasks/nightshift-release.js';
import {
  automaticReadinessSchema,
  INITIAL_AUTOMATIC_SCOPE,
  type AutomaticScope,
} from '../../app/contracts/nightshift-automatic.js';
import { TaskStore } from '../../app/tasks/store.js';
import { taskRequestSchema, type TaskRecord } from '../../app/contracts/tasks.js';

const identity = { principal: 'local-user', workspace: 'local-workspace' };
const directories: string[] = [];
const stores: TaskStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) if (store.db.isOpen) store.close();
  for (const directory of directories.splice(0)) {
    const local = relative(resolve(tmpdir()), resolve(directory));
    if (!local || local.startsWith('..')) throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), 'haze-release-'));
  directories.push(directory);
  return directory;
};
const digest = (character: string) => character.repeat(64);
const exactRef = (artifact: { id: string; version: number; sha256: string }) => ({
  id: artifact.id,
  version: artifact.version,
  sha256: artifact.sha256,
});
const route = (model: string) => ({
  route_id: `nvidia-${model}`,
  provider: 'nvidia',
  requested_model: model,
});
function bindings(overrides: Partial<ReleaseBindings> = {}): ReleaseBindings {
  return {
    build_sha256: digest('a'),
    instructions_sha256: digest('b'),
    contracts_sha256: digest('c'),
    routes: {
      Manager: route(NVIDIA_ULTRA_MODEL),
      EvidenceCritic: route(NVIDIA_ULTRA_MODEL),
      DamageAccountant: route(NVIDIA_ULTRA_MODEL),
      HazeOps: route('nvidia/nemotron-3.5-lightning-30b-a3b'),
    },
    nightshift: {
      runtime_version: '1.2.1',
      schema_hash: digest('d'),
      installation_fingerprint: digest('e'),
      roster_fingerprint: digest('f'),
    },
    ...overrides,
  };
}
const outputs = [digest('1'), digest('2'), digest('3')];
function payloads(
  evaluationSha: string,
): Record<ReleaseEvidenceSlot, Record<string, unknown>> {
  const demonstration = {
    task_id: randomUUID(),
    status: 'completed',
    completion: 'full',
    review_status: 'supported',
    answer_rendered: true,
    model_calls_by_role: { Manager: 3, EvidenceCritic: 1 },
    artifacts: [digest('9')],
    restart_readback: true,
  };
  return {
    role_evaluation: {
      evaluator: 'role-evaluation-runner',
      passed: true,
      scenarios: 3,
      outputs: (['Manager', 'EvidenceCritic', 'DamageAccountant'] as const).map(
        (role, index) => ({
          role,
          scenario: `scenario-${index}`,
          passed: true,
          output_sha256: outputs[index],
          response_model: NVIDIA_ULTRA_MODEL,
        }),
      ),
      model_calls_by_role: { Manager: 1, EvidenceCritic: 1, DamageAccountant: 1 },
    },
    independent_review: {
      reviewer: 'separate-human-reviewer',
      verdict: 'supported',
      reviewed_evaluation_sha256: evaluationSha,
      reviewed_output_sha256s: outputs,
      findings: [],
    },
    pm25_demonstration: {
      ...demonstration,
      workflow: 'pm25',
      data_origin: 'external_source',
    },
    damage_demonstration: {
      ...demonstration,
      workflow: 'damage-accounting',
      data_origin: 'supplied',
    },
    cloud_generation: {
      job_id: randomUUID(),
      remote_id: 'remote-1',
      privacy: 'cloud-ok',
      execution_state: 'completed',
      attempts: [{ lane: 'nvidia-cloud', model: 'runtime-selected' }],
      review_status: 'unreviewed',
    },
    wait_wakeup: {
      wait_id: randomUUID(),
      parked: true,
      capacity_released: true,
      completion_captured: true,
      woke: true,
      candidate_reviewed: true,
    },
    interactive_latency: {
      background_active: true,
      samples_ms: [1200, 3400],
      gate_ms: 90_000,
    },
    automatic_chain: {
      chain_id: randomUUID(),
      opted_in: true,
      successors_admitted: 1,
      grant: {
        privacy: 'cloud-ok',
        total_runs: 2,
        automatic_followup_runs: 1,
        max_jobs: 2,
        max_attempts: 2,
        lifetime_seconds: 1800,
      },
    },
    crash_restart: {
      restart_verified: true,
      identities_preserved: true,
      accounting_preserved: true,
      results_preserved: true,
    },
  };
}
function evidence(
  current = bindings(),
  change: (
    values: Record<ReleaseEvidenceSlot, Record<string, unknown>>,
  ) => void = () => undefined,
) {
  const evaluation = releaseEvidenceRecord(
    'role_evaluation',
    current,
    payloads('0'.repeat(64)).role_evaluation,
  );
  const values = payloads(
    createHash('sha256').update(evaluation).digest('hex'),
  );
  change(values);
  return Object.fromEntries(
    RELEASE_EVIDENCE_SLOTS.map((slot) => [
      slot,
      slot === 'role_evaluation'
        ? evaluation
        : releaseEvidenceRecord(slot, current, values[slot]),
    ]),
  ) as Record<ReleaseEvidenceSlot, Buffer>;
}
function publish(
  directory: string,
  options: {
    current?: ReleaseBindings;
    scope?: AutomaticScope;
    files?: Record<ReleaseEvidenceSlot, Buffer>;
  } = {},
) {
  const current = options.current ?? bindings();
  return publishNightshiftRelease({
    stateDirectory: directory,
    bindings: current,
    scope: options.scope ?? structuredClone(INITIAL_AUTOMATIC_SCOPE),
    evidence: options.files ?? evidence(current),
  });
}
const policy = (directory: string, current: ReleaseBindings | null = bindings()) =>
  createNightshiftReleasePolicy({
    stateDirectory: directory,
    bindings: () => Promise.resolve(current),
  })();

describe('production Nightshift release evidence', () => {
  it('stays blocked without an installed manifest', async () => {
    const readiness = await policy(temporary());
    expect(readiness).toMatchObject({ released: false, ready: false });
    expect(readiness.reason).toContain('No production');
  });
  it('loads atomically published live evidence without injection', async () => {
    const directory = temporary();
    const manifest = publish(directory);
    const readiness = automaticReadinessSchema.parse(await policy(directory));
    expect(readiness).toMatchObject({
      schema_version: 'haze.nightshift.automatic.readiness.v2',
      released: true,
      ready: true,
      evidence_kind: 'live',
      evidence_id: `release:${manifest.release_id}`,
      scope: INITIAL_AUTOMATIC_SCOPE,
    });
    expect(readiness.gates.every((gate) => gate.passed)).toBe(true);
  });
  it('rejects altered evidence hashes after publication', async () => {
    const directory = temporary();
    const manifest = publish(directory);
    const path = join(
      directory,
      RELEASE_DIRECTORY,
      'evidence',
      `${manifest.evidence.crash_restart}.json`,
    );
    writeFileSync(path, readFileSync(path, 'utf8').replace('true', 'false'));
    const readiness = await policy(directory);
    expect(readiness.released).toBe(false);
    expect(readiness.reason).toContain('hash does not match');
  });
  it('rejects fixture evidence even when it is otherwise complete', async () => {
    const directory = temporary();
    const files = evidence();
    files.cloud_generation = Buffer.from(
      files.cloud_generation
        .toString('utf8')
        .replace('"evidence_kind": "live"', '"evidence_kind": "fixture"'),
    );
    expect(() => publish(directory, { files })).toThrow(
      'not retained live release evidence',
    );
    expect(loadRelease(directory)).toBeNull();
  });
  it('requires a separate independent review of the exact outputs', () => {
    expect(() =>
      publish(temporary(), {
        files: evidence(bindings(), (values) => {
          values.independent_review.reviewer = 'role-evaluation-runner';
        }),
      }),
    ).toThrow('separate independent reviewer');
    expect(() =>
      publish(temporary(), {
        files: evidence(bindings(), (values) => {
          values.independent_review.reviewed_output_sha256s = [outputs[0]];
        }),
      }),
    ).toThrow('exact evaluated outputs');
  });
  it('invalidates release evidence when routes, build or roster change', async () => {
    const directory = temporary();
    publish(directory);
    const stale = await policy(
      directory,
      bindings({
        routes: {
          ...bindings().routes,
          Manager: route('nvidia/nemotron-3.5-lightning-30b-a3b'),
        },
      }),
    );
    expect(stale.released).toBe(false);
    expect(stale.reason).toContain('routes');
    const rebuilt = await policy(
      directory,
      bindings({
        build_sha256: digest('0'),
        nightshift: { ...bindings().nightshift, roster_fingerprint: digest('0') },
      }),
    );
    expect(rebuilt.reason).toContain('build, roster');
  });
  it('requires the exact Ultra model on strict role routes', () => {
    const current = bindings({
      routes: {
        ...bindings().routes,
        EvidenceCritic: route('nvidia/nemotron-3.5-lightning-30b-a3b'),
      },
    });
    expect(() =>
      publish(temporary(), { current, files: evidence(current) }),
    ).toThrow(NVIDIA_ULTRA_MODEL);
  });
  it('rejects local-only grants, excessive limits and slow interactive latency', () => {
    expect(() =>
      publish(temporary(), {
        files: evidence(bindings(), (values) => {
          (values.automatic_chain.grant as { privacy: string }).privacy =
            'local-only';
        }),
      }),
    ).toThrow(/privacy/u);
    expect(() =>
      publish(temporary(), {
        scope: { ...structuredClone(INITIAL_AUTOMATIC_SCOPE), max_total_runs: 3 },
      }),
    ).toThrow('exceeds the supported initial automatic release');
    expect(() =>
      publish(temporary(), {
        files: evidence(bindings(), (values) => {
          (values.automatic_chain.grant as { total_runs: number }).total_runs =
            3;
        }),
      }),
    ).toThrow('exceeds the released scope');
    expect(() =>
      publish(temporary(), {
        files: evidence(bindings(), (values) => {
          values.interactive_latency.samples_ms = [91_000];
        }),
      }),
    ).toThrow('90-second gate');
  });
});

describe('released automatic scope enforcement', () => {
  function fixture() {
    const directory = temporary();
    const store = new TaskStore(directory, { recover: false });
    stores.push(store);
    store.nightshift.configureAutomatic({
      enabled: true,
      evidence_id: 'release:test',
      scope: structuredClone(INITIAL_AUTOMATIC_SCOPE),
    });
    const changed = store.importArtifact(
      {
        schema_version: 'haze.artifact.import.v3',
        filename: 'changed.txt',
        media_type: 'text/plain',
        content_base64: Buffer.from('Changed source facts.').toString(
          'base64',
        ),
      },
      identity,
      randomUUID(),
    ).artifact;
    const ref = store.importArtifact(
      {
        schema_version: 'haze.artifact.import.v3',
        filename: 'source.txt',
        media_type: 'text/plain',
        content_base64: Buffer.from('Observed source facts.').toString(
          'base64',
        ),
      },
      identity,
      randomUUID(),
    ).artifact;
    const task = store.admit(
      taskRequestSchema.parse({
        schema_version: 'haze.task.request.v3',
        objective: 'Prepare a bounded evidence-linked draft.',
        context_refs: [exactRef(ref), exactRef(changed)],
        nightshift_tools: [
          'nightshift.submit',
          'nightshift.result',
          'nightshift.cancel',
        ],
      }),
      identity,
      randomUUID(),
      {
        tools: ['nightshift.submit', 'nightshift.result', 'nightshift.cancel'],
        limits: {
          deadline: new Date(Date.now() + 60_000).toISOString(),
          max_model_calls: 8,
          max_tool_calls: 8,
          max_assignments: 8,
          max_artifacts: 16,
        },
      },
    ).task;
    const authority = (value: TaskRecord) => ({
      expected_run_id: value.current_run_id,
      expected_generation: value.generation,
      expected_objective_revision: value.objective_revision,
      expected_state_revision: value.state_revision,
    });
    const request = {
      schema_version: 'haze.nightshift.chain.admission.v2',
      task_id: task.id,
      ...authority(task),
      total_runs: 2,
      automatic_followup_runs: 1,
      max_jobs: 2,
      max_attempts: 2,
      lifetime_seconds: 1800,
      automatic_opt_in: true,
      initial_progress: {
        schema_version: 'haze.nightshift.progress.v1',
        purpose: 'evidence_linked_draft',
        instruction: 'Prepare an unreviewed draft.',
        input_refs: [exactRef(ref)],
      },
      privacy: 'cloud-ok',
      max_spend_usd: null,
    };
    return {
      store,
      task,
      request,
      authority,
      ref: exactRef(ref),
      changed: exactRef(changed),
    };
  }
  it.each([
    ['local-only grants', { privacy: 'local-only', max_spend_usd: 0 }],
    ['three total runs', { total_runs: 3 }],
    ['three jobs', { max_jobs: 3 }],
    ['a lifetime over thirty minutes', { lifetime_seconds: 1801 }],
  ])('rejects %s at admission', (_label, change) => {
    const { store, request } = fixture();
    expect(() =>
      store.nightshift.admitChain(
        { ...request, ...change },
        randomUUID(),
        identity,
      ),
    ).toThrow('released automatic scope does not cover');
  });
  it('admits the bounded scope and limits attempts and concurrency per job', () => {
    const { store, task, request, authority, ref, changed } = fixture();
    const chain = store.nightshift.admitChain(
      request,
      randomUUID(),
      identity,
    ).chain;
    const submit = (n: number, inputs = [ref]) =>
      store.nightshift.reserveJob(
        {
          schema_version: 'haze.nightshift.job.submit.v1',
          chain_id: chain.id,
          ...authority(store.read(task.id, identity)),
          expected_chain_revision: store.nightshift.chain(chain.id, identity)
            .revision,
          prompt: 'Unreviewed candidate.',
          purpose: 'evidence_linked_draft',
          input_refs: inputs,
          n,
          privacy: 'cloud-ok',
          max_spend_usd: null,
        },
        randomUUID(),
        identity,
        {
          adapter_version: 'fixture',
          runtime_version: 'fixture',
          schema_hash: 'fixture',
        },
      );
    expect(() => submit(2)).toThrow('1 attempt(s) per job');
    const first = submit(1).job;
    store.nightshift.acknowledge(first.id, `remote-${first.id}`);
    // Changed exact inputs pass the no-progress fence; concurrency still holds.
    store.nightshift.proposeProgress(
      chain.id,
      {
        schema_version: 'haze.nightshift.chain.progress.proposal.v1',
        ...authority(store.read(task.id, identity)),
        expected_chain_revision: store.nightshift.chain(chain.id, identity)
          .revision,
        progress: {
          schema_version: 'haze.nightshift.progress.v1',
          purpose: 'evidence_linked_draft',
          instruction: 'Prepare an unreviewed draft from changed evidence.',
          input_refs: [changed],
        },
      },
      randomUUID(),
      identity,
      'user',
    );
    expect(() => submit(1, [changed])).toThrow('1 concurrent native job(s)');
  });
});
