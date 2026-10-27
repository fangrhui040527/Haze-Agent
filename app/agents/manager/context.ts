import type { Artifact, ArtifactRef } from '../../contracts/artifacts.js';
import type {
  TaskEvent,
  TaskRecord,
  TaskRequest,
} from '../../contracts/tasks.js';
import { TaskError } from '../../contracts/tasks.js';
import {
  managerAssignmentPlanSchema,
  type ArtifactReviewCheck,
  type ManagerState,
} from '../../contracts/manager.js';
import type { ExecutionRegistry } from '../../orchestration/ports.js';

export type { ManagerContext } from '../../contracts/manager.js';
import type { ManagerContext } from '../../contracts/manager.js';
const exact = ({ id, version, sha256 }: ArtifactRef): ArtifactRef => ({
  id,
  version,
  sha256,
});
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Original constraints and correction passages are mandatory; optional evidence is explicitly bounded. */
export function assembleManagerContext(
  task: TaskRecord,
  registry: ExecutionRegistry,
  state: ManagerState,
  options: {
    events: TaskEvent[];
    artifacts: Artifact[];
    maxBytes?: number;
    reviews?: ArtifactReviewCheck[];
  },
): ManagerContext {
  const latestScope = [...task.corrections]
    .reverse()
    .find((item) => item.scope !== undefined)?.scope;
  const request: TaskRequest = {
    ...task.original_request,
    ...(latestScope !== undefined ? { scope: latestScope } : {}),
  };
  const scopedCorrection = [...task.corrections]
    .reverse()
    .find((c) => c.scope !== undefined);
  const templateRequest = {
    ...request,
    // Text-only corrections must reach the plan templates too, not only capability matching.
    objective: scopedCorrection
      ? scopedCorrection.passage
      : [request.objective, ...task.corrections.map((c) => c.passage)].join(
          '\n',
        ),
  };
  const matchingRequest = {
    ...request,
    objective: [
      request.objective,
      ...task.corrections.map((c) => c.passage),
    ].join('\n'),
  };
  const currentPlan =
    state.plans.at(-1)?.objective_revision === task.objective_revision;
  const relevantCapabilities = new Set(
    [...registry.capabilities.values()]
      .filter(
        (capability) =>
          (!currentPlan && capability.matches(matchingRequest)) ||
          task.assignments.some(
            (assignment) =>
              assignment.capability === capability.card.id &&
              assignment.run_id === task.current_run_id &&
              !['cancelled', 'stale'].includes(assignment.status),
          ),
      )
      .map((capability) => capability.card.id),
  );
  // Ordering highlights relevant catalog entries without selecting an action
  // or hiding other registered capabilities from the Manager.
  const capabilityCatalogue = [...registry.capabilities.values()].toSorted(
    (left, right) =>
      Number(relevantCapabilities.has(right.card.id)) -
      Number(relevantCapabilities.has(left.card.id)),
  );
  const definitionCatalogue = [...registry.definitions.values()].toSorted(
    (left, right) =>
      Number(relevantCapabilities.has(right.capability)) -
      Number(relevantCapabilities.has(left.capability)),
  );
  const eventCursor = Math.max(
    state.last_handled_event_cursor,
    ...options.events.map((event) => event.cursor),
  );
  const context: ManagerContext = {
    purpose: 'decision',
    // Distinct applied decisions can share a material-event cursor (for
    // example, coordinate then wait). Rejected proposals and checkpoint
    // replay retain this ordinal until a decision commits.
    decision_id: `${task.current_run_id}:${task.generation}:${state.plan_revision}:${eventCursor}:${state.decisions.length}`,
    run_id: task.current_run_id,
    generation: task.generation,
    objective_revision: task.objective_revision,
    plan_revision: state.plan_revision,
    event_cursor: eventCursor,
    plan_objective_revision: state.plans.at(-1)?.objective_revision ?? 0,
    source_applicability: [
      ...task.original_request.context_refs,
      ...task.corrections.flatMap((c) => c.context_refs ?? []),
    ].map((ref) => ({
      id: ref.id,
      current: task.artifacts.some(
        (a) =>
          a.objective_revision === task.objective_revision &&
          a.artifact.id === ref.id &&
          a.current,
      ),
    })),
    request,
    corrections: structuredClone(task.corrections),
    ...(state.interpretation ? { interpretation: state.interpretation } : {}),
    capabilities: capabilityCatalogue.map((capability) => {
      const relevant = relevantCapabilities.has(capability.card.id);
      const denied = capability.card.required_tools.filter(
        (tool) => !task.permissions.tools.includes(tool),
      );
      const available = capability.availability?.(matchingRequest) ?? {
        available: true,
        reasons: [],
      };
      return {
        card: {
          id: capability.card.id,
          version: capability.card.version,
          purpose: capability.card.purpose,
          readiness: capability.card.readiness,
        },
        available: available.available && !denied.length,
        reasons: [
          ...available.reasons,
          ...denied.map((tool) => `Tool unavailable: ${tool}`),
        ],
        templates:
          state.plans.at(-1)?.objective_revision !== task.objective_revision &&
          capability.matches(matchingRequest)
            ? capability
                .assignments(templateRequest)
                .map((plan) => managerAssignmentPlanSchema.parse(plan))
            : [],
        ...(capability.exact_templates ? { exact_templates: true } : {}),
        // Its saved answer is rendered from reviewed artifacts, not Manager prose
        // (only flagged where a fixed plan uses it, to keep other contexts unchanged).
        ...(capability.exact_templates &&
        registry.finalRenderers.has(capability.card.id)
          ? { renders_answer: true }
          : {}),
        peer_requirements: relevant ? (capability.peer_requirements ?? []) : [],
        prerequisites: relevant ? (capability.prerequisites ?? []) : [],
        review_requirements: relevant
          ? (capability.review_requirements ?? [])
          : [],
      };
    }),
    definitions: definitionCatalogue.map((d) => ({
      id: d.id,
      capability: d.capability,
      agent: d.agent,
      tools: d.tools,
    })),
    lookups: [...registry.tools.values()]
      .filter(
        (tool) =>
          tool.manager_read_only &&
          task.permissions.tools.includes(tool.id) &&
          tool.mode === task.mode,
      )
      .map((tool) => ({ id: tool.id, description: tool.description })),
    assignments: task.assignments
      .filter(
        (a) =>
          a.run_id === task.current_run_id &&
          a.role !== 'Manager' &&
          !['cancelled', 'stale'].includes(a.status) &&
          a.usability !== 'stale',
      )
      .map((a) => ({
        id: a.id,
        definition_id: a.definition_id,
        capability: a.capability,
        role: a.role,
        revision: a.revision,
        objective_revision: a.objective_revision,
        status: a.status,
        brief: a.brief,
        dependencies: a.dependencies,
        support: a.support,
        usability: a.usability,
        gaps: a.gaps,
        ...(a.error ? { error: a.error } : {}),
      })),
    artifacts: options.artifacts.map((artifact) => {
      const content =
        typeof artifact.content === 'string'
          ? artifact.content
          : JSON.stringify(artifact.content);
      // Summary outputs repeat references already represented by the envelope.
      const summary =
        artifact.kind === 'assignment.summary' &&
        artifact.content &&
        typeof artifact.content === 'object' &&
        !Array.isArray(artifact.content) &&
        typeof artifact.content.summary === 'string'
          ? JSON.stringify({ summary: artifact.content.summary.slice(0, 800) })
          : undefined;
      return {
        ref: exact(artifact),
        kind: artifact.kind,
        ...(artifact.assignment_id
          ? { assignment_id: artifact.assignment_id }
          : {}),
        ...(artifact.assignment_revision
          ? { assignment_revision: artifact.assignment_revision }
          : {}),
        current: task.artifacts.some(
          (a) =>
            a.objective_revision === task.objective_revision &&
            a.artifact.id === artifact.id &&
            a.current,
        ),
        excerpt: summary ?? content.slice(0, 1600),
        truncated: summary !== undefined || content.length > 1600,
        // Final-synthesis numbering: user-supplied sources cite as [S…], every other source as [E…].
        ...(artifact.producer.kind === 'user' ||
        artifact.kind === 'source.import'
          ? { citation_letter: 'S' as const }
          : {}),
      };
    }),
    inspections: structuredClone(
      state.inspections.filter(
        (i) => i.objective_revision === task.objective_revision,
      ),
    ),
    reviews: structuredClone(options.reviews ?? []),
    peer_grants: state.decisions
      .filter(
        (d) =>
          d.decision.objective_revision === task.objective_revision &&
          d.decision.action.type === 'coordinate',
      )
      .flatMap((d) =>
        d.decision.action.type === 'coordinate'
          ? [
              {
                participants: d.decision.action.participants,
                purpose: d.decision.action.purpose,
              },
            ]
          : [],
      ),
    resources: {
      limits: task.limits,
      usage: task.usage,
      remaining_model_calls: Math.max(
        0,
        task.limits.max_model_calls - task.usage.model_calls,
      ),
      remaining_tool_calls: Math.max(
        0,
        task.limits.max_tool_calls - task.usage.tool_calls,
      ),
    },
    events: options.events.map((event) => ({
      cursor: event.cursor,
      type: event.type,
      message: event.message,
      ...(event.assignment_id ? { assignment_id: event.assignment_id } : {}),
      ...(event.data !== undefined ? { data: event.data } : {}),
    })),
    context_status: {
      truncated: false,
      omitted_artifacts: 0,
      omitted_events: 0,
      missing: [],
      bytes: 0,
    },
  };
  const limit =
    options.maxBytes ??
    Math.max(1024, task.limits.max_model_input_bytes - 6500);
  const status = context.context_status;
  // Registry growth must not displace exact task evidence. Cards remain
  // discoverable and runtime registration still authorizes every definition.
  if (bytes(context) > limit) {
    const omitted = context.definitions.filter(
      (definition) => !relevantCapabilities.has(definition.capability),
    );
    if (omitted.length) {
      context.definitions = context.definitions.filter((definition) =>
        relevantCapabilities.has(definition.capability),
      );
      status.missing.push(
        `Inactive definition details omitted (${omitted.length}); advertised capabilities and registered definitions remain available.`,
      );
      status.truncated = true;
    }
    // A capability whose templates are its exact plan keeps them over looser starting points.
    const offered = context.capabilities.filter(
      (capability) => capability.available && capability.templates?.length,
    );
    const starting =
      offered.find((capability) => capability.exact_templates) ?? offered[0];
    for (const capability of context.capabilities)
      if (capability !== starting) capability.templates = [];
    for (const capability of context.capabilities)
      if (!relevantCapabilities.has(capability.card.id)) {
        capability.reasons = [];
        const purpose = capability.card.purpose ?? '';
        if (purpose.length > 120)
          capability.card.purpose =
            purpose.slice(0, 120) + ' [Purpose truncated.]';
      }
    if (bytes(context) > limit && !currentPlan) {
      const templated = new Set(
        context.capabilities.flatMap((capability) =>
          (capability.templates ?? []).map(
            (template) => template.definition_id,
          ),
        ),
      );
      if (templated.size) {
        // A bounded exact starting plan does not need every other phase's
        // definition/rules just because they share its capability. Keep the
        // selected dispatch metadata and requirements; runtime registration
        // still validates every chosen definition, dependency and review.
        const inactive = context.definitions.filter(
          (definition) => !templated.has(definition.id),
        );
        context.definitions = context.definitions.filter((definition) =>
          templated.has(definition.id),
        );
        for (const capability of context.capabilities) {
          capability.prerequisites = (capability.prerequisites ?? []).filter(
            (requirement) => templated.has(requirement.definition_id),
          );
          capability.review_requirements = (
            capability.review_requirements ?? []
          ).filter(
            (requirement) =>
              templated.has(requirement.review_definition_id) ||
              requirement.producer_definition_ids?.some((id) =>
                templated.has(id),
              ),
          );
          capability.peer_requirements = (
            capability.peer_requirements ?? []
          ).filter((requirement) =>
            requirement.definitions.some((id) => templated.has(id)),
          );
        }
        if (inactive.length) {
          status.missing.push(
            `Inactive details and rules outside exact starting templates omitted (${inactive.length}); all capability/tool IDs, grants and exact evidence remain retained.`,
          );
          status.truncated = true;
        }
      }
      // Exact starting plans already name these registered definitions. The
      // runtime resolves and validates their agents and grants at dispatch.
      if (bytes(context) > limit) {
        context.definitions = context.definitions.filter(
          (definition) => !templated.has(definition.id),
        );
        status.missing.push(
          'Definition details repeated by exact starting templates omitted; runtime registration and plan validation remain authoritative.',
        );
        status.truncated = true;
      }
    }
    if (currentPlan) {
      const admitted = new Set(
        context.assignments.map((assignment) => assignment.definition_id),
      );
      context.definitions = context.definitions.filter(
        (definition) => !admitted.has(definition.id),
      );
      for (const capability of context.capabilities) {
        capability.prerequisites = [];
        capability.review_requirements = [];
      }
      status.missing.push(
        'Assignments and exact reviews represent admitted definition rules; every revised plan is revalidated.',
      );
      status.truncated = true;
    }
    for (const assignment of context.assignments)
      if (assignment.brief && assignment.brief.length > 200) {
        assignment.brief =
          assignment.brief.slice(0, 160) + ' [Brief truncated.]';
        status.truncated = true;
      }
  }
  if (bytes(context) > limit) {
    if (context.interpretation?.scope === context.request.objective) {
      context.interpretation = {
        ...context.interpretation,
        scope: '[Same scope as request.objective.]',
      };
      status.truncated = true;
    }
    const seenGaps = new Set<string>();
    const seenLimitations = seenGaps;
    let repeated = false;
    const unique = (values: string[], seen: Set<string>) =>
      values.filter((value) => {
        if (seen.has(value)) {
          repeated = true;
          return false;
        }
        seen.add(value);
        return true;
      });
    for (const assignment of context.assignments)
      assignment.gaps = unique(assignment.gaps ?? [], seenGaps);
    for (const review of context.reviews)
      review.limitations = unique(review.limitations, seenLimitations);
    const seenReviews = new Set<string>();
    for (const review of context.reviews) {
      if (!review.review_artifact) continue;
      const key = JSON.stringify([
        review.reviewer_assignment_id,
        review.reviewer_revision,
        review.review_artifact,
      ]);
      if (seenReviews.has(key)) {
        delete review.reviewer_assignment_id;
        delete review.reviewer_revision;
        delete review.review_artifact;
        repeated = true;
      } else seenReviews.add(key);
    }
    if (repeated) {
      status.missing.push(
        'Repeated gaps, limitations and reviewer references are shown once; exact review scopes remain persisted.',
      );
      status.truncated = true;
    }
  }
  const historical = task.assignments.filter(
    (a) =>
      a.run_id === task.current_run_id &&
      a.role !== 'Manager' &&
      (['cancelled', 'stale'].includes(a.status) || a.usability === 'stale'),
  );
  if (historical.length) {
    status.truncated = true;
    status.missing.push(
      `Historical assignment details omitted (${historical.length}); exact history remains persisted.`,
    );
  }
  status.missing.push(
    ...task.artifacts
      .filter(
        (entry) =>
          !options.artifacts.some(
            (artifact) => artifact.id === entry.artifact.id,
          ),
      )
      .map(
        (entry) =>
          `Artifact unavailable to this checkpoint: ${entry.artifact.id}. Access and exact version must be checked before reuse.`,
      ),
  );
  // Inspect results carry bounded evidence; references survive even when excerpts do not fit.
  for (const artifact of context.artifacts)
    if (artifact.truncated) status.truncated = true;
  if (bytes(context) > limit)
    for (const event of context.events) {
      if (bytes(context) <= limit) break;
      if (event.data === undefined) continue;
      if (
        event.type === 'specialist_escalated' &&
        event.data !== null &&
        typeof event.data === 'object' &&
        !Array.isArray(event.data)
      )
        event.data = Object.fromEntries(
          Object.entries(event.data).filter(([key]) =>
            ['kind', 'reason', 'recipient', 'purpose'].includes(key),
          ),
        );
      else delete event.data;
      status.truncated = true;
    }
  if (bytes(context) > limit)
    for (const artifact of [...context.artifacts].sort(
      (a, b) =>
        Number(a.kind === 'assignment.summary') -
        Number(b.kind === 'assignment.summary'),
    )) {
      if (bytes(context) <= limit) break;
      delete artifact.excerpt;
      artifact.truncated = true;
      status.truncated = true;
    }
  if (bytes(context) > limit)
    for (const inspection of context.inspections) {
      if (bytes(context) <= limit) break;
      inspection.excerpt =
        '[Excerpt omitted from this context; exact inspection is retained.]';
      status.truncated = true;
    }
  if (
    bytes(context) > limit &&
    context.assignments.length &&
    context.plan_objective_revision === context.objective_revision
  ) {
    for (const capability of context.capabilities) {
      capability.templates = [];
    }
    status.missing.push(
      'Optional starting templates omitted after plan admission; registered definitions remain available.',
    );
    status.truncated = true;
  }
  while (bytes(context) > limit && context.events.length > 1) {
    const discard = context.events.findIndex(
      (event) =>
        ![
          'specialist_escalated',
          'assignment_failed',
          'review_objection',
          'task_updated',
          'operation_unknown',
        ].includes(event.type),
    );
    if (discard < 0) break;
    context.events.splice(discard, 1);
    status.omitted_events++;
    status.truncated = true;
  }
  const suppliedIds = new Set([
    ...request.context_refs.map((ref) => ref.id),
    ...task.corrections.flatMap((correction) =>
      (correction.context_refs ?? []).map((ref) => ref.id),
    ),
  ]);
  const protectedArtifact = (artifact: ManagerContext['artifacts'][number]) =>
    suppliedIds.has(artifact.ref.id) ||
    (artifact.current &&
      (artifact.assignment_id === undefined ||
        artifact.kind.endsWith('.capture') ||
        (artifact.kind !== 'assignment.summary' &&
          artifact.assignment_id !== undefined &&
          task.assignments.some(
            (assignment) =>
              assignment.id === artifact.assignment_id &&
              assignment.role !== 'EvidenceCritic' &&
              assignment.status === 'completed',
          ))));
  while (bytes(context) > limit) {
    const historical = context.artifacts.findIndex(
      (artifact) => !artifact.current && !protectedArtifact(artifact),
    );
    const optional =
      historical >= 0
        ? historical
        : context.artifacts.findIndex(
            (artifact) => !protectedArtifact(artifact),
          );
    if (optional < 0) break;
    context.artifacts.splice(optional, 1);
    status.omitted_artifacts++;
    status.truncated = true;
  }
  if (bytes(context) > limit) {
    for (const capability of context.capabilities) {
      const purpose = capability.card.purpose ?? '';
      if (purpose.length > 80)
        capability.card.purpose =
          purpose.slice(0, 64) + ' [Purpose truncated.]';
    }
    status.truncated = true;
  }
  // Optional prose and inspection excerpts must not displace exact
  // instructions, evidence references, or review coverage as the registry grows.
  if (bytes(context) > limit) {
    status.missing.push(
      'Optional catalog prose, completed briefs or inspection excerpts omitted; full details retained.',
    );
    status.truncated = true;
    for (const lookup of context.lookups)
      if (bytes(context) > limit) lookup.description = '';
    for (const capability of context.capabilities)
      if (
        bytes(context) > limit &&
        !relevantCapabilities.has(capability.card.id) &&
        capability.card.purpose
      )
        capability.card.purpose = '';
    for (const assignment of context.assignments)
      if (bytes(context) > limit && assignment.status === 'completed')
        assignment.brief = '';
    for (const inspection of context.inspections)
      if (bytes(context) > limit) inspection.excerpt = '';
  }
  if (bytes(context) > limit) {
    // Compaction annotations are optional prose too. Keep every unavailable
    // evidence warning while summarizing repeated catalog/formatting notices.
    const unavailable = status.missing.filter((note) =>
      note.startsWith('Artifact unavailable'),
    );
    if (status.missing.length - unavailable.length > 1) {
      status.missing = [
        ...unavailable,
        'Optional catalog, brief and excerpt details were compacted; full history remains persisted. Exact requests, corrections, evidence and review references are retained.',
      ];
      status.truncated = true;
    }
  }
  // Available catalog descriptions are optional before planning too. Retain
  // the executable starting plan, identifiers and every unavailable reason.
  if (bytes(context) > limit) {
    for (const capability of context.capabilities) {
      if (!capability.card.purpose) delete capability.card.purpose;
      if (!capability.available) continue;
      if (bytes(context) > limit) capability.reasons = [];
      if (bytes(context) > limit) capability.card.purpose = '';
    }
  }
  if (bytes(context) > limit) {
    // These are context views, not persisted provenance. Exact artifact refs,
    // statuses, verdicts and nonempty limitations remain in this checkpoint.
    for (const assignment of context.assignments)
      if (assignment.status === 'completed') {
        delete assignment.capability;
        delete assignment.objective_revision;
        delete assignment.brief;
        delete assignment.dependencies;
        if (!assignment.gaps?.length) delete assignment.gaps;
      }
    for (const capability of context.capabilities) {
      if (!capability.card.purpose) delete capability.card.purpose;
      if (!capability.reasons?.length) delete capability.reasons;
      if (!capability.templates?.length) delete capability.templates;
      if (!capability.peer_requirements?.length)
        delete capability.peer_requirements;
      if (!capability.prerequisites?.length) delete capability.prerequisites;
      if (!capability.review_requirements?.length)
        delete capability.review_requirements;
    }
    for (const artifact of context.artifacts) {
      const producer = context.assignments.find(
        (assignment) => assignment.id === artifact.assignment_id,
      );
      if (
        artifact.current &&
        producer?.revision === artifact.assignment_revision
      )
        delete artifact.assignment_revision;
      delete artifact.truncated;
    }
    for (const review of context.reviews) {
      const catalog = context.artifacts.find(
        (artifact) =>
          artifact.current &&
          artifact.ref.id === review.artifact.id &&
          'version' in review.artifact &&
          artifact.ref.version === review.artifact.version &&
          artifact.ref.sha256 === review.artifact.sha256,
      );
      if (catalog) {
        review.artifact = { id: catalog.ref.id };
        if (
          catalog.assignment_id === review.producer_assignment_id &&
          context.assignments.some(
            (assignment) =>
              assignment.id === review.producer_assignment_id &&
              assignment.revision === review.producer_revision,
          )
        ) {
          delete review.producer_assignment_id;
          delete review.producer_revision;
        }
      }
    }
    status.truncated = true;
  }
  if (bytes(context) > limit && currentPlan) {
    context.definitions = [];
    if (context.interpretation) context.interpretation = {};
    for (const assignment of context.assignments)
      if (
        assignment.status === 'completed' &&
        assignment.support !== 'gap' &&
        !context.capabilities.some((capability) =>
          capability.peer_requirements?.some((requirement) =>
            requirement.definitions.includes(assignment.definition_id ?? ''),
          ),
        )
      ) {
        delete assignment.definition_id;
      }
    context.events = context.events.filter((event) => {
      if (
        [
          'specialist_escalated',
          'assignment_failed',
          'review_objection',
          'task_updated',
          'world_lifecycle_changed',
          'operation_unknown',
        ].includes(event.type)
      )
        return true;
      status.omitted_events++;
      return false;
    });
    status.missing = status.missing.filter((note) =>
      note.startsWith('Artifact unavailable'),
    );
    status.missing.push(
      'Optional metadata omitted; exact references retained.',
    );
  }
  if (bytes(context) > limit && currentPlan)
    for (const capability of context.capabilities) {
      if (bytes(context) <= limit) break;
      delete capability.card.version;
      delete capability.card.readiness;
    }
  if (bytes(context) > limit && currentPlan) {
    for (const artifact of context.artifacts) {
      const index = context.assignments.findIndex(
        (assignment) => assignment.id === artifact.assignment_id,
      );
      if (!artifact.current || index < 0) continue;
      artifact.assignment_index = index;
      delete artifact.assignment_id;
    }
    status.missing = status.missing.filter((note) =>
      note.startsWith('Artifact unavailable'),
    );
    status.missing.push(
      'Metadata compacted; assignment_index uses the zero-based assignments array.',
    );
  }
  if (bytes(context) > limit && currentPlan) {
    // Compaction prose is optional too. Keep unavailable-evidence warnings,
    // every advertised capability ID and exact review/evidence references.
    // The structured truncation flag and omission counts still disclose loss.
    status.missing = status.missing.filter((note) =>
      note.startsWith('Artifact unavailable'),
    );
  }
  if (bytes(context) > limit) {
    // Imported originals already retain full canonical references in the
    // unchanged request/corrections. Encode only redundant CURRENT import
    // catalog/applicability envelopes; never unavailable/historical sources,
    // captures, generated products, reviews or their nonempty gaps.
    const supplied = [
      ...context.request.context_refs,
      ...context.corrections.flatMap(
        (correction) => correction.context_refs ?? [],
      ),
    ];
    const retained = new Set<number>();
    const compacted = new Set<string>();
    const disclosure =
      'current_import_context_ref_indices tags CURRENT imported originals in request.context_refs followed by correction context_refs; full exact refs remain there.';
    status.missing.push(disclosure);
    for (const artifact of [...context.artifacts]) {
      if (bytes(context) <= limit) break;
      if (
        artifact.kind !== 'source.import' ||
        !artifact.current ||
        artifact.assignment_id !== undefined ||
        artifact.assignment_index !== undefined ||
        artifact.excerpt !== undefined
      )
        continue;
      const index = supplied.findIndex(
        (ref) =>
          ref.id === artifact.ref.id &&
          ref.version === artifact.ref.version &&
          ref.sha256 === artifact.ref.sha256,
      );
      if (
        index < 0 ||
        supplied.some(
          (ref) =>
            ref.id === artifact.ref.id &&
            (ref.version !== artifact.ref.version ||
              ref.sha256 !== artifact.ref.sha256),
        )
      )
        continue;
      const applicability = context.source_applicability.filter(
        (entry) => entry.id === artifact.ref.id,
      );
      if (
        !applicability.length ||
        applicability.some((entry) => !entry.current)
      )
        continue;
      retained.add(index);
      compacted.add(artifact.ref.id);
      context.artifacts = context.artifacts.filter(
        (entry) => entry !== artifact,
      );
      context.source_applicability = context.source_applicability.filter(
        (entry) => entry.id !== artifact.ref.id,
      );
      context.current_import_context_ref_indices = [...retained];
      status.omitted_artifacts++;
      status.truncated = true;
    }
    if (!compacted.size)
      status.missing = status.missing.filter((note) => note !== disclosure);
  }
  if (bytes(context) > limit)
    throw new TaskError(
      422,
      'manager_context_budget',
      'Original objective, exact corrections and current constraints exceed the admitted Manager input limit; context was not silently discarded.',
    );
  status.bytes = bytes(context);
  return context;
}
