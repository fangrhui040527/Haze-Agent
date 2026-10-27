import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Link } from 'react-router';
import type { ManagerChatQuestion } from '../../../../app/contracts/manager-chat.ts';
import type { AgentRun } from '../dashboard/useAgentRun.ts';
import { Button } from '../../shared/ui/Button.tsx';
import { Spinner } from '../../shared/ui/States.tsx';
import { TaskResult } from './TaskResult.tsx';
import {
  reconcileTaskMessages,
  type ChatMessage,
} from './conversationState.ts';
import { useManagerConversation } from './useManagerConversation.ts';
import styles from './ChatPanel.module.css';

const EXAMPLE_PROMPTS = [
  'Explain the difference between modeled PM2.5 estimates and sensor observations.',
  'Latest haze information for Singapore',
  'Investigate the PM2.5 evidence for Kuala Lumpur during 2026-10-23 to 2026-10-24 and write a report.',
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
  const conversation = useManagerConversation(run.task, run.observeTask);
  const [draft, setDraft] = useState('');
  const [focusItemId, setFocusItemId] = useState<string | null>(null);
  const [answerTo, setAnswerTo] = useState<ManagerChatQuestion>();
  const listRef = useRef<HTMLOListElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messages =
    conversation.allowDetachedRestore &&
    run.task?.record &&
    !conversation.messages.some(
      (message) => message.taskCard?.task_id === run.task?.id,
    )
      ? reconcileTaskMessages(
          conversation.messages,
          run.task.record,
          conversation.seenEvents,
        )
      : conversation.messages;

  useEffect(() => {
    if (!prefill) return;
    setDraft(prefill.question);
    setFocusItemId(prefill.focusItemId);
    setAnswerTo(undefined);
    inputRef.current?.focus();
  }, [prefill]);
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [conversation.messages]);

  const send = () => {
    if (!draft.trim() || conversation.sending) return;
    const text = draft;
    setDraft('');
    setFocusItemId(null);
    setAnswerTo(undefined);
    void conversation.send(text, focusItemId, answerTo);
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    send();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      send();
    }
  };
  const clear = () => {
    conversation.clear();
    run.reset();
    setDraft('');
    setFocusItemId(null);
    setAnswerTo(undefined);
    inputRef.current?.focus();
  };

  return (
    <section className={styles.chat} aria-labelledby="chat-title">
      <div className={styles.header}>
        <h2 id="chat-title">Chat with the Manager</h2>
        {messages.length > 0 && (
          <Button size="small" variant="ghost" onClick={clear}>
            Clear chat
          </Button>
        )}
      </div>
      {messages.length === 0 ? (
        <div className={styles.empty}>
          <p>
            Ask a question or describe what you need to investigate. The Manager
            will start a tracked task when the work needs one.
          </p>
          <ul className={styles.prompts}>
            {EXAMPLE_PROMPTS.map((prompt) => (
              <li key={prompt}>
                <button
                  type="button"
                  className={styles.prompt}
                  onClick={() => {
                    setDraft(prompt);
                    setFocusItemId(null);
                    setAnswerTo(undefined);
                    inputRef.current?.focus();
                  }}
                >
                  {prompt}
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
          aria-live="polite"
        >
          {messages.map((message) => (
            <li
              key={message.id}
              className={message.role === 'user' ? styles.user : styles.agents}
            >
              <span className={styles.who}>
                {message.role === 'user' ? 'You' : 'Manager'}
              </span>
              <MessageBody
                message={message}
                onRetry={() => void conversation.retry(message)}
                retryDisabled={conversation.sending}
                onAnswer={(question) => {
                  setAnswerTo(question);
                  inputRef.current?.focus();
                }}
                observationError={
                  message.taskCard
                    ? conversation.observationErrors[message.taskCard.task_id]
                    : undefined
                }
              />
            </li>
          ))}
        </ol>
      )}
      {answerTo && (
        <p className={styles.focusNote}>
          Replying to a task question.{' '}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => setAnswerTo(undefined)}
          >
            Ask something else
          </button>
        </p>
      )}
      <form className={styles.form} onSubmit={onSubmit}>
        <label htmlFor="chat-input" className="visually-hidden">
          Your message to the Manager
        </label>
        <textarea
          id="chat-input"
          ref={inputRef}
          rows={2}
          value={draft}
          placeholder="Ask the Manager… (Enter to send, Shift+Enter for a new line)"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          maxLength={16000}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={conversation.sending || draft.trim() === ''}
        >
          Send
        </Button>
      </form>
      {focusItemId && (
        <p className={styles.focusNote}>
          Asking about the selected item.{' '}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => setFocusItemId(null)}
          >
            Ask generally instead
          </button>
        </p>
      )}
    </section>
  );
}

function MessageBody({
  message,
  onRetry,
  retryDisabled,
  onAnswer,
  observationError,
}: {
  message: ChatMessage;
  onRetry: () => void;
  retryDisabled: boolean;
  onAnswer: (question: ManagerChatQuestion) => void;
  observationError?: string;
}) {
  if (message.role === 'user')
    return <p className={styles.bubble}>{message.text}</p>;
  if (message.state === 'pending')
    return (
      <p className={`${styles.bubble} ${styles.pending}`}>
        <Spinner /> Thinking…
      </p>
    );
  if (message.state === 'error' || message.state === 'cancelled')
    return (
      <div className={`${styles.bubble} ${styles.error}`} role="alert">
        <p>
          {message.error ??
            'Delivery was interrupted. Any admitted task remains saved.'}
        </p>
        {message.retryable && message.request && (
          <Button size="small" onClick={onRetry} disabled={retryDisabled}>
            Retry
          </Button>
        )}
      </div>
    );
  if (message.state === 'task_cancelled')
    return (
      <p className={`${styles.bubble} ${styles.muted}`}>
        The server cancelled this task. Saved artifacts remain available.
      </p>
    );
  return (
    <div className={styles.bubble}>
      {(message.scheduling !== undefined ||
        message.agentExecution !== undefined) && (
        <p className={styles.source}>
          Archived crew demo. Saved text is retained; structured scheduling
          details are no longer available.
        </p>
      )}
      {message.text && <p>{message.text}</p>}
      {message.stale && !message.evidence && (
        <p className={styles.muted}>
          Historical message from an earlier task revision.
        </p>
      )}
      {message.paragraphs?.map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
      {message.evidence?.result?.schema_version === 'haze.task.result.v3' && (
        <TaskResult
          evidence={message.evidence}
          stale={Boolean(message.stale)}
        />
      )}
      {message.taskCard && (
        <div className={styles.taskCard}>
          <strong>{message.taskCard.title}</strong>
          <p>{message.taskCard.summary}</p>
          {observationError && (
            <p className={styles.muted}>
              Progress is temporarily unavailable. The last confirmed task state
              is shown.
            </p>
          )}
          <Link to={`/manager/${encodeURIComponent(message.taskCard.task_id)}`}>
            Open Manager workspace
          </Link>
        </div>
      )}
      {message.workspaceTaskId && (
        <Link to={`/manager/${encodeURIComponent(message.workspaceTaskId)}`}>
          Open Manager workspace
        </Link>
      )}
      {message.task && (
        <Link to={`/report/${encodeURIComponent(message.task.taskId)}`}>
          Open the report: {message.task.title}
        </Link>
      )}
      {message.taskQuestion && !message.questionAnswered && (
        <Button
          size="small"
          variant="ghost"
          onClick={() => onAnswer(message.taskQuestion!)}
        >
          Answer this question
        </Button>
      )}
      {message.taskQuestion && message.questionAnswered && (
        <span className={styles.muted}>
          This question is no longer waiting for an answer.
        </span>
      )}
      {message.citations && message.citations.length > 0 && (
        <div className={styles.citations}>
          <span>Sources:</span>
          {message.citations.map((citation, index) => (
            <span key={citation.id ?? index} className={styles.citation}>
              {citation.href ? (
                <a href={citation.href} target="_blank" rel="noreferrer">
                  [{citation.id ?? index + 1}] {citation.label}
                </a>
              ) : 'itemId' in citation && citation.itemId ? (
                <Link to={`/item/${encodeURIComponent(citation.itemId)}`}>
                  {citation.label}
                </Link>
              ) : (
                <span>{citation.label}</span>
              )}
              {'observed_at' in citation && citation.observed_at && (
                <>
                  {' '}
                  · {citation.kind === 'modeled'
                    ? 'Modeled for'
                    : 'Observed'}{' '}
                  <time dateTime={citation.observed_at}>
                    {citation.observed_at}
                  </time>
                </>
              )}
              {'retrieved_at' in citation && citation.retrieved_at && (
                <>
                  {' '}
                  · Retrieved{' '}
                  <time dateTime={citation.retrieved_at}>
                    {citation.retrieved_at}
                  </time>
                </>
              )}
              {'kind' in citation && citation.kind && (
                <> · {citation.kind.replaceAll('_', ' ')}</>
              )}
            </span>
          ))}
        </div>
      )}
      {message.errorCategory && message.retryable && message.request && (
        <Button size="small" onClick={onRetry} disabled={retryDisabled}>
          Retry
        </Button>
      )}
      {message.source && (
        <p className={styles.source}>{SOURCE_LABEL[message.source]}</p>
      )}
    </div>
  );
}
