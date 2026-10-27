import type { AgentModel } from '../adapters/agent-model.js';
import type {
  ManagerChatCitation,
  ManagerChatError,
  ManagerChatQuestion,
  ManagerChatRequest,
} from '../contracts/manager-chat.js';
import type { TaskIdentity, TaskRequest } from '../contracts/tasks.js';
import type { TaskStore } from '../tasks/store.js';
import type { ModelRouteService } from './model-service.js';
import type { ExecutionMode } from './ports.js';

export type ManagerConversationResolution =
  | {
      kind: 'reply' | 'clarification';
      paragraphs: string[];
      citations: ManagerChatCitation[];
      error?: ManagerChatError;
    }
  | {
      kind: 'start_task';
      request: TaskRequest;
      title: string;
      paragraphs: string[];
      citations: ManagerChatCitation[];
    }
  | {
      kind: 'answer_task';
      answer_to: ManagerChatQuestion;
      passage: string;
      paragraphs: string[];
      citations: ManagerChatCitation[];
    };

export interface ManagerConversationService {
  resolve(
    request: ManagerChatRequest,
    identity: TaskIdentity,
    signal: AbortSignal,
  ): Promise<ManagerConversationResolution>;
}
export interface ManagerConversationFactoryOptions {
  store: TaskStore;
  mode: ExecutionMode;
  env: NodeJS.ProcessEnv;
  model?: AgentModel;
  modelRoutes: ModelRouteService;
  diagnostic: (category: ManagerChatError['category'], error: unknown) => void;
}
export type ManagerConversationFactory = (
  options: ManagerConversationFactoryOptions,
) => ManagerConversationService;
