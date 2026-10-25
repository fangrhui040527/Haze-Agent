import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { followTask } from '../../services/tasks/taskStream.ts';
import { AGENT_INFO } from '../../shared/types/agents.ts';
import type {
  TaskBlock,
  TaskResult,
  TaskStep,
} from '../../shared/types/tasks.ts';
import { Badge } from '../../shared/ui/Badge.tsx';
import { Spinner } from '../../shared/ui/States.tsx';
import styles from './TaskPage.module.css';

/**
 * A task report (Architecture v0.14 §17), written in front of the user: the steps
 * the agents take appear at the top and the report fills in block by block below.
 * The server sends finished blocks; the gradual reveal is presentation only and
 * never changes their content. Reduced-motion users see each block at once.
 */

const REVEAL_GAP_MS = 450;
const WORD_GAP_MS = 18;

const reducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function TaskPage() {
  const { id = '' } = useParams();
  const [steps, setSteps] = useState<TaskStep[]>([]);
  const [blocks, setBlocks] = useState<TaskBlock[]>([]);
  const [result, setResult] = useState<TaskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(0);

  useEffect(() => {
    setSteps([]);
    setBlocks([]);
    setResult(null);
    setError(null);
    setShown(0);
    return followTask(
      id,
      (event) => {
        if (event.type === 'step')
          setSteps((prev) => {
            const at = prev.findIndex((s) => s.id === event.step.id);
            if (at < 0) return [...prev, event.step];
            const next = [...prev];
            next[at] = event.step;
            return next;
          });
        else if (event.type === 'block')
          setBlocks((prev) => [...prev, event.block]);
        else if (event.type === 'result') setResult(event.result);
        else setError(event.error);
      },
      () =>
        setError(
          'Lost the connection to the server. The report may have expired; ask again in the chat.',
        ),
    );
  }, [id]);

  // Reveal one block at a time, like a page being written.
  useEffect(() => {
    if (shown >= blocks.length) return;
    if (reducedMotion()) {
      setShown(blocks.length);
      return;
    }
    const timer = setTimeout(
      () => setShown((n) => n + 1),
      shown === 0 ? 0 : REVEAL_GAP_MS,
    );
    return () => clearTimeout(timer);
  }, [shown, blocks.length]);

  const writing = !error && (!result || shown < blocks.length);
  const title =
    result?.title ??
    (blocks[0]?.type === 'heading' ? blocks[0].text : 'Task report');

  return (
    <article className={styles.page} aria-busy={writing}>
      <p className={styles.back}>
        <Link to="/">← Back to the dashboard</Link>
      </p>

      <ol className={styles.steps} aria-label="What the agents are doing">
        {steps.map((s) => (
          <li key={s.id} className={styles[s.state]}>
            {s.state === 'running' ? (
              <Spinner />
            ) : (
              <span aria-hidden="true">{s.state === 'done' ? '✓' : '✕'}</span>
            )}
            <span className={styles.agent}>{AGENT_INFO[s.agent].name}</span>
            <span>{s.label}</span>
          </li>
        ))}
      </ol>

      <div className={styles.doc}>
        {blocks.length === 0 && !error && (
          <p className={styles.placeholder}>
            <Spinner /> Preparing {title.toLowerCase()}…
          </p>
        )}
        {blocks.slice(0, shown).map((block, i) => (
          <Block
            key={block.id}
            block={block}
            first={i === 0}
            typing={i === shown - 1 && writing}
          />
        ))}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>

      {result && shown >= blocks.length && <ResultFooter result={result} />}
    </article>
  );
}

function Block({
  block,
  first,
  typing,
}: {
  block: TaskBlock;
  first: boolean;
  typing: boolean;
}) {
  switch (block.type) {
    case 'heading':
      return first ? (
        <h1 className={styles.title}>
          <Typed text={block.text} typing={typing} />
        </h1>
      ) : (
        <h2 className={styles.heading}>
          <Typed text={block.text} typing={typing} />
        </h2>
      );
    case 'paragraph':
      return (
        <p className={styles.block}>
          <Typed text={block.text} typing={typing} />
        </p>
      );
    case 'quote':
      return (
        <blockquote className={styles.quote}>
          <span className={styles.label}>You asked</span>
          <Typed text={block.text} typing={typing} />
        </blockquote>
      );
    case 'callout':
      return (
        <p className={`${styles.callout} ${styles[block.tone]}`}>
          <Typed text={block.text} typing={typing} />
        </p>
      );
    case 'bullets':
      return (
        <ul className={`${styles.block} ${styles.list}`}>
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {block.columns.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** Shows text word by word while it is the block being written. */
function Typed({ text, typing }: { text: string; typing: boolean }) {
  const words = text.split(' ');
  const [count, setCount] = useState(typing ? 0 : words.length);
  useEffect(() => {
    if (!typing || reducedMotion()) {
      setCount(words.length);
      return;
    }
    if (count >= words.length) return;
    const timer = setTimeout(() => setCount((n) => n + 1), WORD_GAP_MS);
    return () => clearTimeout(timer);
  }, [typing, count, words.length]);
  if (count >= words.length) return <>{text}</>;
  return (
    <>
      <span aria-hidden="true">{words.slice(0, count).join(' ')}</span>
      <span className={styles.caret} aria-hidden="true" />
      <span className="visually-hidden">{text}</span>
    </>
  );
}

function ResultFooter({ result }: { result: TaskResult }) {
  return (
    <footer className={styles.footer}>
      <Section title="Not covered yet" items={result.gaps} />
      <Section title="Assumptions" items={result.assumptions} />
      <Section title="Uncertainty" items={result.uncertainty} />
      {result.citations.length > 0 && (
        <section>
          <h3>Sources</h3>
          <ol>
            {result.citations.map((c, i) => (
              <li key={i}>
                {c.itemId ? (
                  <Link to={`/item/${encodeURIComponent(c.itemId)}`}>
                    {c.label}
                  </Link>
                ) : (
                  c.label
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      <p className={styles.meta}>
        <Badge tone="neutral">Filled in from a template, no AI model</Badge>
        <Badge tone="warn">Not reviewed</Badge>
        <span>
          {result.review.note} As of{' '}
          {result.asOf.slice(0, 16).replace('T', ' ')} UTC. {result.coverage}
        </span>
      </p>
    </footer>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h3>{title}</h3>
      <ul>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
