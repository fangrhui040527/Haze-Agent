import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Link, useNavigate } from 'react-router';
import {
  AgentRunError,
  AgentTaskCancelledError,
} from '../../services/agents/index.ts';
import { useLocalStorageState, useNow } from '../../shared/hooks/hooks.ts';
import { isAbortError } from '../../shared/lib/delay.ts';
import { formatDuration } from '../../shared/lib/time.ts';
import { readLocal } from '../../shared/lib/store.ts';
import type {
  AgentAnswer,
  AskRequest,
  Citation,
} from '../../shared/types/agents.ts';
import { Badge } from '../../shared/ui/Badge.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Spinner } from '../../shared/ui/States.tsx';
import type { AgentRun } from '../dashboard/useAgentRun.ts';
import type { Artifact } from '../../../../app/contracts/artifacts.ts';
import { TaskResult } from './TaskResult.tsx';
import { TaskQuestions } from './TaskQuestions.tsx';
import { TaskControls } from './TaskControls.tsx';
import { ManagerWorkspace } from '../task-report/ManagerWorkspace.tsx';
import { SourceImport, sourceReferences } from './SourceImport.tsx';
import styles from './ChatPanel.module.css';

interface ChatMessage {
  id: string;
  role: 'user' | 'agents';
  at: string;
  text?: string;
  paragraphs?: string[];
  citations?: Citation[];
  source?:
    | AgentAnswer['source']
    | 'model'
    | 'template_fallback'
    | 'computed_demo'
    | 'input_required';
  /** Old browser history is retained as text, without loading retired contracts. */
  scheduling?: unknown;
  agentExecution?: unknown;
  evidence?: AgentAnswer['evidence'];
  task?: AgentAnswer['task'];
  stale?: boolean;
  state: 'pending' | 'done' | 'error' | 'cancelled' | 'task_cancelled';
  error?: string;
  retryable?: boolean;
  /** For retry. */
  question?: string;
  focusItemId?: string | null;
  idempotencyKey?: string;
  contextRefs?: AskRequest['contextRefs'];
  scope?: AskRequest['scope'];
}

const EXAMPLE_PROMPTS = [
  'Explain the main conclusions in my attached sources and identify what remains uncertain.',
  'Summarize the PM2.5 evidence available for Kuala Lumpur during 2026-10-23 to 2026-10-24, distinguish modeled values from observations, and identify coverage gaps.',
];

const SOURCE_LABEL = {
  mock_template: 'Demo answer (template)',
  template: 'Template answer from real records (no AI model connected)',
  model: 'Archived crew demo',
  template_fallback: 'Archived template answer',
  computed_demo: 'Archived crew demo',
  input_required: 'Archived input request',
  evidence_model: 'Live evidence · model synthesis',
  evidence_fixture: 'Fixture evidence · model orchestration',
} as const;

const MAX_STORED = 50;
const newId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export interface ChatPrefill {
  question: string;
  focusItemId: string | null;
}

export function ChatPanel({
  run,
  prefill,
}: {
  run: AgentRun;
  prefill: ChatPrefill | null;
}) {
  const navigate = useNavigate();
  // Saved answers stay in this browser, including text from retired demo results.
  const [messages, setMessages] = useLocalStorageState<ChatMessage[]>(
    'haze.chat.v1',
    readLocal<ChatMessage[]>('hazewatch.chat.v1', []),
  );
  const [draft, setDraft] = useState('');
  const [sources, setSources] = useState<Artifact[]>([]);
  const [scope, setScope] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [focusItemId, setFocusItemId] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement | HTMLOListElement>(null);
  // Latest messages for async callbacks (an answer can arrive after several re-renders).
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (prefill) {
      setDraft(prefill.question);
      setFocusItemId(prefill.focusItemId);
      inputRef.current?.focus();
    }
  }, [prefill]);

  // Once observed stale, a saved answer remains historical when another task is selected.
  useEffect(() => {
    const record = run.task?.record;
    if (!record) return;
    let changed = false;
    const next = messagesRef.current.map((message) => {
      const evidence = message.evidence;
      if (message.stale || !evidence || evidence.taskUrl !== run.task?.taskUrl)
        return message;
      if (
        (evidence.objectiveRevision ?? 1) < record.objective_revision ||
        (evidence.runId && evidence.runId !== record.current_run_id) ||
        evidence.result.currency === 'stale'
      ) {
        changed = true;
        return { ...message, stale: true };
      }
      return message;
    });
    if (changed) {
      messagesRef.current = next;
      setMessages(next);
    }
  }, [run.task, setMessages]);

  // Keep the newest message visible, also when a pending message turns into an answer or error.
  useEffect(() => {
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    const input = inputRef.current;
    const history = historyRef.current;
    if (!input || !history) return;

    const initialInputHeight = input.getBoundingClientRect().height;
    const initialHistoryFlex = history.style.flex;
    const initialHistoryHeight = history.getBoundingClientRect().height;
    const observer = new ResizeObserver(() => {
      const height = input.getBoundingClientRect().height;
      history.style.flex =
        height > initialInputHeight + 1
          ? `0 0 ${initialHistoryHeight}px`
          : initialHistoryFlex;
    });

    observer.observe(input);
    return () => {
      observer.disconnect();
      history.style.flex = initialHistoryFlex;
    };
  }, []);

  // Messages left "pending" from a previous visit can never finish.
  useEffect(() => {
    if (messagesRef.current.some((m) => m.state === 'pending')) {
      setMessages(
        messagesRef.current.map((m) =>
          m.state === 'pending' ? { ...m, state: 'cancelled' } : m,
        ),
      );
    }
  }, [setMessages]);

  const save = (next: ChatMessage[]) => {
    messagesRef.current = next.slice(-MAX_STORED);
    setMessages(messagesRef.current);
  };

  const send = async (
    question: string,
    focus: string | null,
    submissionKey?: string,
    savedContext?: Pick<AskRequest, 'contextRefs' | 'scope'>,
  ) => {
    const trimmed = question.trim();
    if (!trimmed || ['running', 'waiting', 'paused'].includes(run.status))
      return;
    let parsedScope;
    try {
      if (savedContext?.scope !== undefined) parsedScope = savedContext.scope;
      else if (scope.trim()) parsedScope = JSON.parse(scope);
    } catch {
      setInputError('Scope must be valid JSON. Correct it or leave it empty.');
      return;
    }
    setInputError(null);
    const pendingId = newId();
    const idempotencyKey = submissionKey ?? crypto.randomUUID();
    save([
      ...messagesRef.current,
      {
        id: newId(),
        role: 'user',
        at: new Date().toISOString(),
        text: trimmed,
        state: 'done',
      },
      {
        id: pendingId,
        role: 'agents',
        at: new Date().toISOString(),
        state: 'pending',
        question: trimmed,
        focusItemId: focus,
        idempotencyKey,
        contextRefs: savedContext?.contextRefs ?? sourceReferences(sources),
        scope: parsedScope,
      },
    ]);
    setDraft('');
    setFocusItemId(null);

    const finish = (patch: Partial<ChatMessage>) =>
      save(
        messagesRef.current.map((m) =>
          m.id === pendingId ? { ...m, ...patch } : m,
        ),
      );

    try {
      const answer = await run.ask({
        question: trimmed,
        focusItemId: focus,
        idempotencyKey,
        contextRefs: savedContext?.contextRefs ?? sourceReferences(sources),
        ...(parsedScope !== undefined ? { scope: parsedScope } : {}),
      });
      finish({
        state: 'done',
        paragraphs: answer.paragraphs,
        citations: answer.citations,
        source: answer.source,
        evidence: answer.evidence,
        task: answer.task,
      });
      // The Manager opened a task report: show it being written.
      if (answer.task)
        void navigate(`/report/${encodeURIComponent(answer.task.taskId)}`);
    } catch (error) {
      if (error instanceof AgentTaskCancelledError)
        finish({ state: 'task_cancelled' });
      else if (isAbortError(error)) finish({ state: 'cancelled' });
      else
        finish({
          state: 'error',
          error: error instanceof Error ? error.message : String(error),
          retryable: error instanceof AgentRunError ? error.retryable : true,
        });
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(draft, focusItemId);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(draft, focusItemId);
    }
  };

  const running = ['running', 'waiting', 'paused'].includes(run.status);
  const currentRecord = run.task?.record;
  const currentResultInHistory = Boolean(
    currentRecord &&
    messages.some(
      (message) =>
        message.evidence &&
        message.evidence.taskUrl === run.task?.taskUrl &&
        (message.evidence.objectiveRevision ?? 1) ===
          currentRecord.objective_revision &&
        message.evidence.runId === currentRecord.current_run_id,
    ),
  );

  return (
    <section className={styles.chat} aria-labelledby="chat-title">
      <div className={styles.header}>
        <h2 id="chat-title">Ask the agents</h2>
        {messages.length > 0 && (
          <Button
            size="small"
            variant="ghost"
            onClick={() => save([])}
            disabled={running}
          >
            Clear chat
          </Button>
        )}
      </div>

      {messages.length === 0 ? (
        <div className={styles.empty}>
          <p>
            Describe what you need to understand or investigate. Attach source
            material when useful; the agents will ask for missing information.
          </p>
          <ul className={styles.prompts}>
            {EXAMPLE_PROMPTS.map((p) => (
              <li key={p}>
                <button
                  type="button"
                  className={styles.prompt}
                  onClick={() => {
                    setDraft(p);
                    setFocusItemId(null);
                    inputRef.current?.focus();
                  }}
                  disabled={running}
                >
                  {p}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ol
          ref={listRef}
          className={styles.messages}
          role="log"
          aria-label="Conversation"
        >
          {messages.map((m) => (
            <li
              key={m.id}
              className={m.role === 'user' ? styles.user : styles.agents}
            >
              <span className={styles.who}>
                {m.role === 'user' ? 'You' : 'Agents'}
              </span>
              <MessageBody
                message={m}
                onRetry={() =>
                  m.question &&
                  void send(
                    m.question,
                    m.focusItemId ?? null,
                    m.idempotencyKey,
                    { contextRefs: m.contextRefs, scope: m.scope },
                  )
                }
                retryDisabled={running}
                stale={
                  Boolean(m.stale) ||
                  Boolean(
                    m.evidence &&
                    run.task &&
                    m.evidence.taskUrl === run.task.taskUrl &&
                    run.task.record &&
                    ((m.evidence.objectiveRevision ?? 1) <
                      run.task.record.objective_revision ||
                      (m.evidence.runId &&
                        m.evidence.runId !== run.task.record.current_run_id) ||
                      run.task.record.result?.currency === 'stale'),
                  )
                }
              />
            </li>
          ))}
        </ol>
      )}

      {run.task?.record && (
        <div className={styles.currentTask}>
          <TaskControls run={run} />
          <TaskQuestions run={run} />
          <ManagerWorkspace record={run.task.record} />
          {run.task.record.result &&
            !currentResultInHistory &&
            (run.task.record.result.currency === 'current' ||
              !messages.some(
                (message) => message.evidence?.taskUrl === run.task?.taskUrl,
              )) && (
              <TaskResult
                evidence={{
                  taskUrl: run.task.taskUrl,
                  result: run.task.record.result,
                }}
                showAnswer
              />
            )}
        </div>
      )}
      <SourceImport
        sources={sources}
        onChange={setSources}
        importSource={run.importSource}
        disabled={running}
      />
      <details className={styles.scopeInput}>
        <summary>Optional task scope</summary>
        <label htmlFor="task-scope">
          Scope as JSON, interpreted by the selected capability
        </label>
        <textarea
          id="task-scope"
          rows={2}
          value={scope}
          onChange={(event) => setScope(event.target.value)}
          disabled={running}
        />
      </details>
      {inputError && (
        <p role="alert" className={styles.cancellationError}>
          {inputError}
        </p>
      )}
      <form className={styles.form} onSubmit={onSubmit}>
        <label htmlFor="chat-input" className="visually-hidden">
          Your question
        </label>
        <textarea
          id="chat-input"
          ref={inputRef}
          rows={2}
          value={draft}
          placeholder="Type a question… (Enter to send, Shift+Enter for a new line)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={16000}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={running || draft.trim() === ''}
        >
          Send
        </Button>
      </form>
      {focusItemId && (
        <p className={styles.focusNote}>
          Asking about one item.{' '}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => setFocusItemId(null)}
          >
            Ask generally instead
          </button>
        </p>
      )}

      {run.capabilities.length > 0 && (
        <details className={styles.capabilities}>
          <summary>Available capabilities</summary>
          <ul>
            {run.capabilities.map((capability) => (
              <li key={capability.id}>
                <strong>{capability.id}</strong> ? {capability.readiness}
                <p>{capability.purpose}</p>
                <ul>
                  {capability.limitations.map((limitation, index) => (
                    <li key={index}>{limitation}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      )}
      {run.capabilitiesError && (
        <p className={styles.muted}>{run.capabilitiesError}</p>
      )}
      <StatusLine run={run} />
    </section>
  );
}

function MessageBody({
  message: m,
  onRetry,
  retryDisabled,
  stale,
}: {
  message: ChatMessage;
  onRetry: () => void;
  retryDisabled: boolean;
  stale: boolean;
}) {
  if (m.role === 'user') return <p className={styles.bubble}>{m.text}</p>;
  if (m.state === 'pending')
    return (
      <p className={`${styles.bubble} ${styles.pending}`}>
        <Spinner /> Working on it…
      </p>
    );
  if (m.state === 'cancelled')
    return (
      <p className={`${styles.bubble} ${styles.muted}`}>
        Stopped waiting. Any admitted evidence task remains saved on the server.
      </p>
    );
  if (m.state === 'task_cancelled')
    return (
      <p className={`${styles.bubble} ${styles.muted}`}>
        The server cancelled this task. Saved artifacts remain available.
      </p>
    );
  if (m.state === 'error')
    return (
      <div className={`${styles.bubble} ${styles.error}`} role="alert">
        <p>The agents couldn't answer: {m.error}</p>
        {m.retryable && m.question && (
          <Button size="small" onClick={onRetry} disabled={retryDisabled}>
            Retry
          </Button>
        )}
      </div>
    );
  return (
    <div className={styles.bubble}>
      {(m.scheduling !== undefined || m.agentExecution !== undefined) && (
        <p className={styles.source}>
          Archived crew demo. Saved text is retained; structured scheduling
          details are no longer available.
        </p>
      )}
      {m.paragraphs?.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
      {m.evidence?.result?.schema_version === 'haze.task.result.v3' && (
        <TaskResult evidence={m.evidence} stale={stale} />
      )}
      {m.task && (
        <p>
          <Link to={`/report/${encodeURIComponent(m.task.taskId)}`}>
            Open the report: {m.task.title}
          </Link>
        </p>
      )}
      {m.citations && m.citations.length > 0 && (
        <p className={styles.citations}>
          Sources:{' '}
          {m.citations.map((c, i) =>
            c.href ? (
              <a
                key={i}
                href={c.href}
                target="_blank"
                rel="noreferrer"
                className={styles.citation}
                title={c.sha256 ? `SHA-256 ${c.sha256}` : undefined}
              >
                [{c.id ?? i + 1}] {c.label}
              </a>
            ) : c.itemId ? (
              <Link
                key={i}
                to={`/item/${encodeURIComponent(c.itemId)}`}
                className={styles.citation}
              >
                [{i + 1}] {c.label}
              </Link>
            ) : (
              <span key={i} className={styles.citation}>
                [{i + 1}] {c.label}
              </span>
            ),
          )}
        </p>
      )}
      {m.source && (
        <p className={styles.source}>
          <Badge tone={m.source === 'evidence_model' ? 'info' : 'neutral'}>
            {SOURCE_LABEL[m.source]}
          </Badge>
        </p>
      )}
    </div>
  );
}

/** The always-visible text version of what the agents are doing (screen-reader friendly). */
function StatusLine({ run }: { run: AgentRun }) {
  const observing = ['running', 'waiting', 'paused'].includes(run.status);
  const now = useNow(observing ? 1000 : 60_000);
  const running = observing;
  const task = run.events.findLast((event) => event.type === 'task_event');
  const baseUrl: unknown = import.meta.env.VITE_API_BASE_URL;
  const savedTaskUrl =
    run.task?.taskUrl ??
    (task
      ? `${typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : ''}/api/tasks/${task.receipt.task_id}`
      : undefined);
  return (
    <div
      className={`${styles.status} ${run.status === 'failed' ? styles.statusFailed : ''}`}
    >
      {running && <Spinner />}
      <span aria-live="polite" className={styles.statusText}>
        {run.statusText}
      </span>
      {running && run.startedAt !== null && (
        <span className={styles.elapsed} aria-hidden="true">
          {formatDuration(now - run.startedAt)}
        </span>
      )}
      {running && (
        <Button size="small" variant="ghost" onClick={run.cancel}>
          Stop waiting
        </Button>
      )}
      {run.operationError && !run.task?.record && (
        <p role="alert" className={styles.cancellationError}>
          {run.operationError}
        </p>
      )}
      {savedTaskUrl && (
        <a
          href={savedTaskUrl}
          target="_blank"
          rel="noreferrer"
          className={styles.citation}
        >
          Saved task
        </a>
      )}
      {run.task && (
        <Link to={`/task/${encodeURIComponent(run.task.id)}`}>
          Open task report
        </Link>
      )}
    </div>
  );
}
