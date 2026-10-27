import { randomUUID } from 'node:crypto';
import type {
  ManagerAction,
  ManagerContext,
  ManagerDecision,
} from '../../contracts/manager.js';

/** Explicit synthetic policy for deterministic runtime checks; never a live-model fallback. */
export function fixtureDecision(context: ManagerContext): ManagerDecision {
  const decision = (
    action: ManagerAction,
    explanation: string,
    references: ManagerDecision['references'] = [],
  ): ManagerDecision => ({
    id: randomUUID(),
    run_id: context.run_id,
    generation: context.generation,
    objective_revision: context.objective_revision,
    plan_revision: context.plan_revision,
    event_cursor: context.event_cursor,
    explanation,
    references,
    ...(!context.interpretation
      ? {
          interpretation: {
            scope: context.request.objective,
            deliverables: context.request.desired_deliverables.length
              ? context.request.desired_deliverables
              : ['A source-backed answer with explicit gaps.'],
            assumptions: [],
            intended_use: 'Evidence investigation and explanation.',
            stopping_conditions: [
              'Deliver supported findings or state the exact missing evidence.',
            ],
          },
        }
      : {}),
    action,
  });
  const work = context.assignments.filter(
    (a) => !['cancelled', 'stale'].includes(a.status),
  );
  const originalRefs = [
    ...context.request.context_refs,
    ...context.corrections.flatMap((c) => c.context_refs ?? []),
  ];
  if (context.objective_revision > 1) {
    const source = originalRefs.find(
      (ref) =>
        !context.source_applicability.some((a) => a.id === ref.id && a.current),
    );
    if (source) {
      if (!context.inspections.some((i) => i.artifact.id === source.id))
        return decision(
          { type: 'inspect', artifacts: [source] },
          'Inspect the explicitly supplied source before assessing corrected-scope relevance.',
          [source],
        );
      return decision(
        {
          type: 'applicability',
          artifact: source,
          applicable: true,
          reason:
            'The corrected request continues to explicitly supply this source; use it as evidence only within the corrected scope.',
        },
        'Record source relevance after inspecting its retained content and the exact correction.',
        [source],
      );
    }
  }
  const templates = context.capabilities.find(
    (c) => c.available && c.templates?.length,
  );
  if (
    !work.length ||
    context.plan_objective_revision !== context.objective_revision ||
    work.some(
      (a) =>
        (a.objective_revision ?? context.objective_revision) !==
        context.objective_revision,
    )
  ) {
    if (templates)
      return decision(
        {
          type: 'apply_plan',
          assignments: (templates.templates ?? []).map((p) => ({
            ...p,
            input: p.input as never,
          })),
          retain_assignment_ids: [],
          reason:
            context.objective_revision > 1
              ? 'Replace held work under the exact corrected objective.'
              : 'Use the registered starting plan for this fixture case.',
        },
        'Admit registered work with its complete dependency graph and independent reviews.',
      );
  }
  for (const capability of context.capabilities)
    for (const requirement of capability.peer_requirements ?? []) {
      const pair = requirement.definitions.map((id) =>
        work.find((a) => a.definition_id === id),
      );
      const first = pair[0],
        second = pair[1];
      if (
        first &&
        second &&
        !context.peer_grants.some(
          (grant) =>
            grant.purpose === requirement.purpose &&
            [first, second].every((a) =>
              grant.participants.some(
                (p) => p.assignment_id === a.id && p.revision === a.revision,
              ),
            ),
        )
      )
        return decision(
          {
            type: 'coordinate',
            participants: [
              { assignment_id: first.id, revision: first.revision },
              { assignment_id: second.id, revision: second.revision },
            ],
            purpose: requirement.purpose,
          },
          'Grant the registered peer clarification purpose to two exact current revisions.',
        );
    }
  const escalation = context.events.findLast(
    (e) =>
      e.type === 'specialist_escalated' &&
      typeof e.data === 'object' &&
      e.data !== null &&
      !Array.isArray(e.data) &&
      (e.data.reason === 'missing_dependency' ||
        e.data.kind === 'missing_dependency'),
  );
  if (escalation)
    return decision(
      { type: 'question', prompt: escalation.message.slice(0, 2000) },
      'The missing input materially affects correctness; ask the exact specialist question.',
    );
  const request = context.events.find(
    (e) =>
      e.type === 'specialist_escalated' &&
      typeof e.data === 'object' &&
      e.data !== null &&
      'recipient' in e.data,
  );
  if (
    request &&
    request.assignment_id &&
    typeof request.data === 'object' &&
    request.data !== null &&
    !Array.isArray(request.data)
  ) {
    const recipientId = request.data.recipient;
    const sender = work.find((a) => a.id === request.assignment_id),
      recipient = work.find((a) => a.id === recipientId);
    if (sender && recipient)
      return decision(
        {
          type: 'coordinate',
          participants: [
            { assignment_id: sender.id, revision: sender.revision },
            { assignment_id: recipient.id, revision: recipient.revision },
          ],
          purpose:
            typeof request.data.purpose === 'string'
              ? request.data.purpose
              : 'Scoped evidence clarification',
        },
        'Grant the requested peer exchange for these exact assignment revisions.',
      );
  }
  if (
    work.some((a) =>
      ['queued', 'running', 'waiting', 'paused'].includes(a.status),
    ) &&
    !work.some((a) => a.status === 'failed')
  )
    return decision(
      {
        type: 'wait',
        reason:
          'Wait for material specialist output, a question or an escalation.',
      },
      'Unrelated admitted work may continue; routine progress does not need another decision.',
    );
  const rejected = new Set(
    context.reviews
      .filter((c) => c.verdict !== 'supported')
      .map((c) => c.artifact.id),
  );
  const products = context.artifacts.filter((a) => {
    const producerId =
      a.assignment_id ?? context.assignments[a.assignment_index ?? -1]?.id;
    return (
      a.current &&
      producerId !== undefined &&
      !a.kind.includes('review') &&
      a.kind !== 'assignment.summary' &&
      !rejected.has(a.ref.id) &&
      work.some(
        (w) =>
          w.id === producerId &&
          w.revision === (a.assignment_revision ?? w.revision) &&
          w.status === 'completed' &&
          w.usability === 'usable',
      )
    );
  });
  const sources = context.artifacts.filter(
    (a) =>
      a.current &&
      !a.kind.includes('review') &&
      (originalRefs.some((r) => r.id === a.ref.id) ||
        a.kind.endsWith('.capture')),
  );
  const summaries = context.artifacts
    .filter((a) => a.current && a.kind === 'assignment.summary')
    .flatMap((a) => {
      try {
        const content = JSON.parse(a.excerpt ?? '') as { summary?: string };
        return content.summary ? [content.summary] : [];
      } catch {
        return [];
      }
    });
  const uncertainty = [
    ...new Set([
      ...work.flatMap((a) => a.gaps ?? []),
      ...context.reviews.flatMap((c) => c.limitations),
    ]),
  ].slice(0, 64);
  const unfinished = [
    ...work
      .filter((a) => a.status !== 'completed' || a.support === 'gap')
      .map((a) =>
        (
          a.error?.message.trim() ||
          a.brief?.trim() ||
          `Unfinished ${a.definition_id ?? a.role} assignment ${a.id}: ${a.status}, ${a.support}.`
        ).slice(0, 4096),
      ),
    ...context.reviews
      .filter((c) => c.verdict !== 'supported')
      .map((c) => `Independent review unresolved for ${c.artifact.id}.`),
  ];
  let sourceIndex = 0,
    captureIndex = 0;
  const answer =
    (summaries.length
      ? summaries.join('\n\n')
      : 'The available registered evidence does not establish the requested findings.'
    ).slice(0, 24000) +
    (sources.length
      ? '\n\nSources: ' +
        sources
          .map(
            (a) =>
              `[${a.kind === 'source.import' ? 'S' + String(++sourceIndex) : 'E' + String(++captureIndex)}]`,
          )
          .join(', ') +
        '.'
      : '');
  return decision(
    {
      type: 'finalize',
      answer,
      work_products: products.map((a) => a.ref),
      sources: sources.map((a) => a.ref),
      uncertainty,
      unfinished: unfinished.slice(0, 64),
    },
    'Deliver only current supported material and identify unfinished work; no unchanged failed work is retried.',
    products.map((a) => a.ref),
  );
}
