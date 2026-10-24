import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Link } from 'react-router';
import {
  AgentRunError,
  KLANG_CREW_EXAMPLE,
} from '../../services/agents/index.ts';
import { useLocalStorageState, useNow } from '../../shared/hooks/hooks.ts';
import { isAbortError } from '../../shared/lib/delay.ts';
import { formatDuration } from '../../shared/lib/time.ts';
import type { AgentAnswer, Citation } from '../../shared/types/agents.ts';
import { Badge } from '../../shared/ui/Badge.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Spinner } from '../../shared/ui/States.tsx';
import type { AgentRun } from '../dashboard/useAgentRun.ts';
import styles from './ChatPanel.module.css';

const ScheduleResult = lazy(() =>
  import('./ScheduleResult.tsx').then((module) => ({
    default: module.ScheduleResult,
  })),
);
const AgentExecution = lazy(() =>
  import('./AgentExecution.tsx').then((module) => ({
    default: module.AgentExecution,
  })),
);

interface ChatMessage {
  id: string;
  role: 'user' | 'agents';
  at: string;
  text?: string;
  paragraphs?: string[];
  citations?: Citation[];
  source?: AgentAnswer['source'];
  scheduling?: AgentAnswer['scheduling'];
  agentExecution?: AgentAnswer['agentExecution'];
  state: 'pending' | 'done' | 'error' | 'cancelled';
  error?: string;
  retryable?: boolean;
  /** For retry. */
  question?: string;
  focusItemId?: string | null;
}

const EXAMPLE_PROMPTS = [
  KLANG_CREW_EXAMPLE,
  "What's the haze situation in Kuala Lumpur?",
  'Compare Kuala Lumpur and Johor Bahru today',
  'Will the haze in Kuching get worse tomorrow?',
  'Is it safe to run outside in Shah Alam?',
  "What's driving haze in Pekanbaru?",
  'What changed in the last few hours?',
];

const SOURCE_LABEL = {
  mock_template: 'Demo answer (template)',
  model: 'AI model answer',
  template_fallback: 'Template fallback (AI unavailable)',
  computed_demo: 'Computed fictional sample · no AI model run',
  input_required: 'Planning input needed',
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
  // History, including live role receipts, stays in this browser.
  const [messages, setMessages] = useLocalStorageState<ChatMessage[]>(
    'hazewatch.chat.v1',
    [],
  );
  const [draft, setDraft] = useState('');
  const [focusItemId, setFocusItemId] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
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

  // Keep the newest message visible, also when a pending message turns into an answer or error.
  useEffect(() => {
    const list = listRef.current;
    if (list) {
      const newest = list.lastElementChild as HTMLElement | null;
      // A schedule is taller than the chat viewport: start at its summary.
      list.scrollTop =
        messages.at(-1)?.scheduling && newest
          ? newest.offsetTop - list.offsetTop
          : list.scrollHeight;
    }
  }, [messages]);

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

  const send = async (question: string, focus: string | null) => {
    const trimmed = question.trim();
    if (!trimmed || run.status === 'running') return;
    const pendingId = newId();
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
      const answer = await run.ask({ question: trimmed, focusItemId: focus });
      finish({
        state: 'done',
        paragraphs: answer.paragraphs,
        citations: answer.citations,
        source: answer.source,
        scheduling: answer.scheduling,
        agentExecution: answer.agentExecution,
      });
    } catch (error) {
      if (isAbortError(error)) finish({ state: 'cancelled' });
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

  const running = run.status === 'running';

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
            Ask about haze in the demo data or compare the fictional Klang crew
            schedule. Try:
          </p>
          <ul className={styles.prompts}>
            {EXAMPLE_PROMPTS.map((p) => (
              <li key={p}>
                <button
                  type="button"
                  className={styles.prompt}
                  onClick={() => void send(p, null)}
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
          className={`${styles.messages} ${messages.some((m) => m.scheduling) ? styles.withSchedule : ''}`}
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
                  m.question && void send(m.question, m.focusItemId ?? null)
                }
                retryDisabled={running}
              />
            </li>
          ))}
        </ol>
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
          maxLength={500}
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

      <StatusLine run={run} />
    </section>
  );
}

function MessageBody({
  message: m,
  onRetry,
  retryDisabled,
}: {
  message: ChatMessage;
  onRetry: () => void;
  retryDisabled: boolean;
}) {
  if (m.role === 'user') return <p className={styles.bubble}>{m.text}</p>;
  if (m.state === 'pending')
    return (
      <p className={`${styles.bubble} ${styles.pending}`}>
        <Spinner /> Working on it…
      </p>
    );
  if (m.state === 'cancelled')
    return <p className={`${styles.bubble} ${styles.muted}`}>Cancelled.</p>;
  if (m.state === 'error')
    return (
      <div className={`${styles.bubble} ${styles.error}`} role="alert">
        <p>Sorry, the agents couldn't answer: {m.error}</p>
        {m.retryable && m.question && (
          <Button size="small" onClick={onRetry} disabled={retryDisabled}>
            Retry
          </Button>
        )}
      </div>
    );
  return (
    <div className={styles.bubble}>
      {m.agentExecution && (
        <p className={styles.source}>
          AI model commentary on the fictional sample
        </p>
      )}
      {m.paragraphs?.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
      {m.agentExecution && (
        <Suspense fallback={<p role="status">Loading agent execution…</p>}>
          <AgentExecution execution={m.agentExecution} />
        </Suspense>
      )}
      {m.scheduling && (
        <Suspense fallback={<p role="status">Loading schedule result…</p>}>
          <ScheduleResult response={m.scheduling} />
        </Suspense>
      )}
      {m.citations && m.citations.length > 0 && (
        <p className={styles.citations}>
          Sources:{' '}
          {m.citations.map((c, i) =>
            c.itemId ? (
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
          <Badge tone={m.source === 'model' ? 'info' : 'neutral'}>
            {SOURCE_LABEL[m.source]}
          </Badge>
        </p>
      )}
    </div>
  );
}

/** The always-visible text version of what the agents are doing (screen-reader friendly). */
function StatusLine({ run }: { run: AgentRun }) {
  const now = useNow(run.status === 'running' ? 1000 : 60_000);
  const running = run.status === 'running';
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
        <Button size="small" variant="danger" onClick={run.cancel}>
          Cancel
        </Button>
      )}
    </div>
  );
}
