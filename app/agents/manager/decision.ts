import { ZodError } from 'zod';
import { parseContractJson } from '../../contracts/json.js';
import type {
  ManagerContext,
  ManagerDecision,
} from '../../contracts/manager.js';
import { MANAGER_DECISION_FEEDBACK_MAX_BYTES } from '../../contracts/manager.js';
import { TaskError } from '../../contracts/tasks.js';
import type { ManagerServices } from '../../orchestration/ports.js';
import { createManagerReferenceContract } from './reference-contract.js';
import {
  managerCoordinationIssue,
  managerPeerPolicy,
} from '../../orchestration/manager-peer-policy.js';
import { managerDecisionSchema } from '../../contracts/manager.js';
import { managerRetainableAssignments } from '../../orchestration/manager-plan-policy.js';

function parseDecision(
  value: unknown,
  context: ManagerContext,
): ManagerDecision {
  const decision = createManagerReferenceContract(context).schema.parse(value);
  if (decision.recovery_of)
    throw new TaskError(
      422,
      'recovery_metadata_denied',
      'Recovery metadata is reserved for runtime re-admission of an already persisted validated decision.',
    );
  if (
    decision.run_id !== context.run_id ||
    decision.generation !== context.generation ||
    decision.objective_revision !== context.objective_revision ||
    decision.plan_revision !== context.plan_revision ||
    decision.event_cursor !== context.event_cursor
  )
    throw new TaskError(
      409,
      'stale_manager_decision',
      'The Manager decision does not match its admitted checkpoint.',
    );
  return decision;
}

type InvalidOutput = {
  code: string;
  message: string;
  peer_prerequisite?: unknown;
  plan_requirements?: unknown;
};

function schemaFeedback(
  error: unknown,
  context: ManagerContext,
  value?: unknown,
): InvalidOutput | null {
  if (
    error instanceof ZodError &&
    error.issues.some(
      (issue) =>
        issue.code === 'custom' &&
        issue.path[0] === 'action' &&
        issue.path[1] === 'answer' &&
        issue.message ===
          'A citation handle must name an explicitly selected source with a known citation class.',
    )
  ) {
    const proposal =
      typeof value === 'object' && value !== null && 'action' in value
        ? value.action
        : undefined;
    const action =
      typeof proposal === 'object' && proposal !== null ? proposal : {};
    const selected =
      'sources' in action && Array.isArray(action.sources)
        ? action.sources.filter(
            (item): item is string => typeof item === 'string',
          )
        : [];
    const cited =
      'answer' in action && typeof action.answer === 'string'
        ? [...action.answer.matchAll(/\[(ref:\d+)\]/gu)].map(
            (match) => match[1]!,
          )
        : [];
    const unselected = [
      ...new Set(cited.filter((handle) => !selected.includes(handle))),
    ];
    const critics = new Set(
      context.assignments
        .filter((item) => item.role === 'EvidenceCritic')
        .map((item) => item.id),
    );
    const reviewIds = new Set(
      context.artifacts
        .filter((item) => item.assignment_id && critics.has(item.assignment_id))
        .map((item) => item.ref.id),
    );
    const reviewHandles = createManagerReferenceContract(context)
      .referenceCatalog.filter((item) => reviewIds.has(item.ref.id))
      .map((item) => item.handle);
    return {
      code: 'invalid_source_citation',
      message: `Return the full decision. Citations not selected as sources: ${unselected.join(', ') || 'none'}. Current selected sources: ${selected.join(', ') || 'none'}. Review-only handles: ${reviewHandles.join(', ') || 'none'}. Every [ref:N] citation must name an explicitly selected factual source. Remove citations to review-status sentences; the exact supported review is retained automatically. For numeric claims, select and cite the actual factual input or deliverable using its exact handle. Preserve checkpoint values and never invent a source.`,
    };
  }
  if (
    error instanceof ZodError &&
    error.issues.some(
      (issue) =>
        issue.path[0] === 'action' && issue.path[1] === 'retain_assignment_ids',
    )
  ) {
    const ids = managerRetainableAssignments(context) ?? [];
    return {
      code: 'invalid_retain_assignment_ids',
      message: ids.length
        ? `Return the full decision. retain_assignment_ids may contain only already admitted specialist IDs: ${ids.join(', ')}. Proposed assignment keys belong only in assignments[].key and depends_on; they are not retained IDs. You may choose the advertised registered template handle instead of copying its plan.`
        : 'Return the full decision. No specialist assignments have been admitted: retain_assignment_ids must be []. The keys of NEW proposed assignments are not existing IDs; keep those keys only in assignments[].key and depends_on. Choose the advertised registered template handle or return your full corrected plan. Keep checkpoint values unchanged.',
    };
  }
  if (
    !(error instanceof ZodError) ||
    error.issues.some((issue) => issue.code === 'custom')
  )
    return null;
  // Report schema locations, not supplied values or a rewritten decision. The
  // next complete proposal still has to pass every schema and authority check.
  const issues = error.issues
    .slice(0, 4)
    .map(
      (issue) =>
        `${(issue.path.join('.') || '(root)').slice(0, 64)}: ${issue.code}`,
    )
    .join('; ');
  return {
    code: 'invalid_decision_schema',
    message: `Return the full decision using the advertised schema. Repair ${issues}. Keep checkpoint values and use only admitted IDs and exact references; never infer hashes.`,
  };
}

function decisionFeedback(invalid: InvalidOutput, correction = 1) {
  const feedback = {
    correction,
    code: invalid.code,
    message:
      invalid.code === 'missing_source_citation'
        ? invalid.message
        : invalid.code === 'incomplete_artifact_reference'
          ? 'Copy each full artifact ref (id, version, sha256) from supplied canonical refs. Never infer a hash.'
          : [
                'invalid_decision_schema',
                'invalid_source_citation',
                'missing_peer_coordination',
                'invalid_peer_coordination',
                'duplicate_peer_coordination',
                'duplicate_active_assignment',
                'independent_review_required',
                'missing_prerequisite',
                'delegated_user_analysis',
                'invalid_retain_assignment_ids',
                'unsupported_completion_claim',
                'unsupported_final_review_selection',
                'unsupported_review_claim',
              ].includes(invalid.code)
            ? invalid.message
            : 'Do not repeat queued work. Coordinate the exact missing peer channel or wait.',
    ...(invalid.peer_prerequisite
      ? { peer_prerequisite: invalid.peer_prerequisite }
      : {}),
    ...(invalid.plan_requirements
      ? { plan_requirements: invalid.plan_requirements }
      : {}),
  };
  const bytes = () =>
    new TextEncoder().encode(JSON.stringify({ decision_feedback: feedback }))
      .byteLength;
  if (bytes() > MANAGER_DECISION_FEEDBACK_MAX_BYTES)
    delete feedback.peer_prerequisite;
  if (bytes() > MANAGER_DECISION_FEEDBACK_MAX_BYTES)
    delete feedback.plan_requirements;
  if (bytes() > MANAGER_DECISION_FEEDBACK_MAX_BYTES)
    feedback.message =
      'Return the complete corrected decision matching its schema. Keep unchanged checkpoint values and exact admitted references.';
  return feedback;
}

function incompleteReference(
  error: unknown,
  value: unknown,
): InvalidOutput | null {
  if (!(error instanceof ZodError) || !error.issues.length) return null;
  const missing = error.issues.every((issue) => {
    if (issue.code !== 'invalid_type') return false;
    const path = issue.path;
    const field = path.at(-1);
    if (!['id', 'version', 'sha256'].includes(String(field))) return false;
    const referencePosition =
      (path.length === 3 &&
        path[0] === 'references' &&
        typeof path[1] === 'number') ||
      (path.length === 4 &&
        path[0] === 'action' &&
        ['work_products', 'sources', 'artifacts'].includes(String(path[1])) &&
        typeof path[2] === 'number') ||
      (path.length === 3 && path[0] === 'action' && path[1] === 'artifact');
    if (!referencePosition) return false;
    let parent = value;
    for (const key of path.slice(0, -1)) {
      if (typeof parent !== 'object' || parent === null) return false;
      parent = (parent as Record<PropertyKey, unknown>)[key];
    }
    return (
      typeof parent === 'object' &&
      parent !== null &&
      !Array.isArray(parent) &&
      !Object.hasOwn(parent, String(field))
    );
  });
  return missing
    ? {
        code: 'incomplete_artifact_reference',
        message:
          'An artifact reference omits id, version or sha256. Copy the complete exact reference from admitted context; no hash or source may be inferred.',
      }
    : null;
}

function knownInvalidOutput(
  decision: ManagerDecision,
  context: ManagerContext,
): InvalidOutput | null {
  const action = decision.action;
  if (action.type === 'question') {
    const prompt = action.prompt.trim();
    const delegatedWork =
      /^(?:please\s+)?(?:explain|summari[sz]e|calculate|compute|analy[sz]e|investigate|assess|evaluate|compare|interpret|report|describe|build|compile|prepare)\b.{0,160}\b(?:evidence|gaps?|results?|data(?:sets?)?|findings?|accounts?|reductions?|coverage|losses|costs?|benefits?|risks?|limits?|plans?)\b/iu.test(
        prompt,
      );
    const missingInputIntent =
      /\b(?:what|which|where|when|whether|who|how|why|provide|supply|specify|clarify|confirm|choose|select|prefer|want|should)\b|\b(?:you|your)\b/iu.test(
        prompt,
      );
    if (delegatedWork && !missingInputIntent)
      return {
        code: 'delegated_user_analysis',
        message:
          'Return the full decision. This prompt asks the user to perform agent analysis rather than supply a specific missing input. Use registered capabilities or tools for the requested work and report evidence gaps or scientific limits as findings. Ask a question only when a specific missing user input, scope, choice or authority prevents progress. Choose the next action yourself and preserve checkpoint values.',
      };
  }
  if (action.type === 'coordinate')
    return managerCoordinationIssue(context, action);
  if (action.type === 'apply_plan') {
    const retainable = managerRetainableAssignments(context) ?? [];
    if (action.retain_assignment_ids.some((id) => !retainable.includes(id)))
      return {
        code: 'invalid_retain_assignment_ids',
        message: `Return the full decision. retain_assignment_ids contains only existing eligible specialist IDs, never proposed assignment keys. ${retainable.length ? `Eligible IDs: ${retainable.join(', ')}.` : 'No specialists exist; this array must be [].'} Keep checkpoint values and select a registered template handle or correct the full plan yourself.`,
      };
    const retained = context.assignments.filter(
      (assignment) =>
        action.retain_assignment_ids.includes(assignment.id) &&
        !['failed', 'cancelled', 'stale', 'timed_out'].includes(
          assignment.status,
        ),
    );
    const planRequirements: unknown[] = [];
    let missingReview = false;
    for (const capability of context.capabilities) {
      for (const requirement of capability.review_requirements ?? []) {
        const producers = action.assignments.filter((item) => {
          const definition = context.definitions.find(
            (entry) => entry.id === item.definition_id,
          );
          return (
            definition?.capability === capability.card.id &&
            definition.agent !== 'EvidenceCritic' &&
            (!requirement.producer_definition_ids ||
              requirement.producer_definition_ids.includes(item.definition_id))
          );
        });
        if (
          producers.length &&
          ![...action.assignments, ...retained].some(
            (item) => item.definition_id === requirement.review_definition_id,
          )
        ) {
          missingReview = true;
          if (
            !planRequirements.some(
              (item) =>
                typeof item === 'object' &&
                item !== null &&
                'definition_id' in item &&
                item.definition_id === requirement.review_definition_id,
            )
          )
            planRequirements.push({
              definition_id: requirement.review_definition_id,
              depends_on_definitions:
                capability.prerequisites?.find(
                  (entry) =>
                    entry.definition_id === requirement.review_definition_id,
                )?.depends_on_definitions ?? [],
              reason:
                'Registered independent reviewer required in the same proposed or retained plan.',
            });
        }
      }
      for (const requirement of capability.prerequisites ?? [])
        for (const assignment of action.assignments.filter(
          (item) => item.definition_id === requirement.definition_id,
        )) {
          const dependencies = assignment.depends_on.map(
            (key) =>
              action.assignments.find((item) => item.key === key)
                ?.definition_id ??
              retained.find((item) => item.id === key)?.definition_id,
          );
          if (
            requirement.depends_on_definitions.some(
              (id) => !dependencies.includes(id),
            )
          )
            planRequirements.push({
              key: assignment.key,
              definition_id: assignment.definition_id,
              depends_on_definitions: requirement.depends_on_definitions,
              reason:
                'Registered direct prerequisites must be present in depends_on.',
            });
        }
    }
    if (planRequirements.length)
      return {
        code: missingReview
          ? 'independent_review_required'
          : 'missing_prerequisite',
        message:
          'Return the full decision with a complete admissible plan. Include the registered independent reviewers and direct prerequisites listed in plan_requirements in this same proposed/retained plan; promising to add a reviewer later is insufficient. Choose valid unique keys and dependency keys yourself, preserve checkpoint values, and do not change the objective. These requirements do not authorize execution.',
        plan_requirements: planRequirements,
      };
  }
  if (action.type === 'finalize') {
    const critics = new Set(
      context.assignments
        .filter((item) => item.role === 'EvidenceCritic')
        .map((item) => item.id),
    );
    const supportOnly = new Set([
      ...context.artifacts
        .filter((item) => item.assignment_id && critics.has(item.assignment_id))
        .map((item) => item.ref.id),
      ...context.reviews.flatMap((review) =>
        review.review_artifact ? [review.review_artifact.id] : [],
      ),
    ]);
    if (
      [...action.work_products, ...action.sources].some((ref) =>
        supportOnly.has(ref.id),
      )
    )
      return {
        code: 'unsupported_final_review_selection',
        message:
          'Return the full decision. Independent review artifacts support the underlying factual work products; they cannot be selected as final work_products or sources. Select the requested current factual products and their actual input sources. The runtime retains their exact supported review evidence automatically. Remove review-only selections and cite only the sources you explicitly select; do not invent or alter references or checkpoint values.',
      };
    const workRequest =
      /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+|(?:i|we)\s+(?:need|want)\s+(?:you\s+to\s+)?)?(?:build|calculate|compute|compile|assemble|investigate|analy[sz]e|assess|evaluate|compare|prepare|review|verify|check)\b/iu.test(
        context.request.objective.trim(),
      );
    const assertions = action.answer
      .split(/[.!?](?:\s|$)/u)
      .filter(
        (sentence) =>
          !/\b(?:if|would|could|should|may|might|cannot|unavailable|unestimated|unverified|not|never)\b/iu.test(
            sentence,
          ),
      );
    const completedWork = assertions.some(
      (sentence) =>
        /\b(?:i|we)\s+(?:have\s+)?(?:built|calculated|computed|compiled|assembled|estimated|analy[sz]ed|prepared|generated|assessed|evaluated)\b/iu.test(
          sentence,
        ) ||
        (workRequest &&
          /\b(?:(?:has|have|had)\s+been|is|are|was|were)\s+(?:now\s+)?(?:built|calculated|computed|compiled|assembled|estimated|analy[sz]ed|prepared|generated|assessed|evaluated|completed|finished)\b/iu.test(
            sentence,
          )),
    );
    const completedReview =
      workRequest &&
      assertions.some((sentence) =>
        /\b(?:review|check)(?:s)?\s+(?:(?:has|have|had)\s+been|is|are|was|were)\s+(?:now\s+)?(?:obtained|completed|passed|supported|verified|performed)\b/iu.test(
          sentence,
        ),
      );
    const currentProducts = action.work_products.filter((ref) =>
      context.artifacts.some(
        (artifact) =>
          artifact.current &&
          artifact.kind !== 'source.import' &&
          artifact.ref.id === ref.id &&
          artifact.ref.version === ref.version &&
          artifact.ref.sha256 === ref.sha256,
      ),
    );
    if (completedWork && !currentProducts.length)
      return {
        code: 'unsupported_completion_claim',
        message:
          'Return the full decision. The proposed answer claims calculation, compilation or analysis was completed, but selects no retained current work product proving that work. A request, plan or model statement is not execution evidence. Perform the requested work using registered capabilities/tools and select its actual current products, or truthfully identify unfinished work without claiming completion. Choose the next action yourself; preserve checkpoint values.',
      };
    if (
      completedReview &&
      !context.reviews.some(
        (review) =>
          review.verdict === 'supported' &&
          currentProducts.some((ref) => review.artifact.id === ref.id),
      )
    )
      return {
        code: 'unsupported_review_claim',
        message:
          'Return the full decision. The proposed answer claims an independent review succeeded, but no supported retained review covers a selected current product. Do not invent review completion. Obtain the required independent review through registered work, or report it as unfinished. Choose the next action yourself and preserve checkpoint values.',
      };
  }
  if (
    action.type === 'finalize' &&
    action.sources.length &&
    !/\[([A-Za-z]+\d+)\]/.test(action.answer)
  )
    return {
      code: 'missing_source_citation',
      message:
        'The proposed action.sources is nonempty but action.answer has no citation marker. Return the complete decision again with an answer supported by exactly those selected sources and matching markers in action.answer: [S1] for the first imported source, [S2] for the second, [E1] for the first external capture. Do not invent sources or change checkpoint values.',
    };
  if (action.type === 'finalize') {
    const cited = [...action.answer.matchAll(/\[([A-Za-z]+\d+)\]/g)].map(
      (match) => match[1],
    );
    const declaredRefs = [
      ...context.request.context_refs,
      ...context.corrections.flatMap(
        (correction) => correction.context_refs ?? [],
      ),
    ];
    const compactImports = (
      context.current_import_context_ref_indices ?? []
    ).flatMap((index) => (declaredRefs[index] ? [declaredRefs[index]] : []));
    const sameRef = (
      left: (typeof action.sources)[number],
      right: (typeof action.sources)[number],
    ) =>
      left.id === right.id &&
      left.version === right.version &&
      left.sha256 === right.sha256;
    let sourceIndex = 0,
      captureIndex = 0;
    const markers = action.sources.map((source) => {
      const artifact = context.artifacts.find((entry) =>
        sameRef(entry.ref, source),
      );
      if (
        artifact?.kind === 'source.import' ||
        compactImports.some((ref) => sameRef(ref, source))
      )
        return `S${++sourceIndex}`;
      // A compacted/unknown source is not enough to infer its marker class.
      return artifact ? `E${++captureIndex}` : undefined;
    });
    if (
      !markers.includes(undefined) &&
      cited.some((marker) => !markers.includes(marker))
    )
      return {
        code: 'invalid_source_citation',
        message: `Return the full decision. Citation markers are assigned only to action.sources, not work_products or retained reviews. Use only ${markers.length ? markers.map((marker) => `[${marker}]`).join(', ') : 'no citation markers'} for the selected sources; preserve exact references and checkpoint values.`,
      };
  }
  if (
    !['apply_plan', 'wait'].includes(action.type) ||
    context.plan_objective_revision !== context.objective_revision
  )
    return null;
  const active = context.assignments.filter((assignment) =>
    ['queued', 'running'].includes(assignment.status),
  );
  if (
    action.type === 'apply_plan' &&
    !action.assignments.some((proposal) =>
      active.some(
        (assignment) =>
          assignment.id === proposal.key ||
          (action.retain_assignment_ids.includes(assignment.id) &&
            assignment.definition_id === proposal.definition_id &&
            assignment.brief !== undefined &&
            assignment.brief === proposal.brief &&
            (proposal.input === undefined ||
              proposal.input === null ||
              (typeof proposal.input === 'object' &&
                !Array.isArray(proposal.input) &&
                Object.keys(proposal.input).length === 0))),
      ),
    )
  )
    return null;
  const peerPrerequisite = managerPeerPolicy(context)?.missing[0];
  if (action.type === 'wait')
    return peerPrerequisite
      ? {
          code: 'missing_peer_coordination',
          message:
            'Return the full decision. Queued assignments cannot progress while their required peer channel is missing. Propose coordinate using the exact supplied missing participants and purpose before waiting. Keep checkpoint values unchanged; this hint grants no authority.',
          peer_prerequisite: peerPrerequisite,
        }
      : null;
  return {
    code: 'duplicate_active_assignment',
    message:
      'The proposed plan repeats admitted queued/running work: it uses an existing assignment ID as a new key, or retains that assignment while adding the same definition and brief without a distinct input. Keep existing work instead of admitting it again; genuinely distinct scoped work needs its own explicit input. For an exact missing required peer channel, propose coordinate with its supplied participants and purpose; otherwise wait for material progress or inspect the admitted work. A hint is not an authorization; return a complete decision using the unchanged checkpoint.',
    ...(peerPrerequisite ? { peer_prerequisite: peerPrerequisite } : {}),
  };
}

function candidate(
  text: string,
  context: ManagerContext,
):
  | { ok: true; decision: ManagerDecision }
  | { ok: false; invalid: InvalidOutput; schemaError?: unknown } {
  const value = parseContractJson(text);
  try {
    const decision = parseDecision(value, context);
    const invalid = knownInvalidOutput(decision, context);
    return invalid ? { ok: false, invalid } : { ok: true, decision };
  } catch (error) {
    const parsed = managerDecisionSchema.safeParse(value);
    if (
      parsed.success &&
      parsed.data.action.type === 'coordinate' &&
      parsed.data.run_id === context.run_id &&
      parsed.data.generation === context.generation &&
      parsed.data.objective_revision === context.objective_revision &&
      parsed.data.plan_revision === context.plan_revision &&
      parsed.data.event_cursor === context.event_cursor &&
      !parsed.data.recovery_of
    ) {
      const invalid = managerCoordinationIssue(context, parsed.data.action);
      if (invalid) return { ok: false, invalid };
    }
    const missingReference = incompleteReference(error, value);
    if (missingReference) return { ok: false, invalid: missingReference };
    const invalid = schemaFeedback(error, context, value);
    if (!invalid) throw error;
    return { ok: false, invalid, schemaError: error };
  }
}

/** Explain scheduler state without selecting, rewriting or dispatching an action. */
function currentExecutionGuidance(context: ManagerContext) {
  if (
    context.plan_objective_revision !== context.objective_revision ||
    !context.assignments.length ||
    context.events.some((event) => event.type === 'operation_unknown')
  )
    return undefined;
  const peers = managerPeerPolicy(context);
  if (peers?.missing.length)
    return {
      state: 'admitted_work_requires_peer_grant',
      instruction:
        'The workflow is already admitted. Its queued work cannot start until the exact required peer channel below is coordinated. apply_plan creates new assignments; it does not start existing work. Coordinate the missing registered pair and purpose, then let the scheduler advance the admitted dependencies. Do not recreate the workflow to start it.',
      missing_peer_grants: peers.missing,
    };
  if (
    context.assignments.every((assignment) => assignment.status === 'completed')
  )
    return {
      state: 'admitted_work_completed',
      instruction:
        'The admitted assignments have finished. The original objective describes the requested deliverable, not an instruction to start its plan again. Inspect the actual current retained products and exact independent review coverage. If they satisfy the request, finalize by selecting those supported product and source references and reporting remaining evidence gaps. Completion status alone is not proof. Add work only for a concrete remaining requirement, changed scope or correction; do not recreate the completed workflow.',
    };
  const active = context.assignments.filter((assignment) =>
    ['queued', 'running'].includes(assignment.status),
  );
  if (
    active.length &&
    peers &&
    peers.missing.length === 0 &&
    context.assignments.every(
      (assignment) =>
        ['queued', 'running', 'completed'].includes(assignment.status) &&
        !assignment.error,
    )
  )
    return {
      state: 'admitted_work_in_progress',
      instruction:
        'Healthy queued/running assignments are already admitted and their required peer grants are satisfied. The runtime scheduler advances their dependencies automatically. apply_plan creates or replaces assignments; it is not a start, continue or execute command for existing work. Normally wait for material progress instead of recreating this workflow. Inspect current artifacts if needed. Replan only for a concrete new requirement, failure, changed scope or correction; the original objective is not a reason to duplicate admitted work.',
    };
  return undefined;
}

/** Models propose decisions. Only the runtime can authorize and execute them. */
export async function decide(
  services: ManagerServices,
): Promise<ManagerDecision> {
  const context = services.context;
  const guidance = currentExecutionGuidance(context);
  const modelContext = guidance
    ? { ...context, execution_guidance: guidance }
    : context;
  const rejectedIssues = new Set<string>();
  let input: unknown = modelContext;
  for (let corrections = 0; ; corrections++) {
    // Only received invalid output can change the next prompt. Provider failures,
    // unknown outcomes and stale checkpoints propagate without another call.
    const completion = await services.model(input);
    const proposal = candidate(completion.text, context);
    if (proposal.ok) return proposal.decision;
    const { invalid } = proposal;
    const issue = `${invalid.code}:${invalid.message}`;
    if (corrections === 2 || rejectedIssues.has(issue)) {
      if ('schemaError' in proposal) throw proposal.schemaError;
      throw new TaskError(422, invalid.code, invalid.message);
    }
    rejectedIssues.add(issue);
    // A first repair can expose a different validation problem. Permit one
    // further full proposal, never a repeated issue or a fourth model call.
    input = {
      ...modelContext,
      decision_feedback: decisionFeedback(invalid, corrections + 1),
    };
  }
}
