import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../dashboard/useAgentRun.ts';
import {
  artifactRef,
  fixtureManager,
  fixtureTask,
  receipt,
  taskId,
} from '../../services/agents/testFixtures.ts';
import { WorkProducts } from '../chat/WorkProducts.tsx';
import { DamageAccountView } from './DamageAccountPage.tsx';

function accountRun(saved = true): AgentRun {
  return {
    events: [],
    status: saved ? 'completed' : 'idle',
    statusText: saved
      ? 'Answer ready.'
      : 'Agents are idle. Describe a task to start.',
    startedAt: null,
    serviceLabel: 'Fixture',
    ask: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
    task: saved
      ? {
          id: taskId,
          taskUrl: `https://account.example/api/tasks/${taskId}`,
          schemaVersion: 'haze.task.v3',
          status: 'completed',
          record: fixtureTask(),
        }
      : null,
    operationPending: false,
    operationError: null,
    receipt: null,
    control: vi.fn(),
    update: vi.fn(),
    importSource: vi.fn(),
    capabilities: [],
    capabilitiesError: null,
    latestAnswer: null,
  };
}

function render(run: AgentRun, savedTaskId?: string) {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(DamageAccountView, { taskId: savedTaskId, run }),
    ),
  );
}

describe('dedicated damage accounting page', () => {
  it('starts with a request-only World Model intake and keeps dashboard navigation available', () => {
    const markup = render(accountRun(false));
    expect(markup).toContain('<h1>Damage accounting</h1>');
    expect(markup).toMatch(/href="\/"[^>]*>Back to the dashboard/);
    expect(markup).toContain('Create an account');
    expect(markup).not.toContain('id="damage-source"');
    expect(markup).not.toContain('type="file"');
    expect(markup).not.toContain('Paste a source');
    expect(markup).toContain('id="damage-objective"');
    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*>Build account<\/button>/,
    );
    expect(markup).toContain('No upload is required.');
    expect(markup).toContain('World Model evidence');
    expect(markup).toContain('Open a saved task');
    expect(markup).toContain('The dashboard keeps its own task and office.');
    expect(markup).not.toContain('Account results');
    expect(markup).not.toContain('Pixel-art office');
    expect(markup).not.toContain('Open Manager workspace');
  });

  it('opens a saved result with exact artifacts, execution mode and retained next requirements', () => {
    const run = accountRun();
    run.task!.record!.manager = fixtureManager();
    const actual = receipt(1, 'assignment.completed', 'EvidenceCritic');
    run.events = [
      {
        type: 'task_event',
        runId: actual.run_id,
        at: actual.at,
        message: actual.message,
        receipt: actual,
      },
    ];
    const markup = render(run, taskId);
    expect(markup).toContain('Saved accounting task');
    expect(markup).not.toContain('id="damage-objective"');
    expect(markup).toMatch(
      /href="\/damage-account"[^>]*>Create another account/,
    );
    expect(markup).toContain('Task completed');
    expect(markup).toContain('Execution mode: fixture. Objective revision 1.');
    expect(markup).toContain('Account results');
    expect(markup).toContain('Review: needs review.');
    expect(markup).toContain('Current saved result.');
    expect(markup).toContain(
      `href="https://account.example/api/artifacts/${artifactRef.id}"`,
    );
    expect(markup).toContain(`SHA-256 ${artifactRef.sha256}`);
    expect(markup).toContain('Loading work product...');
    expect(markup).toContain('The source supports a limited explanation. [E1]');
    expect(markup).toContain('Provide direct observations.');
    expect(markup).toContain('Task coordination and execution receipts (1)');
    expect(markup).toContain('EvidenceCritic');
    expect(markup).toContain('Actual assignment.completed');
    expect(markup).toContain(`href="/manager/${taskId}"`);
    expect(markup).toContain('Open Manager workspace');
    expect(markup.indexOf('Open Manager workspace')).toBeLessThan(
      markup.indexOf('Task coordination and execution receipts'),
    );
    expect(markup).not.toContain('id="manager-workspace-title"');
    expect(markup).not.toContain('Interpreted objective');
    expect(markup).not.toContain('Manager decisions and execution details');
  });

  it('marks rejected historical results before artifacts load', () => {
    const run = accountRun();
    run.task!.record!.result!.currency = 'stale';
    run.task!.record!.result!.review.status = 'rejected';
    run.task!.record!.result!.review.checks = [
      {
        artifact: artifactRef,
        producer_assignment_id: taskId,
        producer_revision: 2,
        reviewer_assignment_id: artifactRef.id,
        reviewer_revision: 3,
        review_artifact: { ...artifactRef, id: taskId },
        verdict: 'rejected',
        limitations: [
          'The imported population does not match the account scope.',
        ],
      },
    ];
    const markup = render(run, taskId);
    expect(markup).toContain('Review: rejected.');
    expect(markup).toContain(
      'Historical result; a correction requires a current account.',
    );
    expect(markup).toContain(
      'This artifact was rejected in review. Domain calculations are',
    );
    expect(markup).toContain('withheld.');
    expect(markup).toContain('Independent review checks (1)');
    expect(markup).toContain('Producer revision 2. Reviewer revision 3.');
    expect(markup).toContain(
      'The imported population does not match the account scope.',
    );
    expect(markup).toContain(
      `href="https://account.example/api/artifacts/${taskId}"`,
    );
    expect(markup).toContain('Open exact review');
    expect(markup).not.toContain('Current saved result.');
  });

  it('shows restoration and server failures without hiding the retained saved result', () => {
    const loading = accountRun(false);
    expect(render(loading, taskId)).toContain('Loading saved task');
    loading.observationError =
      'The saved accounting task could not be read (503).';
    expect(render(loading, taskId)).toContain(
      'role="alert">The saved accounting task could not be read (503).',
    );
    expect(render(loading, taskId)).toContain('Saved task unavailable');

    const partial = accountRun();
    partial.status = 'failed';
    partial.statusText = 'An imported quantity is missing.';
    partial.task!.record!.status = 'failed';
    partial.task!.record!.error = {
      code: 'INPUT_MISSING',
      message: partial.statusText,
    };
    const markup = render(partial, taskId);
    expect(markup).toContain('role="alert">An imported quantity is missing.');
    expect(markup).toContain('Task failed');
    expect(markup).toContain('Account results');
    expect(markup).toContain('Provide direct observations.');
    expect(markup).not.toContain('Stop waiting</button>');
  });

  it('keeps original work products collapsed without accounting page or loading panels', () => {
    const markup = renderToStaticMarkup(
      createElement(WorkProducts, { products: [artifactRef] }),
    );
    expect(markup).toContain('Saved work product');
    expect(markup).toContain('Open exact artifact');
    expect(markup).not.toContain('<details open="">');
    expect(markup).not.toContain('Loading work product...');
    expect(markup).not.toContain('Damage accounting');
    expect(markup).not.toContain('Account component records');
    expect(markup).not.toContain('Physical outcomes');
  });
});
