import { useState, type FormEvent } from 'react';
import type { AgentRun } from '../dashboard/useAgentRun.ts';
import type { Artifact } from '../../../../app/contracts/artifacts.ts';
import { SourceImport, sourceReferences } from './SourceImport.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import styles from './ChatPanel.module.css';
export function TaskQuestions({ run }: { run: AgentRun }) {
  const record = run.task?.record;
  const [sources, setSources] = useState<Artifact[]>([]);
  const [passage, setPassage] = useState('');
  const [questionId, setQuestionId] = useState('');
  const [scope, setScope] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!record) return null;
  const open = record.questions.filter(
    (question) => question.status === 'open',
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      let parsedScope;
      if (scope.trim()) parsedScope = JSON.parse(scope);
      await run.update(
        passage,
        questionId || undefined,
        parsedScope,
        sourceReferences(sources),
      );
      setPassage('');
      setScope('');
      setQuestionId('');
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
    <div className={styles.taskQuestions}>
      {open.length > 0 && (
        <section aria-label="Questions awaiting an answer">
          <h3>Clarification needed</h3>
          <ul>
            {open.map((question) => (
              <li key={question.id}>
                <p>
                  {question.question}{' '}
                  <span className={styles.muted}>({question.kind} wait)</span>
                </p>
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => setQuestionId(question.id)}
                >
                  Answer this question
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <details open={open.length > 0}>
        <summary>Correct or clarify this task</summary>
        <form
          className={styles.updateForm}
          onSubmit={(event) => void submit(event)}
        >
          {questionId && (
            <p>
              Answering:{' '}
              {open.find((question) => question.id === questionId)?.question}
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => setQuestionId('')}
              >
                {' '}
                Submit as a correction instead
              </button>
            </p>
          )}
          <label htmlFor="task-correction">
            {questionId ? 'Your clarification' : 'Exact correction passage'}
          </label>
          <textarea
            id="task-correction"
            rows={3}
            value={passage}
            onChange={(event) => setPassage(event.target.value)}
            maxLength={16000}
            required
          />
          <label htmlFor="correction-scope">
            Revised scope (optional JSON)
          </label>
          <textarea
            id="correction-scope"
            rows={2}
            value={scope}
            onChange={(event) => setScope(event.target.value)}
          />
          <SourceImport
            idPrefix="correction"
            sources={sources}
            onChange={setSources}
            importSource={run.importSource}
            disabled={run.operationPending}
          />
          <Button
            type="submit"
            size="small"
            disabled={run.operationPending || !passage.trim()}
          >
            Save {questionId ? 'clarification' : 'correction'}
          </Button>
          {error && (
            <p role="alert" className={styles.cancellationError}>
              {error}
            </p>
          )}
        </form>
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
