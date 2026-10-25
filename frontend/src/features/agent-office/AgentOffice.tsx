import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import {
  useLocalStorageState,
  useReducedMotion,
} from '../../shared/hooks/hooks.ts';
import {
  AGENT_IDS,
  AGENT_INFO,
  type AgentId,
} from '../../shared/types/agents.ts';
import { Badge } from '../../shared/ui/Badge.tsx';
import type { AgentRun } from '../dashboard/useAgentRun.ts';
import styles from './AgentOffice.module.css';
import { OFFICE_HEIGHT, OFFICE_WIDTH, STATIONS } from './officeLayout.ts';
import {
  deriveAgentStatuses,
  OfficeModel,
  type AgentStatus,
  type Pose,
} from './officeModel.ts';
import { actorAt, characterBounds, drawScene } from './renderer.ts';
import { LOOKS } from './sprites.ts';

const POSE_TONE: Record<Pose, 'neutral' | 'info' | 'ok' | 'error' | 'accent'> =
  {
    idle: 'neutral',
    thinking: 'info',
    walking: 'info',
    working: 'accent',
    done: 'ok',
    error: 'error',
  };

/**
 * Pixel-art office. Renders ONLY from run.events (AgentEvent[]), so the real backend can drive it.
 * The legend underneath is the text version of the same state (also read by screen readers).
 * Click a character (or its legend entry) to see what it does.
 */
export function AgentOffice({
  run,
  selected: externalSelected,
  onSelect: externalOnSelect,
}: {
  run: AgentRun;
  selected?: AgentId | null;
  onSelect?: (id: AgentId | null) => void;
}) {
  const reduced = useReducedMotion();
  const [visible, setVisible] = useLocalStorageState(
    'hazewatch.office.visible',
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [internalSelected, setInternalSelected] = useState<AgentId | null>(
    null,
  );
  const isControlled = externalSelected !== undefined;
  const selected = isControlled ? externalSelected : internalSelected;
  const onSelect = externalOnSelect ?? setInternalSelected;
  const statuses = useMemo(
    () => deriveAgentStatuses(run.events, run.task?.status),
    [run.events, run.task?.status],
  );
  const levelB = run.events.some((e) => e.type === 'run_state');
  const taskEvents = run.events.filter((event) => event.type === 'task_event');
  const toggle = (id: AgentId) => onSelect(selected === id ? null : id);

  return (
    <section className={styles.office} aria-labelledby="office-title">
      <div className={styles.header}>
        <h2 id="office-title">Agent office</h2>
        <div className={styles.headerRight}>
          <Badge tone="neutral" title="Where the agent events come from">
            {run.serviceLabel}
          </Badge>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              className={styles.toggleInput}
              checked={visible}
              onChange={(e) => setVisible(e.target.checked)}
            />
            <span className={styles.toggleBox} aria-hidden="true" />
            <span>Show office</span>
          </label>
        </div>
      </div>

      {visible && (
        <OfficeCanvas
          run={run}
          reduced={reduced}
          selected={selected}
          onSelect={onSelect}
        />
      )}
      {levelB && (
        <p className={styles.note}>
          The backend only reports the overall run state, so individual agent
          steps are not shown.
        </p>
      )}
      {taskEvents.length > 0 && (
        <details className={styles.note}>
          <summary>
            Actual task execution receipts ({taskEvents.length})
          </summary>
          <ol>
            {taskEvents.map((event) => (
              <li key={event.receipt.cursor}>
                <time dateTime={event.at}>
                  {new Date(event.at).toISOString().slice(11, 19)} UTC
                </time>
                {' · '}
                {event.receipt.actor}: {event.message}
                {'assignment_id' in event.receipt &&
                  event.receipt.assignment_id && (
                    <span> · Assignment {event.receipt.assignment_id}</span>
                  )}
              </li>
            ))}
          </ol>
        </details>
      )}
      {run.task?.record && (
        <section className={styles.assignments} aria-label="Actual assignments">
          <h3>Assignments</h3>
          {run.task.record.assignments.length === 0 ? (
            <p>No specialist assignments have been admitted.</p>
          ) : (
            <ol>
              {run.task.record.assignments.map((assignment) => (
                <li key={assignment.id}>
                  <strong>{assignment.role}</strong> ? {assignment.capability} ?{' '}
                  {assignment.status}
                  <p>{assignment.brief}</p>
                  <small>
                    Revision {assignment.revision}; brief acknowledged at
                    revision {assignment.acknowledged_revision}. Evidence
                    support: {assignment.support}. Output:{' '}
                    {assignment.usability}.
                  </small>
                  {assignment.gaps.length > 0 && (
                    <ul>
                      {assignment.gaps.map((gap, index) => (
                        <li key={index}>{gap}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      <div className={styles.legendRegion}>
        <ul
          className={`${styles.legend} ${!visible ? styles.legendSixRows : ''}`}
          aria-label="What each agent is doing"
        >
          {AGENT_IDS.map((id) => (
            <li key={id}>
              <button
                type="button"
                className={styles.legendItem}
                aria-pressed={selected === id}
                onClick={() => toggle(id)}
                title={AGENT_INFO[id].role}
              >
                <span
                  className={styles.dot}
                  style={{ background: LOOKS[id].palette.C }}
                  aria-hidden="true"
                />
                <span className={styles.agentName}>{AGENT_INFO[id].name}</span>
                <Badge
                  tone={POSE_TONE[statuses[id].state]}
                  title={statuses[id].text}
                >
                  {statuses[id].text}
                </Badge>
              </button>
            </li>
          ))}
        </ul>
        {selected && (
          <div className={styles.popupAnchor}>
            <AgentDetailPopup
              id={selected}
              status={statuses[selected]}
              onClose={() => onSelect(null)}
            />
          </div>
        )}
      </div>
    </section>
  );
}

export function AgentDetailPopup({
  id,
  status,
  onClose,
}: {
  id: AgentId;
  status: AgentStatus;
  onClose: () => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (popupRef.current?.contains(e.target as Node)) {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (
        target?.closest(`.${styles.legendItem}`) ||
        target?.tagName === 'CANVAS'
      ) {
        return;
      }
      onClose();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }

    const timer = setTimeout(() => {
      window.addEventListener('pointerdown', onPointerDown);
      window.addEventListener('keydown', onKeyDown);
    }, 10);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div ref={popupRef} className={styles.popup} role="status">
      <span
        className={styles.dot}
        style={{ background: LOOKS[id].palette.C }}
        aria-hidden="true"
      />
      <div className={styles.cardText}>
        <div>
          <strong>{AGENT_INFO[id].name}</strong>{' '}
          <span className={styles.muted}>· {AGENT_INFO[id].role}</span>
        </div>
        <div>
          <Badge tone={POSE_TONE[status.state]}>{status.text}</Badge>
        </div>
      </div>
      <button
        type="button"
        className={styles.close}
        onClick={onClose}
        aria-label="Close agent details"
      >
        ×
      </button>
    </div>
  );
}

function OfficeCanvas({
  run,
  reduced,
  selected,
  onSelect,
}: {
  run: AgentRun;
  reduced: boolean;
  selected: AgentId | null;
  onSelect: (id: AgentId | null) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const plateRefs = useRef(new Map<AgentId, HTMLSpanElement>());
  const modelRef = useRef<OfficeModel | null>(null);
  const appliedRef = useRef(0);
  const hoveredRef = useRef<AgentId | null>(null);
  const selectedRef = useRef(selected);
  const scaleRef = useRef(1);
  selectedRef.current = selected;
  modelRef.current ??= new OfficeModel({ ambient: !reduced });

  // Feed new events into the model. A shorter list means a new run started.
  useEffect(() => {
    const model = modelRef.current;
    if (!model) return;
    const now = performance.now();
    const events = run.events;
    if (events.length < appliedRef.current) {
      model.reset();
      appliedRef.current = 0;
    }
    // On first mount (e.g. the office was just switched on), catch up without animating.
    const catchingUp = appliedRef.current === 0 && events.length > 1;
    for (let i = appliedRef.current; i < events.length; i++) {
      const isLatest = i === events.length - 1;
      model.apply(events[i]!, now, reduced || (catchingUp && !isLatest));
    }
    appliedRef.current = events.length;
    // A persisted server cancellation also stops the office after polling detached.
    if (['cancelled', 'paused', 'waiting'].includes(run.task?.status ?? ''))
      model.reset();
  }, [run.events, run.task?.status, reduced]);

  useEffect(() => {
    if (modelRef.current) modelRef.current.ambient = !reduced;
  }, [reduced]);

  // Render at a whole-number multiple of the logical size, so every art pixel is the same size.
  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const scale = Math.max(
        1,
        Math.ceil((stage.clientWidth * dpr) / OFFICE_WIDTH),
      );
      if (scale === scaleRef.current && canvas.width === OFFICE_WIDTH * scale)
        return;
      scaleRef.current = scale;
      canvas.width = OFFICE_WIDTH * scale;
      canvas.height = OFFICE_HEIGHT * scale;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // Animation loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const model = modelRef.current;
    if (!ctx || !model) return;
    let frame = 0;
    let last = performance.now();
    const tick = (t: number) => {
      model.update(reduced ? 10_000 : t - last, t);
      last = t;
      const k = scaleRef.current;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      drawScene(ctx, model, t, {
        reduced,
        selected: selectedRef.current,
        hovered: hoveredRef.current,
      });
      // Nameplates follow their characters.
      for (const [id, el] of plateRefs.current) {
        const a = model.actors.get(id);
        if (!a) continue;
        const { feet, seated } = characterBounds(a);
        el.style.left = `${(feet.x / OFFICE_WIDTH) * 100}%`;
        // Seated: on the front of the desk, clear of the keyboard and hands.
        const y = seated ? feet.y + 8 : feet.y + 1;
        el.style.top = `${(y / OFFICE_HEIGHT) * 100}%`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reduced]);

  const toLogical = (e: MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * OFFICE_WIDTH,
      y: ((e.clientY - r.top) / r.height) * OFFICE_HEIGHT,
    };
  };

  return (
    <div className={styles.stage} ref={stageRef}>
      <canvas
        ref={canvasRef}
        width={OFFICE_WIDTH}
        height={OFFICE_HEIGHT}
        className={styles.canvas}
        role="img"
        aria-label="Pixel-art office with the Manager at reception and five agents at their desks. The list below describes what each agent is doing."
        onPointerMove={(e) => {
          const model = modelRef.current;
          if (!model) return;
          const { x, y } = toLogical(e);
          hoveredRef.current = actorAt(model, x, y);
          e.currentTarget.style.cursor = hoveredRef.current
            ? 'pointer'
            : 'default';
        }}
        onPointerLeave={() => {
          hoveredRef.current = null;
        }}
        onClick={(e) => {
          const model = modelRef.current;
          if (!model) return;
          const { x, y } = toLogical(e);
          const hit = actorAt(model, x, y);
          onSelect(hit === selected ? null : hit);
        }}
      />
      {AGENT_IDS.map((id) => (
        <span
          key={id}
          ref={(el) => {
            if (el) plateRefs.current.set(id, el);
            else plateRefs.current.delete(id);
          }}
          className={`${styles.nameplate} ${selected === id ? styles.nameplateSelected : ''}`}
          aria-hidden="true"
          style={{
            left: `${(STATIONS[id].seat.x / OFFICE_WIDTH) * 100}%`,
            top: `${(STATIONS[id].seat.y / OFFICE_HEIGHT) * 100}%`,
          }}
        >
          {STATIONS[id].label}
        </span>
      ))}
    </div>
  );
}
