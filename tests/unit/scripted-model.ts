import { randomUUID } from 'node:crypto';
import type { AgentModel } from '../../app/adapters/agent-model.js';
import {
  PM25_CHECK_ID,
  PM25_COVERAGE_ID,
} from '../../app/capabilities/pm25/index.js';
import { PM25_SOURCE_ID } from '../../app/capabilities/pm25/evidence.js';

/**
 * Model-driven specialists need a provider even in fixture mode, because
 * fixture mode substitutes the data source and never the reasoning. This
 * scripts the minimum compliant action sequence so runtime behaviour stays
 * assertable offline: call the granted method, persist its exact output by
 * reference, then finish. It deliberately does no arithmetic of its own.
 */

const KIND_BY_TOOL: Record<string, string> = {
  [PM25_SOURCE_ID]: 'pm25.capture',
  [PM25_COVERAGE_ID]: 'pm25.analysis',
  [PM25_CHECK_ID]: 'review',
};

interface SpecialistContext {
  purpose?: string;
  history?: unknown[];
  tools?: { id?: string }[];
  peers?: { id?: string; definition_id?: string }[];
  input?: unknown;
  citations?: { id?: string }[];
  capabilities?: { card?: { id?: string }; template?: unknown }[];
}

function artifactRef(entry: unknown): unknown {
  return typeof entry === 'object' && entry !== null && 'artifact' in entry
    ? entry.artifact
    : undefined;
}

/** The id of a dispatched tool action that already returned output. */
function dispatchedTool(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  if (!('action' in entry) || !('output' in entry)) return undefined;
  const action = (entry as { action: unknown }).action;
  if (
    typeof action !== 'object' ||
    action === null ||
    (action as { type?: unknown }).type !== 'tool'
  )
    return undefined;
  const id = (action as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

function needsScope(input: unknown): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    (input as { needs_scope?: unknown }).needs_scope === true
  );
}

export function scriptedAgentModel(): AgentModel {
  return {
    selection: { provider: 'scripted', model: 'scripted-specialist' },
    complete(request) {
      const context = (request.context ?? {}) as SpecialistContext;

      if (context.purpose === 'synthesis') {
        const citation = context.citations?.[0]?.id;
        return Promise.resolve(
          JSON.stringify({
            answer: citation
              ? `Scripted synthesis of the accepted work products [${citation}].`
              : 'Scripted synthesis with no supplied citations.',
            uncertainty: ['Scripted synthesis asserts no scientific review.'],
          }),
        );
      }

      if (context.purpose === 'plan') {
        const capability = context.capabilities?.[0];
        return Promise.resolve(
          JSON.stringify({
            id: `plan-${randomUUID()}`,
            type: 'delegate',
            capability: capability?.card?.id ?? '',
            assignments: capability?.template ?? [],
          }),
        );
      }

      const history = context.history ?? [];
      const tool = context.tools?.[0]?.id;

      if (!tool) {
        return Promise.resolve(
          JSON.stringify({
            id: `finish-${randomUUID()}`,
            type: 'finish',
            summary: 'No granted method is available for this assignment.',
            support: 'gap',
            uncertainty: ['No registered deterministic method was granted.'],
            outputs: [],
          }),
        );
      }

      // An undetermined scope is asked about once, never guessed.
      if (tool === PM25_SOURCE_ID && needsScope(context.input)) {
        return Promise.resolve(
          JSON.stringify({
            id: `ask-${randomUUID()}`,
            type: 'question',
            prompt:
              'Which town and UTC start/end should the PM2.5 investigation cover?',
          }),
        );
      }

      // Decide from what the history actually contains, never from its
      // length: a resumed or corrected assignment is seeded with earlier
      // attempt records, so turn counting drifts.
      const dispatched = history.find(
        (entry) => dispatchedTool(entry) !== undefined,
      );
      const persisted = history.find(
        (entry) => artifactRef(entry) !== undefined,
      );

      if (!dispatched) {
        return Promise.resolve(
          JSON.stringify({
            id: `call-${randomUUID()}`,
            type: 'tool',
            tool,
            // The source method takes the scope directly; the derived
            // methods read their evidence from pinned inputs.
            input:
              tool === PM25_SOURCE_ID
                ? context.input
                : { scope: context.input },
          }),
        );
      }

      if (!persisted) {
        return Promise.resolve(
          JSON.stringify({
            id: `keep-${randomUUID()}`,
            type: 'save_tool_result',
            kind: KIND_BY_TOOL[tool] ?? 'assignment.summary',
            tool_action_id: dispatchedTool(dispatched)!,
          }),
        );
      }

      // The verdict lives in the saved review. The producing assignment has
      // already completed by the time the reviewer runs, because the analysis
      // is a pinned dependency, so there is no open participant to message.
      const saved = artifactRef(persisted);

      // The reviewer carries the verdict the checking method returned; it
      // never decides validity on its own reading of the figures.
      const verdict = (dispatched as { output?: { valid?: unknown } }).output;
      const support =
        tool === PM25_CHECK_ID
          ? verdict?.valid === true
            ? 'supported'
            : 'gap'
          : 'partial';

      return Promise.resolve(
        JSON.stringify({
          id: `finish-${randomUUID()}`,
          type: 'finish',
          summary: 'Scripted specialist completed its granted method.',
          support,
          uncertainty: [
            'Scripted specialist states no observation or attribution evidence.',
          ],
          outputs: saved ? [saved] : [],
        }),
      );
    },
  };
}
