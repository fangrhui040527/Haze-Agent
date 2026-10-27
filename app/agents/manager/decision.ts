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
};

function schemaFeedback(error: unknown): InvalidOutput | null {
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

function decisionFeedback(invalid: InvalidOutput) {
  const feedback = {
    correction: 1,
    code: invalid.code,
    message:
      invalid.code === 'missing_source_citation'
        ? 'Return the full decision. Cite selected sources in action.answer with matching [S1]/[E1] markers.'
        : invalid.code === 'incomplete_artifact_reference'
          ? 'Copy each full artifact ref (id, version, sha256) from supplied canonical refs. Never infer a hash.'
          : [
                'invalid_decision_schema',
                'invalid_source_citation',
                'exact_templates_required',
                'fixed_plan',
              ].includes(invalid.code)
            ? invalid.message
            : 'Do not repeat queued work. Coordinate the exact missing peer channel or wait.',
    ...(invalid.peer_prerequisite
      ? { peer_prerequisite: invalid.peer_prerequisite }
      : {}),
  };
  const bytes = () =>
    new TextEncoder().encode(JSON.stringify({ decision_feedback: feedback }))
      .byteLength;
  if (bytes() > MANAGER_DECISION_FEEDBACK_MAX_BYTES)
    delete feedback.peer_prerequisite;
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

type Ref = { id: string; version: number; sha256: string };
const listedArtifact = (context: ManagerContext, ref: Ref) =>
  context.artifacts.find(
    (artifact) =>
      artifact.ref.id === ref.id &&
      artifact.ref.version === ref.version &&
      artifact.ref.sha256 === ref.sha256,
  );
const citationLetter = (context: ManagerContext, ref: Ref) => {
  const artifact = listedArtifact(context, ref);
  return (
    artifact?.citation_marker ??
    (artifact?.kind === 'source.import' ? ('S' as const) : undefined)
  );
};
const producedByCritic = (context: ManagerContext, ref: Ref) => {
  const artifact = listedArtifact(context, ref);
  const role =
    artifact?.assignment_index !== undefined
      ? context.assignments[artifact.assignment_index]?.role
      : context.assignments.find((a) => a.id === artifact?.assignment_id)?.role;
  return role === 'EvidenceCritic';
};

/** Products an EvidenceCritic reference vouches for: its supported review checks. */
function reviewedProducts(
  context: ManagerContext,
  ref: Ref,
): Ref[] | undefined {
  const artifact = listedArtifact(context, ref);
  const reviewer =
    artifact?.assignment_index !== undefined
      ? context.assignments[artifact.assignment_index]?.id
      : artifact?.assignment_id;
  const products: Ref[] = [];
  for (const check of context.reviews) {
    if (
      check.verdict !== 'supported' ||
      (check.review_artifact?.id !== ref.id &&
        check.reviewer_assignment_id !== reviewer)
    )
      continue;
    const full =
      'sha256' in check.artifact
        ? check.artifact
        : context.artifacts.find((a) => a.ref.id === check.artifact.id)?.ref;
    if (!full) return undefined;
    if (!products.some((p) => p.id === full.id)) products.push(full);
  }
  return products;
}

/**
 * Reviews support the products they cover and the runtime rejects them as final
 * references. Live Managers kept citing them even after a correction, so each one
 * is replaced by the exact products its supported checks cover and the citation
 * markers renumbered; a reference that vouches for nothing is dropped.
 */
function withoutReviewReferences(
  decision: ManagerDecision,
  context: ManagerContext,
): ManagerDecision {
  const action = decision.action;
  if (action.type !== 'finalize') return decision;
  if (
    ![...action.sources, ...action.work_products].some((ref) =>
      producedByCritic(context, ref),
    )
  )
    return decision;
  const sources: Ref[] = [];
  const replaced: Ref[][] = [];
  for (const ref of action.sources) {
    const products = producedByCritic(context, ref)
      ? reviewedProducts(context, ref)
      : [ref];
    if (!products) return decision;
    replaced.push(products);
    for (const product of products)
      if (!sources.some((s) => s.id === product.id)) sources.push(product);
  }
  const marker = (refs: Ref[], target: Ref) => {
    const counts = { S: 0, E: 0 };
    for (const ref of refs) {
      const letter = citationLetter(context, ref);
      if (!letter) return undefined;
      counts[letter]++;
      if (ref.id === target.id) return `[${letter}${counts[letter]}]`;
    }
    return undefined;
  };
  const renumber = new Map<string, string>();
  for (const [index, ref] of action.sources.entries()) {
    const old = marker(action.sources, ref);
    const next = replaced[index]!.map((product) => marker(sources, product));
    if (!old || next.includes(undefined)) return decision;
    renumber.set(old.slice(1, -1), [...new Set(next)].join(''));
  }
  return {
    ...decision,
    action: {
      ...action,
      sources,
      work_products: action.work_products.filter(
        (ref) => !producedByCritic(context, ref),
      ),
      answer: action.answer
        .replace(/\[([A-Za-z]+\d+)\]/g, (found, id: string) =>
          renumber.has(id) ? renumber.get(id)! : found,
        )
        // Two removed references to one product collapse to one marker.
        .replace(/(\[[A-Za-z]+\d+\])\1+/g, '$1')
        // A dropped marker leaves no space before the punctuation that followed it.
        .replace(/ +([.,;:])/g, '$1'),
    },
  };
}

function knownInvalidOutput(
  decision: ManagerDecision,
  context: ManagerContext,
): InvalidOutput | null {
  const action = decision.action;
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
  if (
    (action.type === 'apply_plan' || action.type === 'lookup') &&
    context.plan_objective_revision === context.objective_revision
  ) {
    // An exact-template plan is complete as admitted; only a correction re-plans it.
    // Its specialists already gather the evidence, so extra lookups add nothing citable.
    const fixed = context.capabilities.find(
      (capability) =>
        capability.exact_templates &&
        context.assignments.some(
          (assignment) =>
            assignment.role !== 'Manager' &&
            (assignment.capability ??
              context.definitions.find(
                (definition) => definition.id === assignment.definition_id,
              )?.capability) === capability.card.id,
        ),
    );
    if (fixed)
      return {
        code: 'fixed_plan',
        message: `The ${fixed.card.id} plan for this objective is fixed. Do not add or replace assignments or run lookups: wait for running work, inspect results, or finalize with the reported gaps and uncertainty.`,
      };
  }
  if (action.type === 'finalize') {
    // Letters follow the runtime's numbering; a source missing from context is left to the runtime.
    const letters = action.sources.map((ref) => citationLetter(context, ref));
    const counts = { S: 0, E: 0 };
    const allowed = new Set(
      letters.flatMap((letter) =>
        letter ? [`${letter}${++counts[letter]}`] : [],
      ),
    );
    const unknown = letters.includes(undefined)
      ? []
      : [...action.answer.matchAll(/\[([A-Za-z]+\d+)\]/g)]
          .map((match) => match[1]!)
          .filter((marker) => !allowed.has(marker));
    if (unknown.length)
      return {
        code: 'invalid_source_citation',
        message: `action.answer cites ${[...new Set(unknown)].slice(0, 6).join(', ')} but the selected sources only allow ${[...allowed].join(', ') || 'none'}. Return the complete decision again citing only those markers, numbered by each source's citation_marker in selected order.`,
      };
  }
  if (
    action.type === 'apply_plan' &&
    context.plan_objective_revision !== context.objective_revision
  ) {
    const exact = context.capabilities.find(
      (capability) =>
        capability.exact_templates && capability.templates?.length,
    );
    const shape = (plan: {
      key: string;
      definition_id: string;
      depends_on: string[];
      input?: unknown;
    }) =>
      JSON.stringify([
        plan.key,
        plan.definition_id,
        [...plan.depends_on].sort(),
        plan.input ?? null,
      ]);
    const expected = (exact?.templates ?? []).map(shape).sort();
    const proposed = action.assignments.map(shape).sort();
    if (
      exact &&
      (expected.length !== proposed.length ||
        expected.some((item, index) => item !== proposed[index]))
    )
      return {
        code: 'exact_templates_required',
        message: `Capability ${exact.card.id} requires its starting templates as the plan. Return the complete decision again with apply_plan.assignments copying every template's key, definition_id, depends_on and input exactly (${exact.templates!.map((t) => t.key).join(', ')}); only brief may be reworded. Add no other assignments.`,
      };
  }
  if (
    action.type !== 'apply_plan' ||
    context.plan_objective_revision !== context.objective_revision
  )
    return null;
  const active = context.assignments.filter((assignment) =>
    ['queued', 'running'].includes(assignment.status),
  );
  if (
    !action.assignments.some((proposal) =>
      active.some((assignment) => assignment.id === proposal.key),
    )
  )
    return null;
  let peerPrerequisite: unknown;
  for (const capability of context.capabilities) {
    for (const requirement of capability.peer_requirements ?? []) {
      const participants = requirement.definitions.map((definition) =>
        active.find((assignment) => assignment.definition_id === definition),
      );
      if (!participants[0] || !participants[1]) continue;
      const exactParticipants = participants.map((assignment) => ({
        assignment_id: assignment!.id,
        revision: assignment!.revision,
      }));
      if (
        context.peer_grants.some(
          (grant) =>
            grant.purpose === requirement.purpose &&
            exactParticipants.every((participant) =>
              grant.participants.some(
                (granted) =>
                  granted.assignment_id === participant.assignment_id &&
                  granted.revision === participant.revision,
              ),
            ),
        )
      )
        continue;
      peerPrerequisite = {
        type: 'coordinate',
        participants: exactParticipants,
        purpose: requirement.purpose,
      };
      break;
    }
    if (peerPrerequisite) break;
  }
  return {
    code: 'duplicate_active_assignment',
    message:
      'The proposed plan lists an already admitted queued/running assignment ID as a new assignment key. Keep existing work instead of admitting it again. For an exact missing required peer channel, propose coordinate with its supplied participants and purpose; otherwise wait for material progress or inspect the admitted work. A hint is not an authorization; return a complete decision using the unchanged checkpoint.',
    ...(peerPrerequisite ? { peer_prerequisite: peerPrerequisite } : {}),
  };
}

function candidate(
  text: string,
  context: ManagerContext,
  allowSchemaCorrection = true,
):
  | { ok: true; decision: ManagerDecision }
  | { ok: false; invalid: InvalidOutput } {
  const value = parseContractJson(text);
  try {
    const decision = withoutReviewReferences(
      parseDecision(value, context),
      context,
    );
    const invalid = knownInvalidOutput(decision, context);
    return invalid ? { ok: false, invalid } : { ok: true, decision };
  } catch (error) {
    const invalid =
      incompleteReference(error, value) ??
      (allowSchemaCorrection ? schemaFeedback(error) : null);
    if (!invalid) throw error;
    return { ok: false, invalid };
  }
}

/** Models propose decisions. Only the runtime can authorize and execute them. */
export async function decide(
  services: ManagerServices,
): Promise<ManagerDecision> {
  const context = services.context;
  const first = await services.model(context);
  const proposal = candidate(first.text, context);
  if (proposal.ok) return proposal.decision;
  const invalid = proposal.invalid;
  // Only received invalid output receives one changed prompt. Provider failures,
  // unknown operations and stale checkpoints propagate without a retry/action.
  const corrected = await services.model({
    ...context,
    decision_feedback: decisionFeedback(invalid),
  });
  const decision = candidate(corrected.text, context, false);
  if (!decision.ok)
    throw new TaskError(422, decision.invalid.code, decision.invalid.message);
  return decision.decision;
}
