import type { AgentModel } from '../adapters/agent-model.js';
import type {
  EffectiveModelRoute,
  ModelReadiness,
  ModelRouteSnapshot,
} from '../contracts/model-routes.js';

/** Runtime-owned admission and dispatch interface; agents never select transports. */
export interface ModelRouteService {
  snapshot(): ModelRouteSnapshot;
  resolve(route: EffectiveModelRoute): AgentModel;
  /** Read-only negotiation before a remote operation spends its call budget. */
  prepare?(
    route: EffectiveModelRoute,
    signal: AbortSignal,
  ): Promise<AgentModel>;
  readiness(): Promise<ModelReadiness>;
}
