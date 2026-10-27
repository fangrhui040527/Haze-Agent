import { MANAGER_CHAT_MAX_TIMEOUT_MS } from '../contracts/manager-chat.js';

const settings = {
  maxModelCalls: {
    key: 'HAZE_MANAGER_MAX_MODEL_CALLS',
    defaultValue: 6,
    minimum: 1,
    maximum: 64,
  },
  maxRetrievals: {
    key: 'HAZE_MANAGER_MAX_RETRIEVALS',
    defaultValue: 4,
    minimum: 0,
    maximum: 32,
  },
  timeoutMs: {
    key: 'HAZE_MANAGER_TIMEOUT_MS',
    defaultValue: 120000,
    minimum: 1000,
    maximum: MANAGER_CHAT_MAX_TIMEOUT_MS,
  },
  maxOutputTokens: {
    key: 'HAZE_MANAGER_MAX_OUTPUT_TOKENS',
    defaultValue: 2400,
    minimum: 1,
    maximum: 32768,
  },
  maxCorrections: {
    key: 'HAZE_MANAGER_MAX_CORRECTIONS',
    defaultValue: 1,
    minimum: 0,
    maximum: 8,
  },
} as const;

export type ManagerConversationLimits = Record<keyof typeof settings, number>;

/** Server configuration only; a chat request cannot raise its execution budget. */
export function readManagerConversationLimits(
  env: NodeJS.ProcessEnv,
): ManagerConversationLimits {
  const limits = {} as ManagerConversationLimits;
  for (const name of Object.keys(settings) as (keyof typeof settings)[]) {
    const { key, defaultValue, minimum, maximum } = settings[name];
    const value = env[key];
    if (value === undefined) {
      limits[name] = defaultValue;
      continue;
    }
    const parsed = Number(value);
    if (
      !/^\d+$/u.test(value) ||
      !Number.isSafeInteger(parsed) ||
      parsed < minimum ||
      parsed > maximum
    )
      throw new Error(
        `${key} must be an integer from ${minimum} to ${maximum}.`,
      );
    limits[name] = parsed;
  }
  return limits;
}
