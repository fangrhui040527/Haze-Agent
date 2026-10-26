import type {
  AgentAnswer,
  AgentEvent,
  AskRequest,
  AgentTaskHandle,
} from '../../shared/types/agents.ts';
import type { TaskRecord } from '../../../../app/contracts/tasks.ts';
import type {
  Artifact,
  ArtifactImport,
} from '../../../../app/contracts/artifacts.ts';
import type { CapabilityCard } from '../../../../app/contracts/capabilities.ts';
import type {
  ControlReceipt,
  TaskControl,
  TaskUpdate,
} from '../../../../app/contracts/controls.ts';
import type {
  WorldRecordReadResponse,
  WorldTaskResponse,
} from '../../../../app/contracts/world-api.ts';

export interface AgentService {
  readonly label: string;
  ask(
    request: AskRequest,
    onEvent: (event: AgentEvent) => void,
    signal: AbortSignal,
    onTask?: (task: AgentTaskHandle) => void,
  ): Promise<AgentAnswer>;
  watchTask?(
    taskId: string,
    onEvent: (event: AgentEvent) => void,
    signal: AbortSignal,
    onTask?: (task: AgentTaskHandle) => void,
  ): Promise<AgentAnswer>;
  readTask?(taskId: string, signal?: AbortSignal): Promise<TaskRecord>;
  updateTask?(
    taskId: string,
    update: TaskUpdate,
    operationKey: string,
    signal?: AbortSignal,
  ): Promise<ControlReceipt>;
  controlTask?(
    taskId: string,
    control: TaskControl,
    operationKey: string,
    signal?: AbortSignal,
  ): Promise<ControlReceipt>;
  importSource?(
    source: ArtifactImport,
    operationKey: string,
    signal?: AbortSignal,
  ): Promise<Artifact>;
  readArtifact?(artifactId: string, signal?: AbortSignal): Promise<Artifact>;
  readWorldTask?(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<WorldTaskResponse>;
  readWorldRecord?(
    recordId: string,
    view: 'detail' | 'history' | 'lineage',
    options?: { limit?: number; cursor?: string },
    signal?: AbortSignal,
  ): Promise<WorldRecordReadResponse>;
  capabilities?(signal?: AbortSignal): Promise<CapabilityCard[]>;
}
export class AgentTaskCancelledError extends Error {
  constructor() {
    super('The server cancelled this task. Saved artifacts remain available.');
    this.name = 'AgentTaskCancelledError';
  }
}
export class AgentRunError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'AgentRunError';
    this.retryable = retryable;
  }
}
