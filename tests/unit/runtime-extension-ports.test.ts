import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  ExecutionRegistry,
  type ToolDefinition,
} from '../../app/orchestration/ports.js';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';
import { managerAgent } from '../../app/agents/manager/index.js';

function tool(id: string, description = id): ToolDefinition {
  return {
    id,
    version: '1',
    mode: 'fixture',
    description,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    execute: (input) => Promise.resolve(input),
  };
}

describe('generic runtime extension ports', () => {
  it('rebinds tools only for the same extension owner and removes its retired tools', () => {
    const registry = new ExecutionRegistry();
    const first = tool('extension.first');
    registry.registerExtensionTools('owner', [
      first,
      tool('extension.retired'),
    ]);
    const replacement = tool('extension.first', 'New runtime binding');
    registry.registerExtensionTools('owner', [replacement]);
    expect(registry.tools.get(first.id)).toBe(replacement);
    expect(registry.tools.has('extension.retired')).toBe(false);
    expect(() =>
      registry.registerExtensionTools('other-owner', [tool(first.id)]),
    ).toThrow('Duplicate registration');
    expect(registry.tools.get(first.id)).toBe(replacement);
  });
  it('rejects base-tool and within-batch collisions without partially replacing tools', () => {
    const registry = new ExecutionRegistry();
    const base = tool('core.base'),
      original = tool('extension.first');
    registry.registerTool(base).registerExtensionTools('owner', [original]);
    expect(() =>
      registry.registerExtensionTools('owner', [
        tool(original.id),
        tool(base.id),
      ]),
    ).toThrow('Duplicate registration');
    expect(registry.tools.get(original.id)).toBe(original);
    expect(registry.tools.get(base.id)).toBe(base);
    expect(() =>
      registry.registerExtensionTools('new-owner', [
        tool('extension.duplicate'),
        tool('extension.duplicate'),
      ]),
    ).toThrow('Duplicate registration');
    expect(registry.tools.has('extension.duplicate')).toBe(false);
  });
  it('registers store-bound tools before grants and serves extension task views behind task identity checks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haze-extension-ports-'));
    const registry = new ExecutionRegistry();
    registry.registerAgent(managerAgent);
    registry.registerAgent({
      id: 'WorkerShield',
      version: '1',
      instructions: 'Use exact registered tools.',
    });
    registry.registerCapability({
      card: {
        id: 'extension-test',
        version: '1',
        purpose: 'Exercise generic extension ports.',
        work_products: ['extension.test'],
        required_tools: ['extension.test.read'],
        roles: ['WorkerShield'],
        readiness: 'implemented',
        limitations: ['Unit fixture only.'],
      },
      matches: () => true,
      assignments: () => [],
    });
    let viewCalls = 0;
    registry.registerExtension((host) => ({
      id: 'extension-test',
      tools: [tool('extension.test.read')],
      taskViews: {
        'extension-test': (taskId, identity) => {
          viewCalls++;
          return {
            task_id: host.readTask(taskId, identity).id,
            principal: identity.principal,
          };
        },
      },
    }));
    const runtime = new TaskRuntime({
      stateDirectory: directory,
      registry,
      mode: 'fixture',
      dispatchTask: () => undefined,
    });
    try {
      const { task_id } = runtime.admit(
        {
          schema_version: 'haze.task.request.v3',
          objective: 'Inspect the extension fixture.',
        },
        'extension-ports',
      );
      expect(
        runtime.store.read(task_id, localTaskIdentity).permissions.tools,
      ).toContain('extension.test.read');
      expect(runtime.readTaskView(task_id, 'extension-test')).toEqual({
        task_id,
        principal: localTaskIdentity.principal,
      });
      expect(viewCalls).toBe(1);
      expect(() =>
        runtime.readTaskView(task_id, 'extension-test', {
          principal: 'other',
          workspace: localTaskIdentity.workspace,
        }),
      ).toThrow();
      expect(viewCalls).toBe(1);
      expect(() => runtime.readTaskView(task_id, 'unregistered-view')).toThrow(
        'Task view is not registered',
      );
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
