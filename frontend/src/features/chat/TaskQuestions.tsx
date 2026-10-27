import { useState, type FormEvent } from 'react';
import type { AgentRun } from '../dashboard/useAgentRun.ts';
import type { Artifact } from '../../../../app/contracts/artifacts.ts';
import { SourceImport, sourceReferences } from './SourceImport.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import styles from './ChatPanel.module.css';
export function TaskQuestions({ run }: { run: AgentRun }) {
  const record = run.task?.record;
  if (!record) return null;
  const open = record.questions.filter(
    (question) => question.status === 'open',
  );
  return (
    <div className={styles.taskQuestions}>
      {open.length > 0 && (
        <section aria-label="Questions awaiting an answer">
          <h3>Clarification needed</h3>
          <ul>
            {open.map((question) => (
              <li key={question.id}>
                <p>{question.question}</p>
                <UpdateForm
                  run={run}
                  questionId={question.id}
                  idPrefix={`answer-${question.id}`}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      <details>
        <summary>Correct or clarify this task</summary>
        <UpdateForm run={run} idPrefix="correction" />
      </details>
      {record.corrections.length > 0 && (
        <details>
          <summary>Correction history ({record.corrections.length})</summary>
          <ol>
            {record.corrections.map((correction) => (
              <li key={correction.id}>
                <strong>
                  Revision {correction.objective_revision} - {correction.kind}
                </strong>
                <p className={styles.exactPassage}>{correction.passage}</p>
                <small>
                  {correction.affected_assignment_ids.length} affected
                  assignments
                </small>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

/** One clarification (with questionId) or a free correction (without). */
function UpdateForm({
  run,
  questionId,
  idPrefix,
}: {
  run: AgentRun;
  questionId?: string;
  idPrefix: string;
}) {
  const [sources, setSources] = useState<Artifact[]>([]);
  const [passage, setPassage] = useState('');
  const [scope, setScope] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      let parsedScope;
      if (scope.trim()) parsedScope = JSON.parse(scope);
      await run.update(
        passage,
        questionId,
        parsedScope,
        sourceReferences(sources),
      );
      setPassage('');
      setScope('');
      setSources([]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The correction could not be saved.',
      );
    }
  };
  return (
    <form
      className={styles.updateForm}
      onSubmit={(event) => void submit(event)}
    >
      <label htmlFor={`${idPrefix}-passage`}>
        {questionId ? 'Your answer' : 'Exact correction passage'}
      </label>
      <textarea
        id={`${idPrefix}-passage`}
        rows={3}
        value={passage}
        onChange={(event) => setPassage(event.target.value)}
        maxLength={16000}
        required
      />
      <details>
        <summary>More options</summary>
        <label htmlFor={`${idPrefix}-scope`}>
          Revised scope (optional JSON)
        </label>
        <textarea
          id={`${idPrefix}-scope`}
          rows={2}
          value={scope}
          onChange={(event) => setScope(event.target.value)}
        />
        <SourceImport
          idPrefix={idPrefix}
          sources={sources}
          onChange={setSources}
          importSource={run.importSource}
          disabled={run.operationPending}
        />
      </details>
      <Button
        type="submit"
        size="small"
        disabled={run.operationPending || !passage.trim()}
      >
        {questionId ? 'Send answer' : 'Save correction'}
      </Button>
      {error && (
        <p role="alert" className={styles.cancellationError}>
          {error}
        </p>
      )}
    </form>
  );
}
