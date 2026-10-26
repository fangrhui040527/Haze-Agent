/**
 * Frontend-only H-MEM view model and fixtures. Field names follow the upstream
 * H-MEM usage guide (Meterless/engines/hmem/HOW_TO_USE_H-MEM.md) so a later
 * integration can map API responses onto these types without renaming.
 */

export type MemoryTier = 'short_term' | 'working' | 'long_term';
export type MemoryType = 'personal' | 'factual' | 'preference' | 'general';
export type ReviewStatus = 'approved' | 'pending' | 'expired' | 'rejected';
export type RecallFeedback = 'helpful' | 'not_helpful' | 'wrong';
export type RecallAvailability = 'recalled' | 'skipped' | 'disabled' | 'failed';
export type ConflictResolution =
  'keep_a' | 'keep_b' | 'keep_both' | 'merge' | 'delete_both';

export interface EvidenceLink {
  kind: 'observation' | 'document' | 'task_result';
  label: string;
  href: string;
}

export interface MemoryRevision {
  at: string;
  action: 'create' | 'update' | 'synthesize' | 'supersede';
  actor: string;
  note: string;
}

export interface MemoryRecord {
  id: string;
  content: string;
  type: MemoryType;
  layer: MemoryTier;
  topic: string;
  location: string;
  /** When the lesson applies (validity window), not when it was learned. */
  timeScope: { from: string; to: string | null; label: string };
  timestamp: string;
  lastAccessed: string;
  accessCount: number;
  confidence: number;
  source: string;
  tags: string[];
  reviewStatus: ReviewStatus;
  expiresAt: string | null;
  provenance: { origin: string; learnedAt: string; label: string };
  evidence: EvidenceLink[];
  relatedTo: string[];
  revisions: MemoryRevision[];
}

export interface RecallItem {
  memoryId: string;
  score: number;
  reason: string;
}

export interface RecallExplanation {
  id: string;
  askedAt: string;
  question: string;
  answerSummary: string;
  availability: RecallAvailability;
  availabilityNote?: string;
  items: RecallItem[];
}

export interface Proposal {
  id: string;
  kind: 'insight' | 'invariant' | 'domain';
  content: string;
  location: string;
  proposedAt: string;
  supportingIds: string[];
  rationale: string;
}

export interface Conflict {
  id: string;
  detectedAt: string;
  summary: string;
  aId: string;
  bId: string;
}

export interface SleepPreview {
  toConsolidate: string[];
  toArchive: string[];
  toSynthesize: string[];
}

export interface MaintenanceReport {
  id: string;
  ranAt: string;
  backupId: string;
  consolidated: number;
  archived: number;
  synthesized: number;
  restored: boolean;
}

export interface AuditEvent {
  id: string;
  at: string;
  action: 'update' | 'delete' | 'synthesize' | 'ledger_rotated' | 'approve' |
    'reject' | 'resolve' | 'feedback' | 'restore';
  actor: string;
  memoryId: string | null;
  detail: string;
}

const ev = (
  kind: EvidenceLink['kind'],
  label: string,
  href = '#',
): EvidenceLink => ({ kind, label, href });

export const MEMORIES: MemoryRecord[] = [
  {
    id: 'mem_01',
    content:
      'Riau peatland hotspots typically lead to elevated PM2.5 in Johor 24–48 h later when the southwest monsoon is active.',
    type: 'factual',
    layer: 'long_term',
    topic: 'Transboundary haze',
    location: 'Johor',
    timeScope: { from: '2026-06-01', to: '2026-09-30', label: 'SW monsoon (Jun–Sep)' },
    timestamp: '2026-08-14T03:20:00Z',
    lastAccessed: '2026-10-25T11:02:00Z',
    accessCount: 41,
    confidence: 0.86,
    source: 'world-model synthesis',
    tags: ['hotspot', 'lag', 'monsoon'],
    reviewStatus: 'approved',
    expiresAt: '2027-06-01T00:00:00Z',
    provenance: { origin: 'synthesize', learnedAt: '2026-08-14T03:20:00Z', label: 'Derived from 6 task results' },
    evidence: [
      ev('observation', 'DOE APIMS Johor Bahru, 2026-08-10'),
      ev('document', 'ASMC haze outlook, Aug 2026'),
      ev('task_result', 'Task 7f3a — hotspot lag analysis'),
    ],
    relatedTo: ['mem_02', 'mem_05'],
    revisions: [
      { at: '2026-08-14T03:20:00Z', action: 'synthesize', actor: 'sleep-cycle', note: 'Synthesized from mem_02, mem_09' },
      { at: '2026-09-02T08:00:00Z', action: 'update', actor: 'reviewer', note: 'Narrowed lag from 12–72 h to 24–48 h' },
    ],
  },
  {
    id: 'mem_02',
    content: 'Hotspot count above 200 in Riau (VIIRS) is a reliable early signal for regional haze episodes.',
    type: 'factual',
    layer: 'long_term',
    topic: 'Hotspots',
    location: 'Riau',
    timeScope: { from: '2026-01-01', to: null, label: 'Any season' },
    timestamp: '2026-07-22T09:00:00Z',
    lastAccessed: '2026-10-24T06:30:00Z',
    accessCount: 27,
    confidence: 0.78,
    source: 'task result',
    tags: ['viirs', 'threshold'],
    reviewStatus: 'approved',
    expiresAt: null,
    provenance: { origin: 'capture', learnedAt: '2026-07-22T09:00:00Z', label: 'Captured after task 51b0' },
    evidence: [ev('observation', 'NASA FIRMS VIIRS export, 2026-07-20'), ev('task_result', 'Task 51b0')],
    relatedTo: ['mem_01'],
    revisions: [{ at: '2026-07-22T09:00:00Z', action: 'create', actor: 'agent', note: 'Captured' }],
  },
  {
    id: 'mem_03',
    content: 'Kuching readings from the Samarahan station overstate city-wide PM2.5 during easterly winds.',
    type: 'factual',
    layer: 'working',
    topic: 'Sensor quality',
    location: 'Kuching',
    timeScope: { from: '2026-09-01', to: '2026-11-30', label: 'Inter-monsoon' },
    timestamp: '2026-10-20T14:10:00Z',
    lastAccessed: '2026-10-25T09:40:00Z',
    accessCount: 6,
    confidence: 0.64,
    source: 'user feedback',
    tags: ['station-bias'],
    reviewStatus: 'pending',
    expiresAt: '2026-12-01T00:00:00Z',
    provenance: { origin: 'feedback', learnedAt: '2026-10-20T14:10:00Z', label: 'From a user correction' },
    evidence: [ev('observation', 'DOE station CA0042 vs CA0041, Oct 2026')],
    relatedTo: ['mem_04'],
    revisions: [{ at: '2026-10-20T14:10:00Z', action: 'create', actor: 'agent', note: 'Captured from feedback' }],
  },
  {
    id: 'mem_04',
    content: 'Samarahan station is representative of Kuching city-wide air quality.',
    type: 'factual',
    layer: 'long_term',
    topic: 'Sensor quality',
    location: 'Kuching',
    timeScope: { from: '2025-01-01', to: null, label: 'Any season' },
    timestamp: '2025-11-03T02:00:00Z',
    lastAccessed: '2026-10-19T12:00:00Z',
    accessCount: 15,
    confidence: 0.71,
    source: 'document',
    tags: ['station'],
    reviewStatus: 'approved',
    expiresAt: '2026-11-03T00:00:00Z',
    provenance: { origin: 'import', learnedAt: '2025-11-03T02:00:00Z', label: 'Imported from DOE station metadata' },
    evidence: [ev('document', 'DOE station network description, 2025')],
    relatedTo: ['mem_03'],
    revisions: [{ at: '2025-11-03T02:00:00Z', action: 'create', actor: 'import', note: 'Imported' }],
  },
  {
    id: 'mem_05',
    content: 'Users in Johor prefer advisories in Bahasa Malaysia with English summary underneath.',
    type: 'preference',
    layer: 'working',
    topic: 'Communication',
    location: 'Johor',
    timeScope: { from: '2026-10-01', to: null, label: 'Ongoing' },
    timestamp: '2026-10-12T05:00:00Z',
    lastAccessed: '2026-10-25T07:15:00Z',
    accessCount: 9,
    confidence: 0.69,
    source: 'chat',
    tags: ['language'],
    reviewStatus: 'approved',
    expiresAt: null,
    provenance: { origin: 'capture', learnedAt: '2026-10-12T05:00:00Z', label: 'Chat session c-118' },
    evidence: [ev('task_result', 'Chat c-118')],
    relatedTo: [],
    revisions: [{ at: '2026-10-12T05:00:00Z', action: 'create', actor: 'agent', note: 'Captured' }],
  },
  {
    id: 'mem_06',
    content: 'School closure threshold used by MOE in 2023 was API > 200 for the district.',
    type: 'factual',
    layer: 'long_term',
    topic: 'Policy',
    location: 'Malaysia',
    timeScope: { from: '2023-01-01', to: '2024-12-31', label: '2023–2024 guidance' },
    timestamp: '2024-02-10T00:00:00Z',
    lastAccessed: '2026-09-01T00:00:00Z',
    accessCount: 4,
    confidence: 0.58,
    source: 'document',
    tags: ['moe', 'threshold'],
    reviewStatus: 'expired',
    expiresAt: '2025-01-01T00:00:00Z',
    provenance: { origin: 'import', learnedAt: '2024-02-10T00:00:00Z', label: 'MOE circular 2023' },
    evidence: [ev('document', 'MOE circular, Sep 2023')],
    relatedTo: [],
    revisions: [{ at: '2024-02-10T00:00:00Z', action: 'create', actor: 'import', note: 'Imported' }],
  },
  {
    id: 'mem_07',
    content: 'Last asked about Penang PM2.5 trend for the past week.',
    type: 'personal',
    layer: 'short_term',
    topic: 'Session',
    location: 'Penang',
    timeScope: { from: '2026-10-25', to: '2026-10-26', label: 'This session' },
    timestamp: '2026-10-25T13:00:00Z',
    lastAccessed: '2026-10-25T13:00:00Z',
    accessCount: 1,
    confidence: 0.95,
    source: 'chat',
    tags: [],
    reviewStatus: 'approved',
    expiresAt: '2026-10-27T00:00:00Z',
    provenance: { origin: 'capture', learnedAt: '2026-10-25T13:00:00Z', label: 'Chat session c-131' },
    evidence: [],
    relatedTo: [],
    revisions: [{ at: '2026-10-25T13:00:00Z', action: 'create', actor: 'agent', note: 'Captured' }],
  },
];

export const RECALLS: RecallExplanation[] = [
  {
    id: 'rc_1',
    askedAt: '2026-10-25T11:02:00Z',
    question: 'Will Johor Bahru air quality worsen this weekend?',
    answerSummary: 'Likely moderate-to-unhealthy by Saturday given Riau hotspot counts and SW winds.',
    availability: 'recalled',
    items: [
      { memoryId: 'mem_01', score: 0.91, reason: 'Location + season match; lag pattern applies' },
      { memoryId: 'mem_02', score: 0.74, reason: 'Hotspot threshold referenced in forecast step' },
      { memoryId: 'mem_05', score: 0.42, reason: 'Language preference for Johor users' },
    ],
  },
  {
    id: 'rc_2',
    askedAt: '2026-10-25T09:40:00Z',
    question: 'Is Kuching air safe for outdoor exercise today?',
    answerSummary: 'Reported Samarahan PM2.5 is elevated; city-wide likely lower.',
    availability: 'recalled',
    items: [
      { memoryId: 'mem_03', score: 0.82, reason: 'Station bias note for this location' },
      { memoryId: 'mem_04', score: 0.66, reason: 'Station representativeness (conflicts with mem_03)' },
    ],
  },
  {
    id: 'rc_3',
    askedAt: '2026-10-24T16:00:00Z',
    question: 'Summarize damage account for task 9c21.',
    answerSummary: 'Memory recall was skipped for a deterministic accounting task.',
    availability: 'skipped',
    availabilityNote: 'Task type excludes memory to keep accounting reproducible.',
    items: [],
  },
  {
    id: 'rc_4',
    askedAt: '2026-10-24T10:12:00Z',
    question: 'What did we conclude about Penang last week?',
    answerSummary: 'Answered without memory.',
    availability: 'failed',
    availabilityNote: 'H-MEM recall timed out after 3 s.',
    items: [],
  },
];

export const PROPOSALS: Proposal[] = [
  {
    id: 'pr_1',
    kind: 'insight',
    content: 'When Kuching easterly winds exceed 15 km/h, weight Samarahan readings down by ~30% for city-wide estimates.',
    location: 'Kuching',
    proposedAt: '2026-10-25T02:00:00Z',
    supportingIds: ['mem_03', 'mem_04'],
    rationale: 'Repeated user corrections plus station comparison.',
  },
  {
    id: 'pr_2',
    kind: 'invariant',
    content: 'Always cite the station ID when quoting PM2.5 values for a city.',
    location: 'Malaysia',
    proposedAt: '2026-10-24T02:00:00Z',
    supportingIds: ['mem_03', 'mem_01'],
    rationale: 'Ambiguity about station caused two "wrong" feedbacks.',
  },
  {
    id: 'pr_3',
    kind: 'domain',
    content: 'Group Johor and Singapore as one transboundary-haze region for forecasting.',
    location: 'Johor',
    proposedAt: '2026-10-23T02:00:00Z',
    supportingIds: ['mem_01'],
    rationale: 'Shared upwind sources and similar lag.',
  },
];

export const CONFLICTS: Conflict[] = [
  {
    id: 'cf_1',
    detectedAt: '2026-10-20T14:11:00Z',
    summary: 'Is Samarahan station representative of Kuching?',
    aId: 'mem_04',
    bId: 'mem_03',
  },
];

export const SLEEP_PREVIEW: SleepPreview = {
  toConsolidate: ['mem_07'],
  toArchive: ['mem_06'],
  toSynthesize: ['mem_03', 'mem_04'],
};

export const REPORTS: MaintenanceReport[] = [
  { id: 'rp_3', ranAt: '2026-10-25T02:00:00Z', backupId: 'bk_20261025', consolidated: 4, archived: 2, synthesized: 1, restored: false },
  { id: 'rp_2', ranAt: '2026-10-18T02:00:00Z', backupId: 'bk_20261018', consolidated: 7, archived: 0, synthesized: 2, restored: false },
  { id: 'rp_1', ranAt: '2026-10-11T02:00:00Z', backupId: 'bk_20261011', consolidated: 3, archived: 5, synthesized: 0, restored: true },
];

export const AUDIT: AuditEvent[] = [
  { id: 'au_6', at: '2026-10-25T11:05:00Z', action: 'feedback', actor: 'user', memoryId: 'mem_01', detail: 'Marked helpful on rc_1' },
  { id: 'au_5', at: '2026-10-25T02:00:00Z', action: 'synthesize', actor: 'sleep-cycle', memoryId: null, detail: 'Sleep cycle executed (backup bk_20261025)' },
  { id: 'au_4', at: '2026-10-20T14:11:00Z', action: 'update', actor: 'agent', memoryId: 'mem_03', detail: 'Conflict cf_1 detected with mem_04' },
  { id: 'au_3', at: '2026-10-12T05:00:00Z', action: 'update', actor: 'agent', memoryId: 'mem_05', detail: 'Captured preference' },
  { id: 'au_2', at: '2026-10-01T00:00:00Z', action: 'ledger_rotated', actor: 'system', memoryId: null, detail: 'Audit ledger rotated' },
  { id: 'au_1', at: '2026-09-02T08:00:00Z', action: 'update', actor: 'reviewer', memoryId: 'mem_01', detail: 'Narrowed lag window' },
];

export const STATUS = {
  capture: 'on' as 'on' | 'off',
  recall: 'on' as 'on' | 'off',
};
