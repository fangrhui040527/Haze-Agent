import type { Artifact, ArtifactRef } from '../../contracts/artifacts.js';
import type {
  TaskIdentity,
  TaskRecord,
  TaskRequest,
  TaskResult,
} from '../../contracts/tasks.js';
import type {
  ControlReceipt,
  TaskControl,
  TaskUpdate,
} from '../../contracts/controls.js';
import type { ReductionPreviewView } from '../../contracts/damage-reduction-view.js';
import type { PilotTaskView } from '../../contracts/damage-reduction-pilot.js';
import type { EvaluationTaskView } from '../../contracts/damage-reduction-evaluation.js';

export interface ProgrammeScope extends TaskIdentity {
  mode: TaskRecord['mode'];
}
export interface ProgrammeHost {
  mode: TaskRecord['mode'];
  atomic<T>(operation: () => T): T;
  afterCommit(operation: () => void): void;
  /** Share only synchronous read work; the outer operation always drops its cache. */
  withEvidenceRead?<T>(operation: () => T): T;
  readTask(taskId: string, identity: TaskIdentity): TaskRecord;
  readArtifact(ref: ArtifactRef, identity: TaskIdentity): Artifact;
  assertEvidenceCurrent(ref: ArtifactRef, identity: TaskIdentity): void;
  pinTaskInputs(
    taskId: string,
    refs: ArtifactRef[],
    identity: TaskIdentity,
  ): void;
  previewView(taskId: string, identity: TaskIdentity): ReductionPreviewView;
  pilotView?(taskId: string, identity: TaskIdentity): PilotTaskView;
  evaluationView?(taskId: string, identity: TaskIdentity): EvaluationTaskView;
  /** Admission is transaction-aware and schedules only after the outer commit. */
  admitTask(
    request: TaskRequest,
    key: string,
    identity: TaskIdentity,
  ): {
    task_id: string;
    status_url: string;
    events_url: string;
    reused: boolean;
  };
  updateTask(
    taskId: string,
    input: TaskUpdate,
    key: string,
    identity: TaskIdentity,
  ): ControlReceipt;
  controlTask(
    taskId: string,
    input: TaskControl,
    key: string,
    identity: TaskIdentity,
  ): ControlReceipt;
  runResult(
    taskId: string,
    runId: string,
    identity: TaskIdentity,
    objectiveRevision?: number,
  ): TaskResult | undefined;
}
export interface ProgrammeCoordination {
  owner_id: string;
  expected_revision: number;
}
export interface ProgrammeTaskMutation {
  kind: 'update' | 'control';
  before: TaskRecord;
  input: TaskUpdate | TaskControl;
  key: string;
  identity: TaskIdentity;
}
