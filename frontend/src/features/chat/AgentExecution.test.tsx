import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  demoAgentIds,
  type DemoAgentExecution,
} from '../../../../app/demo/agent-contract.ts';
import { AgentExecution } from './AgentExecution.tsx';

const execution: DemoAgentExecution = {
  provider: 'test-provider',
  model: 'test-model',
  steps: demoAgentIds.map((agent) => ({
    agent,
    kind: agent === 'worldmodel' || agent === 'hmem' ? 'engine' : 'model',
    summary:
      agent === 'manager'
        ? '<script>untrusted commentary</script>'
        : `${agent} receipt`,
  })),
};

describe('agent execution receipts', () => {
  it('labels every actual role and treats model commentary as text', () => {
    const markup = renderToStaticMarkup(
      createElement(AgentExecution, { execution }),
    );
    expect(markup).toContain('<summary>Agent execution</summary>');
    expect(markup).toContain('test-provider');
    expect(markup).toContain('test-model');
    expect(markup).toContain('World Model');
    expect(markup).toContain('H-Mem');
    expect(markup.match(/Deterministic engine/g)).toHaveLength(2);
    expect(markup.match(/AI model/g)).toHaveLength(4);
    expect(markup).toContain(
      '&lt;script&gt;untrusted commentary&lt;/script&gt;',
    );
    expect(markup).not.toContain('<script>');
    expect(markup).toContain(
      'checked schedule below supplies the numerical comparison',
    );
  });

  it('rejects malformed saved receipts before claiming a role executed', () => {
    const markup = renderToStaticMarkup(
      createElement(AgentExecution, {
        execution: { ...execution, steps: execution.steps.slice(1) },
      }),
    );
    expect(markup).toContain('could not be validated');
    expect(markup).not.toContain('<summary>Agent execution</summary>');
    expect(markup).not.toContain('test-provider');
  });
});
