import { createStrictHandler } from './handler.mjs';

const HAZE_APP = 'haze-agent';
const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const REQUIRED_HOOKS = [
  'findModel',
  'getKey',
  'resolveAppPolicy',
  'resolvePrivacyFloor',
  'floorAdmits',
  'disabledModelIds',
  'modelAvailability',
  'resolveAppLaneAllow',
  'modelOnAllowedLanes',
];
const QUALITY_MODES = [
  'crossCheckThreshold',
  'qualityRace',
  'generativeVerifier',
  'moaSynthesis',
  'debateRound',
  'reasoningScaffold',
];

function policyConflict() {
  return Object.assign(
    new Error('Nightshift strict inference conflicts with runtime policy.'),
    { status: 409, code: 'strict_policy_conflict' },
  );
}

function runtimeUnavailable() {
  return Object.assign(
    new Error('Nightshift strict inference runtime is unavailable.'),
    { status: 503, code: 'strict_runtime_unavailable' },
  );
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The strict endpoint has one fixed application identity. Caller headers cannot
 * escape a binding or privacy rule by inventing a different application name.
 * Unsupported policy fails before the single provider fetch.
 */
export function makeHazeStrictFacade({ RT, fetcher = fetch }) {
  return createStrictHandler({
    fetcher,
    resolveModel(model, _headers, body) {
      if (
        !RT ||
        REQUIRED_HOOKS.some((name) => typeof RT[name] !== 'function') ||
        typeof RT.nvidia?.endpointType !== 'function' ||
        typeof RT.redact?.withholdMatches !== 'function' ||
        typeof RT.redact?.redactRequest !== 'function' ||
        !isRecord(RT.data?.setpoints)
      )
        return null;

      try {
        const row = RT.findModel(model);
        if (
          !row ||
          row.id !== model ||
          row.aliasOf ||
          row.provider !== 'nvidia' ||
          !/^nvidia\/nemotron-/u.test(model) ||
          (row.nativeId !== undefined && row.nativeId !== model) ||
          row.thinkingControl !== 'chat_template_kwargs' ||
          RT.nvidia.endpointType(row) !== 'chat' ||
          RT.nvidia.BASE_URL !== NVIDIA_BASE_URL
        )
          return null;

        const policy = RT.resolveAppPolicy(HAZE_APP);
        const setpoints = RT.data.setpoints;
        const globalFloor = RT.resolvePrivacyFloor();
        if (
          !isRecord(policy) ||
          policy.app !== HAZE_APP ||
          globalFloor !== 'cloud-ok' ||
          setpoints.privacyMin !== 'cloud-ok' ||
          policy.privacy !== 'cloud-ok' ||
          RT.floorAdmits(row, globalFloor) !== true ||
          RT.floorAdmits(row, policy.privacy) !== true ||
          policy.mode != null ||
          policy.premiumBudget != null ||
          !['auto', 'off'].includes(policy.crossCheck) ||
          QUALITY_MODES.some(
            (key) =>
              setpoints[key] !== undefined &&
              !['auto', 'off'].includes(setpoints[key]),
          )
        )
          throw policyConflict();

        // Mode-specific premiumBudgetAuto/Deep values govern orchestration.
        // This endpoint promises no monetary cap; explicit app caps refuse.
        const disabled = RT.disabledModelIds();
        const availability = RT.modelAvailability(row);
        if (
          typeof disabled?.has !== 'function' ||
          disabled.has(model) ||
          availability?.active !== true
        )
          return null;

        const allowedLanes = RT.resolveAppLaneAllow(HAZE_APP);
        if (RT.modelOnAllowedLanes(row, allowedLanes) !== true)
          throw policyConflict();

        if (!Array.isArray(setpoints.withholdPatterns))
          throw runtimeUnavailable();
        if (body !== undefined) {
          const before = JSON.stringify(body);
          const withheld = RT.redact.withholdMatches(
            before,
            setpoints.withholdPatterns,
          );
          if (!Array.isArray(withheld)) throw runtimeUnavailable();
          if (withheld.length) throw policyConflict();

          // Reject requests needing redaction: silently sending originals
          // bypasses egress policy, while restoring a raw provider body would
          // change the completion being receipted by this strict transport.
          const redacted = RT.redact.redactRequest(body);
          if (
            typeof redacted?.ctx?.map?.size !== 'number' ||
            !isRecord(redacted.req)
          )
            throw runtimeUnavailable();
          if (
            redacted.ctx.map.size !== 0 ||
            JSON.stringify(redacted.req) !== before ||
            JSON.stringify(body) !== before
          )
            throw policyConflict();
        }

        const rawKey = RT.getKey('nvidia');
        if (typeof rawKey !== 'string') return null;
        const apiKey = rawKey.trim();
        if (
          !apiKey ||
          apiKey.length > 16_384 ||
          /[\s\u0000-\u001f\u007f]/u.test(apiKey)
        )
          return null;

        return {
          id: model,
          provider: 'nvidia',
          baseUrl: NVIDIA_BASE_URL,
          apiKey,
          tokenField: 'max_tokens',
          supportsReasoning: true,
        };
      } catch (error) {
        if (error?.code === 'strict_policy_conflict') throw policyConflict();
        // Runtime hooks can throw messages containing endpoint or credential
        // material. Only fixed diagnostics are allowed across the facade.
        throw runtimeUnavailable();
      }
    },
  });
}
