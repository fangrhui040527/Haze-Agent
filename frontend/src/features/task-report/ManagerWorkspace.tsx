import type { TaskRecord } from '../../../../app/contracts/tasks.ts';
import { Badge, type Tone } from '../../shared/ui/Badge.tsx';
import styles from './ManagerWorkspace.module.css';

const statusTone = (status: string): Tone => {
  if (status === 'completed') return 'ok';
  if (['failed', 'timed_out', 'stale'].includes(status)) return 'warn';
  if (status === 'running') return 'info';
  return 'neutral';
};

/** Saved Manager decisions are readback evidence, never simulated progress. */
export function ManagerWorkspace({ record }: { record: TaskRecord }) {
  const manager = record.manager;
  if (!manager || manager.run_id !== record.current_run_id) return null;
  const currentPlan = manager.plans.find(
    (plan) => plan.revision === manager.plan_revision,
  );
  const assignments = record.assignments.filter(
    (assignment) =>
      assignment.run_id === record.current_run_id &&
      currentPlan?.assignment_revisions.some(
        (reference) =>
          reference.id === assignment.id &&
          reference.revision === assignment.revision,
      ),
  );
  const interpretation = manager.interpretation;
  return (
    <section
      className={styles.workspace}
      aria-labelledby="manager-workspace-title"
    >
      <div className={styles.header}>
        <h2 id="manager-workspace-title">Manager workspace</h2>
        <Badge>Plan revision {manager.plan_revision}</Badge>
      </div>
      {interpretation && (
        <section
          className={styles.section}
          aria-labelledby="interpreted-objective-title"
        >
          <h3 id="interpreted-objective-title">Interpreted objective</h3>
          <p>{interpretation.scope}</p>
          {interpretation.deliverables.length > 0 && (
            <>
              <h4>Deliverables</h4>
              <ul>
                {interpretation.deliverables.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </>
          )}
          <details>
            <summary>Scope, assumptions and stopping conditions</summary>
            <div className={styles.detailsContent}>
              <p>
                <strong>Intended use:</strong> {interpretation.intended_use}
              </p>
              {interpretation.assumptions.length > 0 && (
                <div>
                  <h4>Assumptions</h4>
                  <ul>
                    {interpretation.assumptions.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
              {interpretation.stopping_conditions.length > 0 && (
                <div>
                  <h4>Stopping conditions</h4>
                  <ul>
                    {interpretation.stopping_conditions.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </details>
        </section>
      )}
      <section className={styles.section} aria-labelledby="current-plan-title">
        <h3 id="current-plan-title">Current work plan</h3>
        {currentPlan ? (
          <>
            <p>
              <strong>
                {currentPlan.revision > 1
                  ? 'Replanning reason:'
                  : 'Plan reason:'}
              </strong>{' '}
              {currentPlan.reason}
            </p>
            {assignments.length > 0 ? (
              <ol className={styles.assignments}>
                {assignments.map((assignment) => (
                  <li key={assignment.id}>
                    <div className={styles.assignmentHeader}>
                      <strong>{assignment.role}</strong>
                      <Badge tone={statusTone(assignment.status)}>
                        {assignment.status.replaceAll('_', ' ')}
                      </Badge>
                    </div>
                    <p>
                      {assignment.capability} · revision {assignment.revision}
                    </p>
                    {assignment.error && (
                      <p className={styles.objection}>
                        {assignment.error.message}
                      </p>
                    )}
                    {assignment.usability === 'rejected' && (
                      <div className={styles.objection}>
                        <strong>Review objection: work is rejected.</strong>
                        {assignment.gaps.length > 0 && (
                          <ul>
                            {assignment.gaps.map((gap, index) => (
                              <li key={index}>{gap}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                    <details>
                      <summary>Assignment brief and execution details</summary>
                      <div className={styles.detailsContent}>
                        <p className={styles.passage}>{assignment.brief}</p>
                        <p>
                          Evidence support: {assignment.support}. Usability:{' '}
                          {assignment.usability.replaceAll('_', ' ')}.
                        </p>
                        <p>
                          {assignment.outputs.length} work products;{' '}
                          {assignment.dependencies.length} dependencies.
                        </p>
                        {assignment.gaps.length > 0 && (
                          <ul>
                            {assignment.gaps.map((gap, index) => (
                              <li key={index}>{gap}</li>
                            ))}
                          </ul>
                        )}
                        <p className={styles.identifier}>
                          Assignment {assignment.id}
                        </p>
                      </div>
                    </details>
                  </li>
                ))}
              </ol>
            ) : (
              <p className={styles.muted}>
                {currentPlan.assignment_revisions.length > 0
                  ? 'This plan is awaiting current assignment revisions.'
                  : 'This plan has no specialist assignments.'}
              </p>
            )}
          </>
        ) : (
          <p className={styles.muted}>
            The Manager has not saved a work plan yet.
          </p>
        )}
      </section>
      <details>
        <summary>
          Manager decisions and execution details ({manager.decisions.length})
        </summary>
        <div className={styles.detailsContent}>
          {manager.decisions.length > 0 ? (
            <ol className={styles.decisions}>
              {manager.decisions.map(({ decision, created_at }) => (
                <li key={decision.id}>
                  <p className={styles.muted}>
                    {decision.action.type.replaceAll('_', ' ')} · plan revision{' '}
                    {decision.plan_revision} ·{' '}
                    <time dateTime={created_at}>{created_at}</time>
                  </p>
                  <p className={styles.passage}>{decision.explanation}</p>
                  <details>
                    <summary>Recorded decision</summary>
                    <pre className={styles.receipt}>
                      {JSON.stringify(decision, null, 2)}
                    </pre>
                  </details>
                </li>
              ))}
            </ol>
          ) : (
            <p className={styles.muted}>
              No Manager decision has been saved yet.
            </p>
          )}
          <details>
            <summary>Plan history ({manager.plans.length})</summary>
            <ol className={styles.decisions}>
              {manager.plans.map((plan) => (
                <li key={plan.revision}>
                  <strong>Plan revision {plan.revision}:</strong> {plan.reason}
                </li>
              ))}
            </ol>
          </details>
          <details>
            <summary>
              Artifact inspections ({manager.inspections.length})
            </summary>
            <pre className={styles.receipt}>
              {JSON.stringify(manager.inspections, null, 2)}
            </pre>
          </details>
          <details>
            <summary>
              Dispatch receipts ({manager.dispatch_receipts.length})
            </summary>
            <pre className={styles.receipt}>
              {JSON.stringify(manager.dispatch_receipts, null, 2)}
            </pre>
          </details>
          <p className={styles.muted}>
            {manager.pending_events.length} pending decision events. Last
            handled event: {manager.last_handled_event_cursor}.
          </p>
        </div>
      </details>
    </section>
  );
}
