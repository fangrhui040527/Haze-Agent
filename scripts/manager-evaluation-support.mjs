export const managerEvaluationUsage =
  'Usage: evaluate-manager.mjs --scripted|--live [--baseline ROOT | --build-root ROOT] [--case ID]\n' +
  '       evaluate-manager.mjs --list';

export const evaluationDefinitionIds = [
  'eval.produce',
  'eval.fail',
  'eval.reviewed',
  'eval.review',
  'eval.peer-producer',
  'eval.peer-reviewer',
  'eval.slow',
];
export const evaluationSpecialistRoles = [
  'HazeOps',
  'WorkerShield',
  'EvidenceCritic',
];
export const evaluationLocalToolIds = [
  'world.lookup',
  'world.context',
  'world.lineage',
];

/** Validate the complete invocation before importing runtime code or making state. */
export function parseManagerEvaluationArgs(args) {
  const mode = args[0];
  if (!['--scripted', '--live', '--list'].includes(mode))
    throw new Error(managerEvaluationUsage);
  const options = {};
  for (let index = 1; index < args.length; index++) {
    const option = args[index];
    if (!['--case', '--baseline', '--build-root'].includes(option))
      throw new Error(`Unknown option: ${option}\n${managerEvaluationUsage}`);
    if (options[option] !== undefined)
      throw new Error(`Duplicate option: ${option}`);
    const value = args[++index];
    if (!value || value.startsWith('--'))
      throw new Error(`${option} requires a value.`);
    options[option] = value;
  }
  if (mode === '--list' && Object.keys(options).length)
    throw new Error(`--list does not accept evaluation options.`);
  if (options['--baseline'] && options['--build-root'])
    throw new Error('--baseline and --build-root are mutually exclusive.');
  return {
    mode: mode.slice(2),
    baselineRoot: options['--baseline'],
    buildRoot: options['--build-root'],
    caseId: options['--case'],
  };
}

export function selectManagerCases(allCases, { caseId }) {
  const cases = allCases.filter((c) => !caseId || c.id === caseId);
  if (!cases.length)
    throw new Error(
      caseId
        ? `Unknown Manager evaluation case: ${caseId}`
        : 'No Manager evaluation cases are configured.',
    );
  return cases;
}

/** Runtime extensions may register domain tools; keep this harness local-only. */
export function restrictManagerEvaluationTools(registry) {
  const excluded = [];
  for (const id of registry.tools.keys()) {
    if (!evaluationLocalToolIds.includes(id)) {
      registry.tools.delete(id);
      excluded.push(id);
    }
  }
  for (const definition of registry.definitions.values())
    definition.tools = definition.tools.filter((id) =>
      evaluationLocalToolIds.includes(id),
    );
  return excluded;
}

/** Verify isolation from observed work as well as from the registered catalog. */
export function checkManagerEvaluationIsolation(
  task,
  attempts,
  registeredTools,
) {
  const violations = [];
  const assignments = new Map(task.assignments.map((a) => [a.id, a]));
  for (const assignment of task.assignments) {
    if (
      assignment.role !== 'Manager' &&
      (!evaluationDefinitionIds.includes(assignment.definition_id) ||
        !evaluationSpecialistRoles.includes(assignment.role))
    )
      violations.push(`Non-evaluation specialist: ${assignment.definition_id}`);
  }
  for (const id of registeredTools)
    if (!evaluationLocalToolIds.includes(id))
      violations.push(`Non-local tool registered: ${id}`);
  let managerModelCalls = 0;
  let specialistModelCalls = 0;
  let specialistToolCalls = 0;
  const observedTools = new Set();
  for (const attempt of attempts) {
    const assignment = assignments.get(attempt.assignment_id);
    if (!assignment) {
      violations.push(`Attempt has an unknown assignment: ${attempt.id}`);
      continue;
    }
    if (attempt.kind === 'model') {
      if (assignment.role === 'Manager') managerModelCalls++;
      else {
        specialistModelCalls++;
        violations.push(`Specialist model attempt: ${attempt.id}`);
      }
    }
    if (attempt.kind === 'tool') {
      const tool = attempt.details?.tool;
      observedTools.add(tool ?? '<unknown>');
      if (assignment.role !== 'Manager') {
        specialistToolCalls++;
        violations.push(`Specialist tool attempt: ${attempt.id}`);
      }
      if (!evaluationLocalToolIds.includes(tool))
        violations.push(`Non-local tool attempt: ${tool ?? '<unknown>'}`);
    }
  }
  return {
    passed: violations.length === 0,
    violations,
    manager_model_calls: managerModelCalls,
    specialist_model_calls: specialistModelCalls,
    specialist_tool_calls: specialistToolCalls,
    registered_tool_ids: [...registeredTools],
    observed_tool_ids: [...observedTools],
  };
}
