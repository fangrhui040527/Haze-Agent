import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Artifact } from '../../app/contracts/artifacts.js';
import type { TaskRecord } from '../../app/contracts/tasks.js';
import { validateDomainDemonstration } from '../../app/release/nightshift-domain-evidence.js';
import type { ReleaseBindings } from '../../app/release/nightshift-release.js';
import { domainDemonstrationFixture } from '../fixtures/nightshift-domain-evidence.js';

const exactModel = 'nvidia/nemotron-3-ultra-550b-a55b';
const bindings: ReleaseBindings = {
  build_sha256: 'a'.repeat(64),
  instructions_sha256: 'b'.repeat(64),
  contracts_sha256: 'c'.repeat(64),
  nightshift: {
    runtime_version: 'unit',
    schema_hash: 'd'.repeat(64),
    installation_fingerprint: 'e'.repeat(64),
    roster_fingerprint: 'f'.repeat(64),
    cloud_lanes: [],
  },
  routes: {
    Manager: {
      route_id: 'verified-manager',
      provider: 'nightshift',
      requested_model: exactModel,
    },
  },
};
type Workflow = 'pm25' | 'damage-accounting' | 'damage-reduction';
type Demonstration = ReturnType<typeof domainDemonstrationFixture>;
interface Report {
  bindings_sha256: string;
  mode: string;
  passed: boolean;
  restart: boolean;
  restart_task: TaskRecord;
  task?: TaskRecord;
  artifacts?: Artifact[];
  capture?: { task: TaskRecord; artifacts: Artifact[] };
  investigation?: { task: TaskRecord; artifacts: Artifact[] };
  attempts: {
    kind: string;
    details: { requested_route?: { route_id: string } };
    receipt?: { synthetic?: boolean };
  }[];
}
function change(demonstration: Demonstration, edit: (report: Report) => void) {
  const report = JSON.parse(demonstration.retained_report.bytes) as Report;
  edit(report);
  const bytes = JSON.stringify(report);
  demonstration.retained_report = {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
function capture(report: Report) {
  return (
    report.investigation ??
    report.capture ?? {
      task: report.task!,
      artifacts: report.artifacts!,
    }
  );
}
const validate = (demonstration: Demonstration, workflow: Workflow = 'pm25') =>
  validateDomainDemonstration(demonstration, workflow, bindings, exactModel);

describe('retained live domain release evidence', () => {
  it.each(['pm25', 'damage-accounting', 'damage-reduction'] as const)(
    'checks exact retained %s outputs with zero-call deterministic reviewers',
    (workflow) => {
      const demonstration = domainDemonstrationFixture(
        workflow,
        bindings,
        exactModel,
      );
      expect(demonstration.model_calls_by_role.EvidenceCritic ?? 0).toBe(0);
      expect(() => validate(demonstration, workflow)).not.toThrow();
    },
  );
  it('rejects asserted completion without a retained report', () => {
    const demonstration = domainDemonstrationFixture(
      'pm25',
      bindings,
      exactModel,
    );
    Reflect.deleteProperty(demonstration, 'retained_report');
    expect(() => validate(demonstration)).toThrow();
  });
  it('rejects modified report bytes and nonexistent artifact hashes', () => {
    const demonstration = domainDemonstrationFixture(
      'pm25',
      bindings,
      exactModel,
    );
    demonstration.retained_report.bytes += ' ';
    expect(() => validate(demonstration)).toThrow('report bytes');
    const missing = domainDemonstrationFixture('pm25', bindings, exactModel);
    missing.artifacts = ['a'.repeat(64)];
    expect(() => validate(missing)).toThrow('no retained bytes');
  });
  it('rejects fixture mode and a changed restart result', () => {
    const fixture = domainDemonstrationFixture('pm25', bindings, exactModel);
    change(fixture, (report) => {
      report.mode = 'fixture';
    });
    expect(() => validate(fixture)).toThrow('live report');
    const changed = domainDemonstrationFixture('pm25', bindings, exactModel);
    change(changed, (report) => {
      report.restart_task.result!.answer += ' invented';
    });
    expect(() => validate(changed)).toThrow('restart readback');
  });
  it('rejects a report captured for an older build or instruction snapshot', () => {
    const demonstration = domainDemonstrationFixture(
      'pm25',
      bindings,
      exactModel,
    );
    change(demonstration, (report) => {
      report.bindings_sha256 = '0'.repeat(64);
    });
    expect(() => validate(demonstration)).toThrow('frozen release bindings');
  });
  it('hash-checks artifact contents rather than trusting a supported label', () => {
    const demonstration = domainDemonstrationFixture(
      'pm25',
      bindings,
      exactModel,
    );
    change(demonstration, (report) => {
      capture(report).artifacts[0]!.content = 'altered';
    });
    expect(() => validate(demonstration)).toThrow('artifact content');
  });
  it('rejects stale applicability and producer self-review', () => {
    const stale = domainDemonstrationFixture('pm25', bindings, exactModel);
    change(stale, (report) => {
      const task = capture(report).task;
      task.artifacts.forEach((entry) => {
        entry.current = false;
      });
      report.restart_task = structuredClone(task);
    });
    expect(() => validate(stale)).toThrow('stale or inapplicable');
    const self = domainDemonstrationFixture('pm25', bindings, exactModel);
    change(self, (report) => {
      const task = capture(report).task;
      const check = task.result!.review.checks![0]!;
      check.reviewer_assignment_id = check.producer_assignment_id;
      report.restart_task = structuredClone(task);
    });
    expect(() => validate(self)).toThrow('independent exact');
  });
  it('rejects synthetic receipts, stale routes and fabricated role call counts', () => {
    const synthetic = domainDemonstrationFixture('pm25', bindings, exactModel);
    change(synthetic, (report) => {
      report.attempts.find(
        (entry) => entry.kind === 'model',
      )!.receipt!.synthetic = true;
    });
    expect(() => validate(synthetic)).toThrow();
    const route = domainDemonstrationFixture('pm25', bindings, exactModel);
    change(route, (report) => {
      report.attempts.find(
        (entry) => entry.kind === 'model',
      )!.details.requested_route!.route_id = 'old-route';
    });
    expect(() => validate(route)).toThrow('exact released route');
    const counts = domainDemonstrationFixture('pm25', bindings, exactModel);
    counts.model_calls_by_role.Manager++;
    expect(() => validate(counts)).toThrow('charged raw attempts');
  });
  it('requires a retained successful PM2.5 source execution', () => {
    const demonstration = domainDemonstrationFixture(
      'pm25',
      bindings,
      exactModel,
    );
    change(demonstration, (report) => {
      report.attempts = report.attempts.filter(
        (entry) => entry.kind !== 'tool',
      );
    });
    expect(() => validate(demonstration)).toThrow('Zetaris query/raw rows');
  });
  it('reconstructs the conditional plan against the exact operator candidate', () => {
    const demonstration = domainDemonstrationFixture(
      'damage-reduction',
      bindings,
      exactModel,
    );
    change(demonstration, (report) => {
      const task = capture(report).task;
      const scope = task.original_request.scope as {
        candidate: { id: string };
      };
      scope.candidate.id = 'different-operator-candidate';
      report.restart_task = structuredClone(task);
    });
    expect(() => validate(demonstration, 'damage-reduction')).toThrow(
      'conditional plan',
    );
  });
  it.each(['pm25', 'damage-accounting', 'damage-reduction'] as const)(
    'rejects an invented saved %s answer even when its workflow prefix and evidence remain valid',
    (workflow) => {
      const demonstration = domainDemonstrationFixture(
        workflow,
        bindings,
        exactModel,
      );
      change(demonstration, (report) => {
        const task = capture(report).task;
        task.result!.answer += '\nInvented reviewed total: 987654321.';
        report.restart_task = structuredClone(task);
      });
      expect(() => validate(demonstration, workflow)).toThrow(
        'exact deterministic reviewed rendering',
      );
    },
  );
  it.each(['damage-accounting', 'damage-reduction'] as const)(
    'rejects synthetic originals in a claimed supplied %s demonstration',
    (workflow) => {
      const demonstration = domainDemonstrationFixture(
        workflow,
        bindings,
        exactModel,
      );
      change(demonstration, (report) => {
        for (const artifact of capture(report).artifacts)
          if (artifact.producer.kind === 'user')
            artifact.evidence_origin = 'synthetic_fixture';
      });
      expect(() => validate(demonstration, workflow)).toThrow();
    },
  );
});
