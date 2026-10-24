import { useMemo } from 'react';
import {
  demoAgentExecutionSchema,
  type DemoAgentExecution,
} from '../../../../app/demo/agent-contract.ts';
import { AGENT_INFO } from '../../shared/types/agents.ts';
import styles from './ScheduleResult.module.css';

/** Revalidate persisted receipts before claiming any displayed role executed. */
export function AgentExecution({
  execution,
}: {
  execution: DemoAgentExecution;
}) {
  const parsed = useMemo(
    () => demoAgentExecutionSchema.safeParse(execution),
    [execution],
  );
  if (!parsed.success) {
    return (
      <p className={styles.issues} role="alert">
        This saved agent execution could not be validated. Send the fictional
        crew request again to load current role receipts.
      </p>
    );
  }
  return (
    <details className={styles.details}>
      <summary>Agent execution</summary>
      <div className={styles.detailBody}>
        <p>
          Live role execution · Provider: {parsed.data.provider} · Model:{' '}
          {parsed.data.model}
        </p>
        <p>
          Model commentary explains and reviews the fictional sample. The
          checked schedule below supplies the numerical comparison; these roles
          do not approve or change it.
        </p>
        <dl>
          {parsed.data.steps.map((step) => (
            <div key={step.agent}>
              <dt>
                <strong>{AGENT_INFO[step.agent].name}</strong> ·{' '}
                {step.kind === 'model' ? 'AI model' : 'Deterministic engine'}
              </dt>
              <dd>{step.summary}</dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  );
}
