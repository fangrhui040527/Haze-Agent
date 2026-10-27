import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  createSpecialistActionContract,
  SPECIALIST_ACTION_CONTRACT_VERSION,
} from '../dist/orchestration/action-contract.js';

/** Use production permissions for both generation and validation, never criteria. */
export function prepareRouteEvaluation(agent, context, maxOutputTokens) {
  const baseSchema =
    agent.id === 'Manager' ? agent.schemas.decision : agent.schemas.specialist;
  const contract =
    agent.id === 'Manager'
      ? undefined
      : createSpecialistActionContract(context, baseSchema);
  return {
    schema: contract?.schema ?? baseSchema,
    action_contract_version: contract
      ? SPECIALIST_ACTION_CONTRACT_VERSION
      : undefined,
    input: {
      role: agent.id,
      instruction: agent.instructions,
      context: contract
        ? {
            ...context,
            action_contract: {
              version: SPECIALIST_ACTION_CONTRACT_VERSION,
              allowed_actions: contract.allowedActions,
            },
          }
        : context,
      output_schema: contract?.outputSchema ?? z.toJSONSchema(baseSchema),
      max_output_tokens: maxOutputTokens,
      json_mode: true,
    },
  };
}

function at(value, path) {
  return path.split('.').reduce((entry, key) => entry?.[key], value);
}

/** Score the original output. Never repair JSON, actions, references or tools. */
export function assessRouteOutput(text, schema, criteria, parseContractJson) {
  let value;
  try {
    value = parseContractJson(text);
  } catch {
    return {
      strict_action: false,
      outcome: false,
      reference_integrity: false,
      failures: ['invalid-json'],
    };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return {
      strict_action: false,
      outcome: false,
      reference_integrity: false,
      failures: ['strict-schema-rejection'],
    };
  }
  const failures = [];
  for (const [path, expected] of Object.entries(criteria.equals ?? {})) {
    if (!isDeepStrictEqual(at(value, path), expected))
      failures.push(`exact:${path}`);
  }
  for (const [path, choices] of Object.entries(criteria.one_of ?? {})) {
    if (
      !choices.some((expected) => isDeepStrictEqual(at(value, path), expected))
    )
      failures.push(`one-of:${path}`);
  }
  for (const path of criteria.nonempty ?? []) {
    const item = at(value, path);
    if (!(typeof item === 'string' || Array.isArray(item)) || item.length === 0)
      failures.push(`nonempty:${path}`);
  }
  const referenceFailures = [];
  for (const [path, expected] of Object.entries(
    criteria.exact_references ?? {},
  )) {
    if (!isDeepStrictEqual(at(value, path), expected))
      referenceFailures.push(`references:${path}`);
  }
  return {
    strict_action: true,
    outcome: failures.length === 0,
    reference_integrity: referenceFailures.length === 0,
    failures: [...failures, ...referenceFailures],
  };
}

export function safeEvaluationRoute(route) {
  return {
    route_id: route.route_id,
    profile: route.profile,
    provider: route.provider,
    requested_model: route.requested_model,
    capability_contract: route.capability_contract,
    policy: route.policy,
    model_identity: 'requested-name; exact underlying model is not attested',
  };
}
