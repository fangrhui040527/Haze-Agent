import { useState } from 'react';
import type { AgentRun } from '../dashboard/useAgentRun.ts';
import { Button } from '../../shared/ui/Button.tsx';
import styles from './ChatPanel.module.css';
export function TaskControls({ run }: { run: AgentRun }) {
  const [revokedTools, setRevokedTools] = useState<string[]>([]);
  const record = run.task?.record;
  if (!record) return null;
  const upgrade = record.manager?.upgrade_required;
  const active = ['queued', 'running', 'waiting'].includes(record.status);
  const terminal = ['completed', 'failed', 'cancelled', 'timed_out'].includes(
    record.status,
  );
  const act = (action: 'pause' | 'cancel' | 'resume' | 'continue') =>
    void run.control(action).catch(() => {});
  return (
    <div className={styles.taskControls} aria-label="Saved task controls">
      <p>
        Task {record.status} - objective revision {record.objective_revision} -
        run {record.runs.length}
      </p>
      <div className={styles.controlButtons}>
        {active && (
          <Button
            size="small"
            onClick={() => act('pause')}
            disabled={run.operationPending}
          >
            Pause task
          </Button>
        )}
        {record.status === 'paused' && !upgrade && (
          <Button
            size="small"
            onClick={() => act('resume')}
            disabled={run.operationPending}
          >
            Resume task
          </Button>
        )}
        {!terminal && (
          <Button
            size="small"
            variant="danger"
            onClick={() => act('cancel')}
            disabled={run.operationPending}
          >
            Cancel task
          </Button>
        )}
        {(terminal || upgrade) && (
          <Button
            size="small"
            onClick={() => act('continue')}
            disabled={run.operationPending}
          >
            Continue in a new run
          </Button>
        )}
      </div>
      {upgrade && (
        <p className={styles.staleResult} role="status">
          {upgrade}
        </p>
      )}
      {record.status === 'paused' && !upgrade && (
        <p className={styles.muted}>
          Resume keeps the existing deadline and remaining budget.
        </p>
      )}
      {(terminal || upgrade) && (
        <p className={styles.muted}>
          Continuation requests a linked run with fresh bounded resources.
        </p>
      )}
      {record.permissions.tools.length > 0 && (
        <details>
          <summary>Tool permissions</summary>
          <fieldset className={styles.toolPermissions}>
            <legend>Select permissions to revoke</legend>
            {record.permissions.tools.map((tool) => (
              <label key={tool}>
                <input
                  type="checkbox"
                  checked={revokedTools.includes(tool)}
                  onChange={(event) =>
                    setRevokedTools((previous) =>
                      event.target.checked
                        ? [...previous, tool]
                        : previous.filter((item) => item !== tool),
                    )
                  }
                />{' '}
                {tool}
              </label>
            ))}
            <Button
              size="small"
              disabled={run.operationPending || revokedTools.length === 0}
              onClick={() =>
                void run
                  .control('revoke', revokedTools)
                  .then(() => setRevokedTools([]))
                  .catch(() => {})
              }
            >
              Revoke selected permissions
            </Button>
          </fieldset>
        </details>
      )}
      {run.operationPending && <p role="status">Saving task change...</p>}
      {run.receipt && (
        <p role="status">
          Requested: {run.receipt.requested}. Confirmed: {run.receipt.confirmed}
          . Remote termination is not confirmed.
        </p>
      )}
      {run.operationError && (
        <p role="alert" className={styles.cancellationError}>
          {run.operationError}
        </p>
      )}
    </div>
  );
}
