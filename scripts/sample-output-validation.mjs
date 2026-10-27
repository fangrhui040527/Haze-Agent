import { createHash } from 'node:crypto';

const array = (value) => (Array.isArray(value) ? value : []);
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const sameRef = (left, right) =>
  Boolean(
    left &&
    right &&
    left.id === right.id &&
    left.version === right.version &&
    left.sha256 === right.sha256,
  );

// Matches the application's canonical JSON representation, without needing a
// compiled runtime or reading configuration, files, state or saved answers.
function canonical(value, seen = new Set(), depth = 0) {
  if (depth > 64) throw new Error('JSON is too deeply nested.');
  if (value === null) return 'null';
  if (['string', 'boolean'].includes(typeof value))
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (!object(value) && !Array.isArray(value))
    throw new Error('Value is not JSON.');
  if (seen.has(value)) throw new Error('JSON contains a cycle.');
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((item) => canonical(item, seen, depth + 1)).join(',')}]`
    : `{${Object.keys(value)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonical(value[key], seen, depth + 1)}`,
        )
        .join(',')}}`;
  seen.delete(value);
  return result;
}
const hash = (value) =>
  createHash('sha256').update(canonical(value)).digest('hex');
const providerReceipt = (receipt) =>
  object(receipt) &&
  receipt.synthetic !== true &&
  typeof receipt.response_model === 'string' &&
  receipt.response_model.length > 0 &&
  typeof receipt.response_id === 'string' &&
  receipt.response_id.length > 0 &&
  (receipt.http_status === undefined || receipt.http_status === 200) &&
  (receipt.response_status == null ||
    ['stop', 'completed', 'end_turn'].includes(receipt.response_status));
const cachedReceipt = (receipt) =>
  object(receipt) &&
  receipt.synthetic !== true &&
  receipt.response_status === 'cache_hit' &&
  receipt.response_id === null &&
  receipt.input_tokens === null &&
  receipt.output_tokens === null &&
  receipt.http_status === undefined &&
  receipt.cache?.version === 1 &&
  /^[a-f0-9]{64}$/.test(receipt.cache.key_sha256 ?? '') &&
  Number.isFinite(Date.parse(receipt.cache.recorded_at)) &&
  object(receipt.cache.original_route) &&
  providerReceipt(receipt.cache.original_receipt);
function references(value) {
  if (Array.isArray(value)) return value.flatMap(references);
  if (!object(value)) return [];
  const own =
    typeof value.id === 'string' &&
    Number.isInteger(value.version) &&
    typeof value.sha256 === 'string'
      ? [value]
      : [];
  return [...own, ...Object.values(value).flatMap(references)];
}

/**
 * Verify retained execution evidence, never prescribe model actions or answers.
 * A partial account, gap assessment or conditional/blocked plan can be valid:
 * the selected products and their independent reviews must actually exist.
 */
export function validateSampleOutput(output) {
  const errors = [];
  const checks = {
    configured_model_receipt: false,
    selected_current_product: false,
    independent_review: false,
    synthetic_evidence: false,
    artifact_integrity: false,
  };
  const require = (condition, message) => {
    if (!condition) errors.push(message);
    return Boolean(condition);
  };
  try {
    if (!object(output)) throw new Error('Sample output must be an object.');
    require(output.schema_version === 'haze.sample.output.v1' &&
      output.sample_mode === true &&
      output.synthetic_evidence ===
        true, 'The output must declare sample mode and synthetic evidence.');
    const task = output.task;
    if (!object(task)) throw new Error('The output must retain its task.');
    const retainedResult = task.result;
    const result = object(retainedResult) ? retainedResult : {};
    require(task.mode === 'live' &&
      task.status === 'completed' &&
      object(
        retainedResult,
      ), 'The configured-model task must finish with a retained result.');
    require(result.provenance?.mode === 'live' &&
      task.usage?.model_calls >
        0, 'The result must record genuine configured-model execution.');
    if (object(retainedResult))
      require(canonical(output.result) ===
        canonical(
          result,
        ), 'The exported result does not match the completed task result.');
    require(canonical(output.request) ===
      canonical(
        task.original_request,
      ), 'The exported request does not match the admitted task request.');
    const artifacts = array(output.artifacts);
    const find = (reference) =>
      artifacts.find((item) => sameRef(item, reference));
    const applicable = (artifact) =>
      Boolean(
        artifact &&
        array(task.artifacts).some(
          (entry) =>
            entry.current === true &&
            entry.objective_revision === task.objective_revision &&
            sameRef(entry.artifact, artifact),
        ),
      );
    const current = (artifact) =>
      Boolean(
        applicable(artifact) &&
        artifact.task_id === task.id &&
        artifact.run_id === task.current_run_id &&
        artifact.objective_revision === task.objective_revision &&
        artifact.producer?.kind === 'assignment' &&
        array(task.assignments).some(
          (assignment) =>
            assignment.id === artifact.assignment_id &&
            assignment.id === artifact.producer.id &&
            assignment.run_id === task.current_run_id &&
            assignment.objective_revision === task.objective_revision &&
            assignment.revision === artifact.assignment_revision &&
            assignment.status === 'completed' &&
            !['stale', 'rejected'].includes(assignment.usability) &&
            array(assignment.outputs).some((ref) => sameRef(ref, artifact)),
        ),
      );
    const selected = (kind) => {
      const matches = artifacts.filter(
        (artifact) =>
          artifact.kind === kind &&
          current(artifact) &&
          array(result.work_products).some((ref) => sameRef(ref, artifact)),
      );
      require(matches.length ===
        1, `The final result must select one current ${kind} product.`);
      return matches.length === 1 ? matches[0] : undefined;
    };
    const independentlyReviewed = (product, allowedKinds) => {
      if (!product) return false;
      return array(result.review?.checks).some((check) => {
        const review = find(check.review_artifact);
        return Boolean(
          sameRef(check.artifact, product) &&
          check.verdict === 'supported' &&
          check.producer_assignment_id === product.assignment_id &&
          check.producer_revision === product.assignment_revision &&
          check.reviewer_assignment_id !== check.producer_assignment_id &&
          current(review) &&
          allowedKinds.includes(review.kind) &&
          review.assignment_id === check.reviewer_assignment_id &&
          review.assignment_revision === check.reviewer_revision &&
          review.content?.verdict === 'supported' &&
          (!review.content.reviewer ||
            (review.content.reviewer.assignment_id === review.assignment_id &&
              review.content.reviewer.revision ===
                review.assignment_revision)) &&
          array(review.content.reviewed_artifacts).some((ref) =>
            sameRef(ref, product),
          ),
        );
      });
    };
    const integrityErrors = errors.length;
    for (const artifact of artifacts) {
      require(/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '') &&
        hash(artifact.content) ===
          artifact.sha256, `Artifact ${artifact.id ?? 'unknown'} has a mismatched content hash.`);
      for (const ref of references(artifact.content).concat(
        array(artifact.dependencies),
      ))
        require(find(
          ref,
        ), `Artifact reference ${ref.id} is not retained exactly.`);
      require(artifact.evidence_origin !==
        'external_source', 'A sample output contains external source evidence.');
    }
    for (const ref of references(result))
      require(find(ref), `Result reference ${ref.id} is not retained exactly.`);
    checks.artifact_integrity =
      artifacts.length > 0 && errors.length === integrityErrors;

    checks.configured_model_receipt = array(
      output.execution?.model_attempts,
    ).some((attempt) => {
      const assignment = array(task.assignments).find(
        (item) =>
          item.id === attempt.assignment_id &&
          item.revision === attempt.assignment_revision &&
          item.run_id === task.current_run_id &&
          item.objective_revision === task.objective_revision,
      );
      const receipt = attempt.receipt;
      return Boolean(
        assignment &&
        attempt.task_id === task.id &&
        attempt.run_id === task.current_run_id &&
        attempt.objective_revision === task.objective_revision &&
        attempt.kind === 'model' &&
        attempt.status === 'completed' &&
        attempt.accepted === true &&
        ['nightshift', 'nvidia', 'openai-compatible'].includes(
          attempt.details?.requested_route?.provider,
        ) &&
        (providerReceipt(receipt) || cachedReceipt(receipt)),
      );
    });
    require(checks.configured_model_receipt, 'No successful model receipt or input-matched cache receipt with genuine model provenance is retained for this run.');

    switch (output.scenario_id) {
      case 'evidence-investigation': {
        const analysis = selected('pm25.analysis');
        const captures = array(analysis?.dependencies)
          .map(find)
          .filter(
            (artifact) =>
              artifact?.kind === 'pm25.capture' && current(artifact),
          );
        const capture = captures.length === 1 ? captures[0] : undefined;
        require(capture, 'The analysis must depend on its exact current PM2.5 capture.');
        checks.selected_current_product = Boolean(analysis && capture);
        checks.independent_review = independentlyReviewed(analysis, ['review']);
        checks.synthetic_evidence = Boolean(
          capture?.content?.evidence_origin === 'synthetic_fixture' &&
          capture.content.selection?.backend === 'sample-file',
        );
        break;
      }
      case 'damage-account': {
        const account = selected('damage.account');
        const components = array(account?.content?.component_refs);
        const componentKinds = new Set(components.map(({ kind }) => kind));
        const exactComponents = components.map(
          ({ kind, artifact: reference }) => {
            const artifact = find(reference);
            return artifact?.kind === kind && current(artifact)
              ? artifact
              : undefined;
          },
        );
        const validComponents = Boolean(
          account &&
          components.length >= 9 &&
          componentKinds.size === components.length &&
          exactComponents.every(Boolean),
        );
        require(validComponents, 'The account must retain its exact current accounting components.');
        checks.selected_current_product = Boolean(account && validComponents);
        checks.independent_review = Boolean(
          validComponents &&
          independentlyReviewed(account, ['damage.review']) &&
          [
            'damage.physical',
            'damage.incidence',
            'damage.welfare',
            'damage.scenarios',
          ].every((kind) =>
            independentlyReviewed(
              exactComponents.find((artifact) => artifact?.kind === kind),
              ['damage.review'],
            ),
          ),
        );
        checks.synthetic_evidence =
          account?.content?.evidence_origin === 'synthetic';
        break;
      }
      case 'damage-reduction': {
        const assessment = selected('reduction.assessment');
        const plan = selected('reduction.conditional-plan');
        const selection = find(assessment?.content?.selection_ref);
        const arithmeticReview = find(plan?.content?.arithmetic_review_ref);
        const linked = Boolean(
          assessment &&
          plan &&
          current(selection) &&
          selection.kind === 'reduction.input-selection' &&
          sameRef(plan.content.selection_ref, selection) &&
          sameRef(plan.content.assessment_ref, assessment) &&
          current(arithmeticReview) &&
          arithmeticReview.kind === 'reduction.review' &&
          arithmeticReview.content?.verdict === 'supported' &&
          array(arithmeticReview.content.reviewed_artifacts).some((ref) =>
            sameRef(ref, assessment),
          ),
        );
        require(linked, 'The planning products must retain one exact current selection, assessment and arithmetic review chain.');
        checks.selected_current_product = linked;
        checks.independent_review = Boolean(
          independentlyReviewed(assessment, ['reduction.review']) &&
          independentlyReviewed(plan, ['reduction.plan-review']),
        );
        checks.synthetic_evidence = Boolean(
          assessment?.content?.origin === 'synthetic' &&
          plan?.content?.origin === 'synthetic' &&
          assessment.content.scientific_qualification === 'unqualified' &&
          plan.content.scientific_qualification === 'unqualified' &&
          plan.content.delivery_status === 'not_delivered' &&
          plan.content.achieved_reduction === false,
        );
        break;
      }
      default:
        errors.push(
          'The output does not identify one of the three sample scenarios.',
        );
    }
    require(checks.selected_current_product, 'The required scenario workflow did not produce selected current products.');
    require(checks.independent_review, 'The selected scenario products lack exact independent supported reviews.');
    require(checks.synthetic_evidence, 'The selected products do not retain explicit synthetic evidence and claim limits.');
  } catch (error) {
    errors.push(
      `Invalid sample output: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)], checks };
}
