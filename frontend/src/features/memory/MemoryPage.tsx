import { useMemo, useState } from 'react';
import { Badge, type Tone } from '../../shared/ui/Badge.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { StateMessage } from '../../shared/ui/States.tsx';
import {
  AUDIT,
  CONFLICTS,
  MEMORIES,
  PROPOSALS,
  RECALLS,
  REPORTS,
  SLEEP_PREVIEW,
  STATUS,
  type AuditEvent,
  type Conflict,
  type ConflictResolution,
  type MaintenanceReport,
  type MemoryRecord,
  type MemoryTier,
  type Proposal,
  type RecallAvailability,
  type RecallFeedback,
  type ReviewStatus,
} from './memoryFixtures.ts';
import styles from './MemoryPage.module.css';

/**
 * Memory page for H-MEM. Frontend only: all data comes from local fixtures and
 * every action mutates local state. Integration with the H-MEM API is TODO.
 */

const TABS = [
  ['overview', 'Overview'],
  ['browser', 'Memory browser'],
  ['recall', 'Recall explanations'],
  ['review', 'Review queue'],
  ['conflicts', 'Conflicts'],
  ['maintenance', 'Maintenance & history'],
] as const;
type TabId = (typeof TABS)[number][0];

const TIER_LABEL: Record<MemoryTier, string> = {
  short_term: 'Short-term',
  working: 'Working',
  long_term: 'Long-term',
};
const REVIEW_TONE: Record<ReviewStatus, Tone> = {
  approved: 'ok',
  pending: 'info',
  expired: 'stale',
  rejected: 'error',
};
const AVAILABILITY_TONE: Record<RecallAvailability, Tone> = {
  recalled: 'ok',
  skipped: 'neutral',
  disabled: 'stale',
  failed: 'error',
};

const fmt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
const pct = (n: number) => `${Math.round(n * 100)}%`;

let auditSeq = 100;
function auditEvent(
  action: AuditEvent['action'],
  memoryId: string | null,
  detail: string,
): AuditEvent {
  auditSeq += 1;
  return {
    id: `au_${auditSeq}`,
    at: new Date().toISOString(),
    action,
    actor: 'you',
    memoryId,
    detail,
  };
}

export function MemoryPage() {
  const [tab, setTab] = useState<TabId>('overview');
  const [memories, setMemories] = useState(MEMORIES);
  const [proposals, setProposals] = useState(PROPOSALS);
  const [conflicts, setConflicts] = useState(CONFLICTS);
  const [reports, setReports] = useState(REPORTS);
  const [audit, setAudit] = useState(AUDIT);
  const [feedback, setFeedback] = useState<Record<string, RecallFeedback>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const byId = useMemo(
    () => new Map(memories.map((m) => [m.id, m])),
    [memories],
  );
  const log = (e: AuditEvent) => setAudit((a) => [e, ...a]);

  function openMemory(id: string) {
    setSelectedId(id);
    setTab('browser');
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>Memory</h1>
          <p className={styles.lede}>
            What the agent remembers, where it came from, and how it shaped an
            answer.
          </p>
        </div>
        <Badge tone="warn" title="Not connected to H-MEM yet">
          Sample data · not connected
        </Badge>
      </header>

      <div className={styles.tabs} role="tablist" aria-label="Memory areas">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            className={`${styles.tab} ${tab === id ? styles.tabActive : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
            {id === 'review' && proposals.length > 0 && (
              <span className={styles.count}>{proposals.length}</span>
            )}
            {id === 'conflicts' && conflicts.length > 0 && (
              <span className={styles.count}>{conflicts.length}</span>
            )}
          </button>
        ))}
      </div>

      <section role="tabpanel" className={styles.panel}>
        {tab === 'overview' && (
          <Overview
            memories={memories}
            proposals={proposals}
            conflicts={conflicts}
            lastReport={reports[0]}
            go={setTab}
          />
        )}
        {tab === 'browser' && (
          <Browser
            memories={memories}
            byId={byId}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        )}
        {tab === 'recall' && (
          <Recall
            byId={byId}
            feedback={feedback}
            onOpen={openMemory}
            onFeedback={(recallId, memoryId, value) => {
              setFeedback((f) => ({ ...f, [`${recallId}:${memoryId}`]: value }));
              log(auditEvent('feedback', memoryId, `Marked ${value} on ${recallId}`));
            }}
          />
        )}
        {tab === 'review' && (
          <Review
            proposals={proposals}
            byId={byId}
            onOpen={openMemory}
            onDecide={(p, approve, reason) => {
              setProposals((ps) => ps.filter((x) => x.id !== p.id));
              if (approve) {
                setMemories((ms) => [proposalToMemory(p), ...ms]);
              }
              log(
                auditEvent(
                  approve ? 'approve' : 'reject',
                  null,
                  `${approve ? 'Approved' : 'Rejected'} ${p.kind} ${p.id}${reason ? ` — ${reason}` : ''}`,
                ),
              );
            }}
          />
        )}
        {tab === 'conflicts' && (
          <Conflicts
            conflicts={conflicts}
            byId={byId}
            onResolve={(c, how) => {
              setConflicts((cs) => cs.filter((x) => x.id !== c.id));
              setMemories((ms) => resolveConflict(ms, c, how));
              log(auditEvent('resolve', c.aId, `Resolved ${c.id} with ${how}`));
            }}
          />
        )}
        {tab === 'maintenance' && (
          <Maintenance
            byId={byId}
            reports={reports}
            audit={audit}
            onOpen={openMemory}
            onExecute={() => {
              const report: MaintenanceReport = {
                id: `rp_${Date.now()}`,
                ranAt: new Date().toISOString(),
                backupId: `bk_${Date.now()}`,
                consolidated: SLEEP_PREVIEW.toConsolidate.length,
                archived: SLEEP_PREVIEW.toArchive.length,
                synthesized: SLEEP_PREVIEW.toSynthesize.length > 0 ? 1 : 0,
                restored: false,
              };
              setReports((r) => [report, ...r]);
              log(auditEvent('synthesize', null, `Sleep cycle executed (backup ${report.backupId})`));
            }}
            onRestore={(r) => {
              setReports((rs) =>
                rs.map((x) => (x.id === r.id ? { ...x, restored: true } : x)),
              );
              log(auditEvent('restore', null, `Restored backup ${r.backupId}`));
            }}
          />
        )}
      </section>
    </div>
  );
}

function proposalToMemory(p: Proposal): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: `mem_${p.id}`,
    content: p.content,
    type: 'general',
    layer: 'long_term',
    topic: p.kind === 'invariant' ? 'Invariant' : 'Insight',
    location: p.location,
    timeScope: { from: now.slice(0, 10), to: null, label: 'Ongoing' },
    timestamp: now,
    lastAccessed: now,
    accessCount: 0,
    confidence: 0.7,
    source: 'dreaming',
    tags: [p.kind],
    reviewStatus: 'approved',
    expiresAt: null,
    provenance: { origin: 'dreaming', learnedAt: now, label: `Approved proposal ${p.id}` },
    evidence: [],
    relatedTo: p.supportingIds,
    revisions: [{ at: now, action: 'create', actor: 'you', note: 'Approved from review queue' }],
  };
}

function resolveConflict(
  ms: MemoryRecord[],
  c: Conflict,
  how: ConflictResolution,
): MemoryRecord[] {
  switch (how) {
    case 'keep_a':
      return ms.filter((m) => m.id !== c.bId);
    case 'keep_b':
      return ms.filter((m) => m.id !== c.aId);
    case 'delete_both':
      return ms.filter((m) => m.id !== c.aId && m.id !== c.bId);
    case 'merge': {
      const a = ms.find((m) => m.id === c.aId);
      const b = ms.find((m) => m.id === c.bId);
      if (!a || !b) return ms;
      const now = new Date().toISOString();
      const merged: MemoryRecord = {
        ...b,
        id: `mem_merged_${c.id}`,
        content: `${b.content} (Supersedes: “${a.content}”)`,
        confidence: Math.max(a.confidence, b.confidence),
        evidence: [...a.evidence, ...b.evidence],
        revisions: [
          ...b.revisions,
          { at: now, action: 'supersede', actor: 'you', note: `Merged ${a.id} + ${b.id}` },
        ],
      };
      return [merged, ...ms.filter((m) => m.id !== a.id && m.id !== b.id)];
    }
    case 'keep_both':
      return ms;
  }
}

/* ---------- Overview ---------- */

function Overview({
  memories,
  proposals,
  conflicts,
  lastReport,
  go,
}: {
  memories: MemoryRecord[];
  proposals: Proposal[];
  conflicts: Conflict[];
  lastReport: MaintenanceReport | undefined;
  go: (t: TabId) => void;
}) {
  const tiers = (Object.keys(TIER_LABEL) as MemoryTier[]).map((t) => ({
    tier: t,
    n: memories.filter((m) => m.layer === t).length,
  }));
  return (
    <div className={styles.stack}>
      <div className={styles.tiles}>
        {tiers.map(({ tier, n }) => (
          <div key={tier} className={styles.tile}>
            <span className={styles.tileLabel}>{TIER_LABEL[tier]}</span>
            <span className={styles.tileValue}>{n}</span>
          </div>
        ))}
        <button type="button" className={styles.tile} onClick={() => go('review')}>
          <span className={styles.tileLabel}>Pending reviews</span>
          <span className={styles.tileValue}>{proposals.length}</span>
        </button>
        <button type="button" className={styles.tile} onClick={() => go('conflicts')}>
          <span className={styles.tileLabel}>Unresolved conflicts</span>
          <span className={styles.tileValue}>{conflicts.length}</span>
        </button>
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>Last maintenance</dt>
          <dd>{lastReport ? fmt(lastReport.ranAt) : 'Never'}</dd>
        </div>
        <div>
          <dt>Capture</dt>
          <dd>
            <Badge tone={STATUS.capture === 'on' ? 'ok' : 'stale'}>{STATUS.capture}</Badge>
          </dd>
        </div>
        <div>
          <dt>Recall</dt>
          <dd>
            <Badge tone={STATUS.recall === 'on' ? 'ok' : 'stale'}>{STATUS.recall}</Badge>
          </dd>
        </div>
        <div>
          <dt>Expiring in 30 days</dt>
          <dd>
            {
              memories.filter(
                (m) =>
                  m.expiresAt &&
                  m.reviewStatus !== 'expired' &&
                  new Date(m.expiresAt).getTime() - Date.now() < 30 * 864e5,
              ).length
            }
          </dd>
        </div>
      </dl>
    </div>
  );
}

/* ---------- Browser ---------- */

function uniq(xs: string[]) {
  return [...new Set(xs)].sort();
}

function Browser({
  memories,
  byId,
  selectedId,
  onSelect,
}: {
  memories: MemoryRecord[];
  byId: Map<string, MemoryRecord>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [q, setQ] = useState('');
  const [location, setLocation] = useState('');
  const [topic, setTopic] = useState('');
  const [tier, setTier] = useState('');
  const [source, setSource] = useState('');
  const [since, setSince] = useState('');

  const filtered = memories.filter(
    (m) =>
      (!q || `${m.content} ${m.tags.join(' ')} ${m.id}`.toLowerCase().includes(q.toLowerCase())) &&
      (!location || m.location === location) &&
      (!topic || m.topic === topic) &&
      (!tier || m.layer === tier) &&
      (!source || m.source === source) &&
      (!since || m.timestamp >= since),
  );
  const selected = selectedId ? byId.get(selectedId) : undefined;

  return (
    <div className={styles.split}>
      <div className={styles.stack}>
        <div className={styles.filters}>
          <input
            type="search"
            placeholder="Search memories…"
            aria-label="Search memories"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Select label="Location" value={location} onChange={setLocation} options={uniq(memories.map((m) => m.location))} />
          <Select label="Topic" value={topic} onChange={setTopic} options={uniq(memories.map((m) => m.topic))} />
          <Select label="Tier" value={tier} onChange={setTier} options={Object.keys(TIER_LABEL)} format={(t) => TIER_LABEL[t as MemoryTier]} />
          <Select label="Source" value={source} onChange={setSource} options={uniq(memories.map((m) => m.source))} />
          <label className={styles.field}>
            <span>Since</span>
            <input type="date" value={since} onChange={(e) => setSince(e.target.value)} />
          </label>
        </div>
        <p className={styles.muted}>{filtered.length} of {memories.length} memories</p>
        <ul className={styles.list}>
          {filtered.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className={`${styles.row} ${m.id === selectedId ? styles.rowActive : ''}`}
                onClick={() => onSelect(m.id)}
              >
                <span className={styles.rowContent}>{m.content}</span>
                <span className={styles.meta}>
                  <Badge>{TIER_LABEL[m.layer]}</Badge>
                  <Badge tone={REVIEW_TONE[m.reviewStatus]}>{m.reviewStatus}</Badge>
                  <span>{m.location}</span>·<span>{m.topic}</span>·<span>{pct(m.confidence)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {filtered.length === 0 && (
          <StateMessage kind="empty" title="No memories match these filters." />
        )}
      </div>
      <aside className={styles.detail} aria-label="Memory detail">
        {selected ? (
          <MemoryDetail m={selected} byId={byId} onSelect={onSelect} />
        ) : (
          <p className={styles.muted}>Select a memory to see its content, provenance and history.</p>
        )}
      </aside>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
  format = (s) => s,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  format?: (s: string) => string;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>{format(o)}</option>
        ))}
      </select>
    </label>
  );
}

function MemoryDetail({
  m,
  byId,
  onSelect,
}: {
  m: MemoryRecord;
  byId: Map<string, MemoryRecord>;
  onSelect: (id: string) => void;
}) {
  return (
    <div className={styles.stack}>
      <div className={styles.meta}>
        <code>{m.id}</code>
        <Badge>{TIER_LABEL[m.layer]}</Badge>
        <Badge>{m.type}</Badge>
        <Badge tone={REVIEW_TONE[m.reviewStatus]}>{m.reviewStatus}</Badge>
      </div>
      <p className={styles.content}>{m.content}</p>
      <div>
        <span className={styles.tileLabel}>Confidence {pct(m.confidence)}</span>
        <div className={styles.bar}><span style={{ width: pct(m.confidence) }} /></div>
      </div>
      <dl className={styles.kv}>
        <dt>Applies to</dt><dd>{m.location} · {m.timeScope.label} ({m.timeScope.from} → {m.timeScope.to ?? 'open'})</dd>
        <dt>Expiry</dt><dd>{m.expiresAt ? fmtDate(m.expiresAt) : 'No expiry'}</dd>
        <dt>Provenance</dt><dd>{m.provenance.label} · {m.provenance.origin} · {fmt(m.provenance.learnedAt)}</dd>
        <dt>Source</dt><dd>{m.source}</dd>
        <dt>Usage</dt><dd>Recalled {m.accessCount}× · last {fmt(m.lastAccessed)}</dd>
        {m.tags.length > 0 && (<><dt>Tags</dt><dd>{m.tags.join(', ')}</dd></>)}
      </dl>
      <h3>Original evidence</h3>
      {m.evidence.length ? (
        <ul className={styles.plain}>
          {m.evidence.map((e) => (
            <li key={e.label}><Badge>{e.kind.replace('_', ' ')}</Badge> <a href={e.href}>{e.label}</a></li>
          ))}
        </ul>
      ) : <p className={styles.muted}>No linked evidence.</p>}
      {m.relatedTo.length > 0 && (
        <>
          <h3>Linked memories</h3>
          <ul className={styles.plain}>
            {m.relatedTo.map((id) => (
              <li key={id}>
                <button type="button" className={styles.link} onClick={() => onSelect(id)}>
                  {id}
                </button>{' '}
                <span className={styles.muted}>{byId.get(id)?.content ?? '(removed)'}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>Revision history</h3>
      <ol className={styles.timeline}>
        {m.revisions.map((r) => (
          <li key={r.at + r.action}>
            <span className={styles.muted}>{fmt(r.at)}</span> <strong>{r.action}</strong> by {r.actor} — {r.note}
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------- Recall ---------- */

function Recall({
  byId,
  feedback,
  onOpen,
  onFeedback,
}: {
  byId: Map<string, MemoryRecord>;
  feedback: Record<string, RecallFeedback>;
  onOpen: (id: string) => void;
  onFeedback: (recallId: string, memoryId: string, v: RecallFeedback) => void;
}) {
  return (
    <ul className={styles.cards}>
      {RECALLS.map((r) => (
        <li key={r.id} className={styles.card}>
          <div className={styles.cardHead}>
            <strong>{r.question}</strong>
            <Badge tone={AVAILABILITY_TONE[r.availability]}>Memory {r.availability}</Badge>
          </div>
          <p className={styles.muted}>{fmt(r.askedAt)} · {r.answerSummary}</p>
          {r.availabilityNote && <p className={styles.note}>{r.availabilityNote}</p>}
          {r.items.length > 0 && (
            <table className={styles.table}>
              <thead>
                <tr><th>Memory</th><th>Score</th><th>Why retrieved</th><th>Sources</th><th>Feedback</th></tr>
              </thead>
              <tbody>
                {r.items.map((it) => {
                  const m = byId.get(it.memoryId);
                  const given = feedback[`${r.id}:${it.memoryId}`];
                  return (
                    <tr key={it.memoryId}>
                      <td>
                        <button type="button" className={styles.link} onClick={() => onOpen(it.memoryId)}>
                          {it.memoryId}
                        </button>
                        <div className={styles.muted}>{m?.content ?? '(removed)'}</div>
                      </td>
                      <td>
                        {it.score.toFixed(2)}
                        <div className={styles.bar}><span style={{ width: pct(it.score) }} /></div>
                      </td>
                      <td>{it.reason}</td>
                      <td>
                        {m?.evidence.map((e) => (
                          <div key={e.label}><a href={e.href}>{e.label}</a></div>
                        ))}
                      </td>
                      <td>
                        <div className={styles.actions}>
                          {(['helpful', 'not_helpful', 'wrong'] as const).map((v) => (
                            <Button
                              key={v}
                              size="small"
                              variant={given === v ? (v === 'wrong' ? 'danger' : 'primary') : 'secondary'}
                              aria-pressed={given === v}
                              onClick={() => onFeedback(r.id, it.memoryId, v)}
                            >
                              {v === 'helpful' ? 'Helpful' : v === 'not_helpful' ? 'Not helpful' : 'Wrong'}
                            </Button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </li>
      ))}
    </ul>
  );
}

/* ---------- Review ---------- */

function Review({
  proposals,
  byId,
  onOpen,
  onDecide,
}: {
  proposals: Proposal[];
  byId: Map<string, MemoryRecord>;
  onOpen: (id: string) => void;
  onDecide: (p: Proposal, approve: boolean, reason?: string) => void;
}) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  if (proposals.length === 0) {
    return <StateMessage kind="empty" title="No proposals waiting for review." />;
  }
  return (
    <div className={styles.stack}>
      <p className={styles.muted}>
        Proposed insights and lessons are not used for recall until approved.
      </p>
      <ul className={styles.cards}>
        {proposals.map((p) => (
          <li key={p.id} className={styles.card}>
            <div className={styles.cardHead}>
              <Badge tone="info">Proposed {p.kind}</Badge>
              <span className={styles.muted}>{p.location} · {fmt(p.proposedAt)}</span>
            </div>
            <p className={styles.content}>{p.content}</p>
            <p className={styles.muted}>{p.rationale}</p>
            <h3>Supporting memories</h3>
            <ul className={styles.plain}>
              {p.supportingIds.map((id) => (
                <li key={id}>
                  <button type="button" className={styles.link} onClick={() => onOpen(id)}>{id}</button>{' '}
                  <span className={styles.muted}>{byId.get(id)?.content ?? '(removed)'}</span>
                </li>
              ))}
            </ul>
            <div className={styles.actions}>
              <input
                aria-label="Rejection reason"
                placeholder="Reason (optional, for reject)"
                value={reasons[p.id] ?? ''}
                onChange={(e) => setReasons((r) => ({ ...r, [p.id]: e.target.value }))}
              />
              <Button variant="primary" onClick={() => onDecide(p, true)}>Approve</Button>
              <Button variant="danger" onClick={() => onDecide(p, false, reasons[p.id])}>Reject</Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- Conflicts ---------- */

const RESOLUTIONS: [ConflictResolution, string, 'secondary' | 'danger'][] = [
  ['keep_a', 'Keep A', 'secondary'],
  ['keep_b', 'Keep B', 'secondary'],
  ['keep_both', 'Keep both', 'secondary'],
  ['merge', 'Merge', 'secondary'],
  ['delete_both', 'Delete both', 'danger'],
];

function Conflicts({
  conflicts,
  byId,
  onResolve,
}: {
  conflicts: Conflict[];
  byId: Map<string, MemoryRecord>;
  onResolve: (c: Conflict, how: ConflictResolution) => void;
}) {
  if (conflicts.length === 0) {
    return <StateMessage kind="empty" title="No unresolved conflicts." />;
  }
  return (
    <ul className={styles.cards}>
      {conflicts.map((c) => (
        <li key={c.id} className={styles.card}>
          <div className={styles.cardHead}>
            <strong>{c.summary}</strong>
            <span className={styles.muted}>Detected {fmt(c.detectedAt)}</span>
          </div>
          <div className={styles.sideBySide}>
            {[['A', c.aId], ['B', c.bId]].map(([label, id]) => {
              const m = byId.get(id);
              return (
                <div key={id} className={styles.side}>
                  <span className={styles.tileLabel}>Memory {label} · <code>{id}</code></span>
                  {m ? (
                    <>
                      <p className={styles.content}>{m.content}</p>
                      <dl className={styles.kv}>
                        <dt>Learned</dt><dd>{fmt(m.timestamp)}</dd>
                        <dt>Source</dt><dd>{m.provenance.label}</dd>
                        <dt>Confidence</dt><dd>{pct(m.confidence)}</dd>
                        <dt>Applies</dt><dd>{m.timeScope.label}</dd>
                      </dl>
                      <ul className={styles.plain}>
                        {m.evidence.map((e) => <li key={e.label}><a href={e.href}>{e.label}</a></li>)}
                      </ul>
                    </>
                  ) : <p className={styles.muted}>(removed)</p>}
                </div>
              );
            })}
          </div>
          <div className={styles.actions}>
            {RESOLUTIONS.map(([how, label, variant]) => (
              <Button key={how} variant={variant} onClick={() => onResolve(c, how)}>{label}</Button>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ---------- Maintenance ---------- */

function Maintenance({
  byId,
  reports,
  audit,
  onOpen,
  onExecute,
  onRestore,
}: {
  byId: Map<string, MemoryRecord>;
  reports: MaintenanceReport[];
  audit: AuditEvent[];
  onOpen: (id: string) => void;
  onExecute: () => void;
  onRestore: (r: MaintenanceReport) => void;
}) {
  const [previewed, setPreviewed] = useState(false);
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [since, setSince] = useState('');

  const events = audit.filter(
    (e) =>
      (!q || `${e.memoryId ?? ''} ${e.detail}`.toLowerCase().includes(q.toLowerCase())) &&
      (!action || e.action === action) &&
      (!actor || e.actor === actor) &&
      (!since || e.at >= since),
  );
  const groups: [string, string[]][] = [
    ['Consolidate', SLEEP_PREVIEW.toConsolidate],
    ['Archive', SLEEP_PREVIEW.toArchive],
    ['Synthesize', SLEEP_PREVIEW.toSynthesize],
  ];

  return (
    <div className={styles.stack}>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <h2>Sleep cycle</h2>
          <div className={styles.actions}>
            <Button onClick={() => setPreviewed(true)}>Preview</Button>
            <Button
              variant="primary"
              disabled={!previewed}
              title={previewed ? undefined : 'Preview first'}
              onClick={() => { onExecute(); setPreviewed(false); }}
            >
              Execute
            </Button>
          </div>
        </div>
        {previewed ? (
          <div className={styles.sideBySide}>
            {groups.map(([label, ids]) => (
              <div key={label} className={styles.side}>
                <span className={styles.tileLabel}>{label} ({ids.length})</span>
                <ul className={styles.plain}>
                  {ids.map((id) => (
                    <li key={id}>
                      <button type="button" className={styles.link} onClick={() => onOpen(id)}>{id}</button>{' '}
                      <span className={styles.muted}>{byId.get(id)?.content ?? '(removed)'}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.muted}>Preview to see which memories would be consolidated, archived or synthesized. A backup is taken before execution.</p>
        )}
      </div>

      <h2>Reports & backups</h2>
      <table className={styles.table}>
        <thead>
          <tr><th>Ran</th><th>Consolidated</th><th>Archived</th><th>Synthesized</th><th>Backup</th><th /></tr>
        </thead>
        <tbody>
          {reports.map((r) => (
            <tr key={r.id}>
              <td>{fmt(r.ranAt)}</td>
              <td>{r.consolidated}</td>
              <td>{r.archived}</td>
              <td>{r.synthesized}</td>
              <td><code>{r.backupId}</code></td>
              <td>
                {r.restored ? <Badge tone="stale">Restored</Badge> : (
                  <Button size="small" onClick={() => onRestore(r)}>Restore</Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Audit timeline</h2>
      <div className={styles.filters}>
        <input type="search" placeholder="Memory ID or text…" aria-label="Search audit" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select label="Action" value={action} onChange={setAction} options={uniq(audit.map((e) => e.action))} />
        <Select label="Actor" value={actor} onChange={setActor} options={uniq(audit.map((e) => e.actor))} />
        <label className={styles.field}>
          <span>Since</span>
          <input type="date" value={since} onChange={(e) => setSince(e.target.value)} />
        </label>
      </div>
      <ol className={styles.timeline}>
        {events.map((e) => (
          <li key={e.id}>
            <span className={styles.muted}>{fmt(e.at)}</span> <Badge>{e.action}</Badge> {e.actor}
            {e.memoryId && (
              <> · <button type="button" className={styles.link} onClick={() => onOpen(e.memoryId!)}>{e.memoryId}</button></>
            )}{' '}
            — {e.detail}
          </li>
        ))}
      </ol>
      {events.length === 0 && <p className={styles.muted}>No audit events match.</p>}
    </div>
  );
}
