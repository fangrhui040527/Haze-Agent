import { createHash } from 'node:crypto';
import { agentRoleSchema } from '../contracts/capabilities.js';
import type { AgentRole } from '../contracts/capabilities.js';
import { parseContractJson } from '../contracts/json.js';
import type { ModelRouteService } from '../orchestration/model-service.js';
import {
  agentRoutesConfigurationSchema,
  effectiveModelRouteSchema,
  modelRoutesConfigurationSchema,
  modelRouteSnapshotSchema,
} from '../contracts/model-routes.js';
import type {
  EffectiveModelRoute,
  ModelReadiness,
  ModelRouteSnapshot,
} from '../contracts/model-routes.js';
import { resolveAgentModel } from './agent-model.js';
import type { AgentModel } from './agent-model.js';
import { withCachedAgentModel } from './model-cache.js';
import { modelCacheConfiguration } from './model-cache-config.js';
import { managerModelCacheNormalizer } from '../orchestration/model-cache-bindings.js';
import {
  NIGHTSHIFT_BASE_URL,
  NIGHTSHIFT_CONTRACT,
  NIGHTSHIFT_CONTRACT_FAILURE,
  inspectNightshiftContract,
  nightshiftCredentialReference,
  resolveRouteCredential,
} from './nightshift/runtime.js';
import { resolveStrictNightshiftModel } from './nightshift/strict-model.js';
import {
  sampleModelAllowsNoCredential,
  sampleModelEnvironment,
  sampleModelUsesBuiltinFallback,
  isBuiltinSampleModelRoute,
  prepareSampleModel,
} from './sample-model.js';
export {
  createInjectedRouteSnapshot,
  createOfflineRouteSnapshot,
} from '../contracts/model-routes.js';

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const NVIDIA_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
function hash(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonical(child)]),
      );
    return input;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
function contract(
  provider: EffectiveModelRoute['provider'],
  localSampleDefault = false,
): EffectiveModelRoute['capability_contract'] {
  if (provider === 'nightshift') return NIGHTSHIFT_CONTRACT;
  const id = localSampleDefault
    ? 'ollama-sample-chat-v1'
    : `${provider}-chat-v1`;
  return Object.freeze({
    version: 1,
    id,
    hash: hash({
      id,
      token_limit_field:
        provider === 'nvidia' || localSampleDefault
          ? 'max_tokens'
          : 'max_completion_tokens',
      max_output_tokens: 16_384,
      strict_actions: 'local-validation',
      reasoning:
        provider === 'nvidia'
          ? 'nemotron-thinking-disabled'
          : 'provider-default',
      usage: 'response-only-null-when-absent',
      replay: 'never-on-unknown',
    }),
  });
}
function normalizeBase(
  value: string | undefined,
  provider: EffectiveModelRoute['provider'],
): string | null {
  if (provider === 'offline') return null;
  let url: URL;
  try {
    url = new URL(
      value ||
        (provider === 'nvidia'
          ? NVIDIA_BASE_URL
          : provider === 'nightshift'
            ? NIGHTSHIFT_BASE_URL
            : ''),
    );
  } catch {
    throw new Error('Model route requires an absolute HTTP(S) API base URL.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Model route URL must use HTTP(S) without credentials, query, or fragment.',
    );
  }
  if (
    provider === 'nightshift' &&
    !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
  ) {
    throw new Error('Nightshift routes require a loopback endpoint.');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url.toString().replace(/\/+$/u, '');
}
function freezeRoute(
  values: Omit<
    EffectiveModelRoute,
    'version' | 'route_id' | 'capability_contract'
  >,
  localSampleDefault = false,
): EffectiveModelRoute {
  const data = {
    version: 1 as const,
    ...values,
    capability_contract: contract(values.provider, localSampleDefault),
  };
  return Object.freeze({ ...data, route_id: `route-${hash(data)}` });
}
function parsedJson(value: string | undefined): unknown {
  if (!value) return undefined;
  if (Buffer.byteLength(value, 'utf8') > 65_536)
    throw new Error('Model route configuration exceeded its size limit.');
  try {
    return parseContractJson(value, 65_536);
  } catch {
    throw new Error('Model route configuration must contain valid JSON.');
  }
}
function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32);
}

/** Server-owned route authority. Configuration is captured once; only secret values refresh. */
export class ModelRouteRegistry implements ModelRouteService {
  readonly #snapshot: ModelRouteSnapshot;
  readonly #models = new Map<string, AgentModel>();
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    let profiles: ReturnType<
      typeof modelRoutesConfigurationSchema.parse
    >['profiles'];
    let mappings: ReturnType<
      typeof agentRoutesConfigurationSchema.parse
    >['routes'];
    try {
      profiles = modelRoutesConfigurationSchema.parse(
        parsedJson(env.HAZE_MODEL_ROUTES_JSON) ?? { version: 1, profiles: {} },
      ).profiles;
      mappings = agentRoutesConfigurationSchema.parse(
        parsedJson(env.HAZE_AGENT_ROUTES_JSON) ?? { version: 1, routes: {} },
      ).routes;
    } catch {
      throw new Error(
        'Invalid model route configuration: check the versioned profiles and registered role mappings.',
      );
    }
    const inheritedEnv = sampleModelEnvironment(env);
    const provider = inheritedEnv.HAZE_PROVIDER?.trim() || 'offline';
    if (
      !['offline', 'nvidia', 'openai-compatible', 'nightshift'].includes(
        provider,
      )
    )
      throw new Error('Invalid inherited model route provider.');
    const defaultProvider = provider as EffectiveModelRoute['provider'];
    const model =
      inheritedEnv.HAZE_MODEL?.trim() ||
      (provider === 'nvidia' ? NVIDIA_MODEL : null);
    if (provider !== 'offline' && !model)
      throw new Error('Inherited model route requires HAZE_MODEL.');
    if (model && (model.length > 256 || hasControlCharacters(model)))
      throw new Error('Invalid inherited model route model.');
    const inherited = freezeRoute(
      {
        profile: 'inherited',
        provider: defaultProvider,
        requested_model: model,
        base_url: normalizeBase(
          inheritedEnv.HAZE_PROVIDER_BASE_URL?.trim(),
          defaultProvider,
        ),
        credential_ref:
          provider === 'offline' ||
          (sampleModelAllowsNoCredential(
            inheritedEnv,
            provider,
            inheritedEnv.HAZE_PROVIDER_BASE_URL,
          ) &&
            !inheritedEnv.HAZE_PROVIDER_API_KEY?.trim())
            ? null
            : provider === 'nightshift'
              ? nightshiftCredentialReference(env)
              : `env:${provider === 'nvidia' && !inheritedEnv.HAZE_PROVIDER_API_KEY?.trim() ? 'NVIDIA_API_KEY' : 'HAZE_PROVIDER_API_KEY'}`,
        policy: 'provider-default',
      },
      sampleModelUsesBuiltinFallback(env),
    );
    const resolved = new Map<string, EffectiveModelRoute>();
    for (const [name, profile] of Object.entries(profiles)) {
      if (hasControlCharacters(profile.model))
        throw new Error('Invalid model route model.');
      const ref = profile.credential_env
        ? `env:${profile.credential_env}`
        : profile.provider === 'nightshift'
          ? nightshiftCredentialReference(env)
          : sampleModelAllowsNoCredential(
                env,
                profile.provider,
                profile.base_url,
              ) && !env.HAZE_PROVIDER_API_KEY?.trim()
            ? null
            : `env:${profile.provider === 'nvidia' && !env.HAZE_PROVIDER_API_KEY?.trim() ? 'NVIDIA_API_KEY' : 'HAZE_PROVIDER_API_KEY'}`;
      resolved.set(
        name,
        freezeRoute({
          profile: name,
          provider: profile.provider,
          requested_model: profile.model,
          base_url: normalizeBase(profile.base_url, profile.provider),
          credential_ref: ref,
          policy: profile.policy,
        }),
      );
    }
    const routes = Object.fromEntries(
      agentRoleSchema.options.map((role) => {
        const name = mappings[role];
        const route = name ? resolved.get(name) : inherited;
        if (!route)
          throw new Error('Agent route references an unknown model profile.');
        return [role, route];
      }),
    ) as Record<AgentRole, EffectiveModelRoute>;
    this.#snapshot = Object.freeze({
      version: 1,
      routes: Object.freeze(routes),
    });
    modelRouteSnapshotSchema.parse(this.#snapshot);
  }
  snapshot(): ModelRouteSnapshot {
    return this.#snapshot;
  }

  private validatedRoute(value: EffectiveModelRoute): {
    route: EffectiveModelRoute;
    key: string;
    generation: string;
  } {
    const route = effectiveModelRouteSchema.parse(value);
    const expectedContract = contract(
      route.provider,
      isBuiltinSampleModelRoute(this.env, route) &&
        route.capability_contract.id === 'ollama-sample-chat-v1',
    );
    if (
      route.capability_contract.id !== expectedContract.id ||
      route.capability_contract.hash !== expectedContract.hash
    ) {
      throw new Error(
        'Admitted model route capability contract is incompatible with this runtime. Admit a linked continuation with a new snapshot.',
      );
    }
    const authority = { ...route, route_id: undefined };
    if (route.route_id !== `route-${hash(authority)}`)
      throw new Error('Admitted model route identity is invalid.');
    if (route.provider === 'offline' || route.provider === 'injected')
      throw new Error('The admitted route has no live inference provider.');
    if (route.policy === 'local-only')
      throw new Error(
        'The admitted direct inference route cannot enforce local-only compute.',
      );
    const key = resolveRouteCredential(route.credential_ref, this.env) ?? '';
    if (
      !key &&
      !(
        route.credential_ref === null &&
        sampleModelAllowsNoCredential(this.env, route.provider, route.base_url)
      )
    )
      throw new Error(
        'The admitted model route has no available server credential.',
      );
    const generation = `${route.route_id}:${hash(key)}`;
    return { route, key, generation };
  }

  resolve(value: EffectiveModelRoute): AgentModel {
    const { route, key, generation } = this.validatedRoute(value);
    if (route.provider === 'nightshift')
      throw new Error(
        `${NIGHTSHIFT_CONTRACT_FAILURE} Prepare the route before dispatch.`,
      );
    return this.adapter(route, key, generation);
  }

  async prepare(
    value: EffectiveModelRoute,
    signal: AbortSignal,
  ): Promise<AgentModel> {
    signal.throwIfAborted();
    const { route, key, generation } = this.validatedRoute(value);
    if (
      isBuiltinSampleModelRoute(this.env, route) &&
      !modelCacheConfiguration(this.env, route)
    )
      await prepareSampleModel(this.env, this.fetcher, signal);
    if (route.provider === 'nightshift') {
      const inspection = await inspectNightshiftContract(
        route.base_url!,
        key,
        route.requested_model,
        this.fetcher,
        signal,
      );
      if (!inspection.contract_verified)
        throw new Error(NIGHTSHIFT_CONTRACT_FAILURE);
      signal.throwIfAborted();
    }
    return this.adapter(route, key, generation);
  }

  private adapter(
    route: EffectiveModelRoute,
    key: string,
    generation: string,
  ): AgentModel {
    const cached = this.#models.get(generation);
    if (cached) return cached;
    const baseAdapter =
      route.provider === 'nightshift'
        ? resolveStrictNightshiftModel(
            route.base_url!,
            route.requested_model!,
            key,
            this.fetcher,
          )
        : resolveAgentModel(
            isBuiltinSampleModelRoute(this.env, route)
              ? this.env
              : {
                  HAZE_PROVIDER: route.provider,
                  HAZE_MODEL: route.requested_model ?? '',
                  HAZE_PROVIDER_BASE_URL: route.base_url ?? '',
                  HAZE_PROVIDER_API_KEY: key,
                  SAMPLE_MODE: this.env.SAMPLE_MODE,
                },
            this.fetcher,
          );
    const cacheOptions = modelCacheConfiguration(this.env, route);
    const adapter = cacheOptions
      ? withCachedAgentModel(baseAdapter, {
          ...cacheOptions,
          normalizer: managerModelCacheNormalizer,
          onEvent: ({ type, key: cacheKey }) => {
            console.log(`[model-cache] ${type} ${cacheKey.slice(0, 16)}`);
          },
        })
      : baseAdapter;
    for (const cacheKey of this.#models.keys())
      if (cacheKey.startsWith(`${route.route_id}:`))
        this.#models.delete(cacheKey);
    this.#models.set(generation, adapter);
    return adapter;
  }

  async readiness(): Promise<ModelReadiness> {
    const checks = new Map<
      string,
      Promise<{
        reachability: 'unchecked' | 'reachable' | 'unreachable' | 'blocked';
        reason: string | null;
        schema_compatible?: boolean;
      }>
    >();
    for (const route of Object.values(this.#snapshot.routes)) {
      if (checks.has(route.route_id)) continue;
      checks.set(
        route.route_id,
        (async () => {
          if (route.provider === 'offline')
            return {
              reachability: 'blocked' as const,
              reason: 'Offline route has no inference provider.',
            };
          const credential = resolveRouteCredential(
            route.credential_ref,
            this.env,
          );
          if (
            !credential &&
            !(
              route.credential_ref === null &&
              sampleModelAllowsNoCredential(
                this.env,
                route.provider,
                route.base_url,
              )
            )
          )
            return {
              reachability: 'blocked' as const,
              reason: 'Server credential is unavailable.',
            };
          if (route.provider === 'nightshift') {
            const inspection = await inspectNightshiftContract(
              route.base_url!,
              credential!,
              route.requested_model,
              this.fetcher,
            );
            return {
              reachability: inspection.reachability,
              schema_compatible:
                inspection.contract_verified && route.policy !== 'local-only',
              reason: inspection.contract_verified
                ? route.policy === 'local-only'
                  ? 'Direct inference cannot enforce the configured local-only restriction.'
                  : 'Strict inference contract negotiated for the requested model; live verification and role quality remain unverified.'
                : NIGHTSHIFT_CONTRACT_FAILURE,
            };
          }
          return {
            reachability: 'unchecked' as const,
            reason:
              route.policy === 'local-only'
                ? 'Direct inference cannot enforce the configured local-only restriction.'
                : 'Configured transport contract only; reachability and role quality have not been verified.',
          };
        })(),
      );
    }
    return {
      version: 1,
      checked_at: new Date().toISOString(),
      routes: await Promise.all(
        agentRoleSchema.options.map(async (role) => {
          const route = this.#snapshot.routes[role];
          const check = await checks.get(route.route_id)!;
          return {
            role,
            profile: route.profile,
            route_id: route.route_id,
            provider: route.provider,
            requested_model: route.requested_model,
            configured: route.provider !== 'offline',
            schema_compatible:
              route.provider !== 'offline' &&
              route.provider !== 'nightshift' &&
              route.policy !== 'local-only',
            ...check,
            live_verified: false as const,
            role_evaluation: 'unverified' as const,
            policy: route.policy,
          };
        }),
      ),
    };
  }
}
