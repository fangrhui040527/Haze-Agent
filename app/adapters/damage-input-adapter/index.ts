import {
  DAMAGE_WORLD_TOOL_ID,
  damageWorldQuerySchema,
  damageWorldResolutionSchema,
  type DamageWorldQuery,
  type DamageWorldResolution,
} from '../../contracts/damage-world.js';
import type {
  ExecutionMode,
  StatefulToolStore,
  ToolDefinition,
} from '../../orchestration/ports.js';
import { WorldModelDamageInputAdapter } from './adapter.js';
import type { DamageWorldInputPolicy } from './ports.js';

export { WorldModelDamageInputAdapter } from './adapter.js';
export { readDamageWorldSelection } from './selection.js';
export type {
  DamageWorldInputPolicy,
  DamageWorldRequest,
  DamageWorldScope,
} from './ports.js';

export function createWorldModelDamageInputTool(
  store: StatefulToolStore,
  mode: ExecutionMode,
  policy: DamageWorldInputPolicy,
): ToolDefinition<DamageWorldQuery, DamageWorldResolution> {
  const adapter = new WorldModelDamageInputAdapter(store, mode, policy);
  return {
    id: DAMAGE_WORLD_TOOL_ID,
    version: '1',
    mode,
    description:
      'Select compatible World Model accounting evidence, recheck access and currency, pin exact originals and reconstruct deterministic damage inputs. Missing evidence stays unestimated.',
    inputSchema: damageWorldQuerySchema,
    outputSchema: damageWorldResolutionSchema,
    execute: (query, context) =>
      Promise.resolve(adapter.resolve(query, context)),
  };
}
