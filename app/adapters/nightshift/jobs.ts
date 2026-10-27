import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { canonicalJson, parseContractJson } from '../../contracts/json.js';
import {
  NIGHTSHIFT_LIMITS,
  nightshiftJobOptionsSchema,
  type NightshiftAttemptMetadata,
  type NightshiftJobReadiness,
  type NightshiftRemoteJob,
  type NightshiftRemoteOutcome,
  type NightshiftRemoteResult,
  type NightshiftSubmitRequest,
} from '../../contracts/nightshift.js';
import {
  NightshiftJobTransportError,
  type NightshiftJobPort,
} from '../../orchestration/ports.js';
import {
  nightshiftCredentialReference,
  resolveRouteCredential,
} from './runtime.js';

export const NIGHTSHIFT_JOB_ADAPTER_VERSION = 'haze.nightshift.cli.v3';
const MAX_STDIO_BYTES = 2 * 1024 * 1024;
// Installed cancel() labels the record before provider-abort completion. That
// label is deliberately absent: it cannot prove remote compute termination.
const TERMINAL = new Set(['completed', 'sealed', 'failed', 'errored']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/u;
const OWNERSHIP_NONCE =
  /^\[Haze request ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]\n/u;

function controlSocket(env: NodeJS.ProcessEnv): string {
  if (env.METERLESS_CONTROL_SOCKET) return env.METERLESS_CONTROL_SOCKET;
  if (process.platform !== 'win32') return '/run/meterless/runtime.sock';
  const profile =
    env.LOCALAPPDATA || join(env.USERPROFILE || homedir(), 'AppData', 'Local');
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(profile.toLowerCase(), 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `\\\\.\\pipe\\ai.meterless.runtime-${(hash & 0xffffffffffffn).toString(16).padStart(12, '0')}-runtime`;
}
/** One bounded control-plane GET, mirroring CLI status discovery; never core.sock or key APIs. */
function readNightshiftControl(
  env: NodeJS.ProcessEnv,
  path: '/admin/fleets' | '/admin/status',
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let done = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (body: Record<string, unknown> | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(body);
    };
    const abort = () => {
      request.destroy();
      finish(null);
    };
    const request = httpRequest(
      {
        socketPath: controlSocket(env),
        path,
        method: 'GET',
        headers: { host: 'meterlessd', accept: 'application/json' },
      },
      (response) => {
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > 262_144) abort();
          else chunks.push(chunk);
        });
        response.on('error', () => finish(null));
        response.on('end', () => {
          try {
            const body = record(
              parseContractJson(
                Buffer.concat(chunks).toString('utf8'),
                262_144,
              ),
            );
            finish(response.statusCode === 200 ? body : null);
          } catch {
            finish(null);
          }
        });
      },
    );
    const timer = setTimeout(abort, 3000);
    request.on('error', () => finish(null));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else request.end();
  });
}
export async function readNightshiftFleetIds(
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string[]> {
  const body = await readNightshiftControl(env, '/admin/fleets', signal);
  const fleets = body?.fleets;
  return Array.isArray(fleets) && fleets.length <= 128
    ? fleets
        .map((item) => record(item)?.id)
        .filter((id): id is string => typeof id === 'string' && ID.test(id))
    : [];
}
/** A reachable daemon and ready cloud lanes do not establish local compute. */
export function inspectLocalCompute(
  fleetValue: unknown,
  statusValue: unknown,
): { available: boolean; fleets: string[] } {
  const status = record(statusValue);
  const fleetDoc = record(fleetValue);
  const lanes = Array.isArray(status?.lanes) ? status.lanes : [];
  const local = lanes
    .map(record)
    .filter(
      (lane): lane is Record<string, unknown> =>
        lane?.kind === 'local' &&
        !lane.disabled &&
        lane.races !== false &&
        typeof lane.state === 'string' &&
        lane.state.toLowerCase() === 'ready' &&
        typeof lane.model === 'string' &&
        lane.model.length > 0,
    );
  const fleets = Array.isArray(fleetDoc?.fleets) ? fleetDoc.fleets : [];
  return {
    available: local.length > 0,
    fleets: fleets
      .slice(0, 128)
      .filter((value: unknown) => {
        const fleet = record(value);
        if (
          typeof fleet?.id !== 'string' ||
          !ID.test(fleet.id) ||
          !Array.isArray(fleet.lanes)
        )
          return false;
        return fleet.lanes.some((value: unknown) => {
          const lane = record(value);
          return (
            lane?.kind === 'local' &&
            local.some(
              (ready) => ready?.id === lane.id && ready.model === lane.model,
            )
          );
        });
      })
      .map((value: unknown) => String(record(value)!.id)),
  };
}
/** Cloud permission is separate from a local gateway address or local readiness. */
export function inspectCloudCompute(statusValue: unknown): boolean {
  const status = record(statusValue);
  const lanes = Array.isArray(status?.lanes) ? status.lanes : [];
  return lanes.some((value: unknown) => {
    const lane = record(value);
    return (
      lane !== null &&
      (lane.kind === 'cloud' ||
        (lane.kind === undefined && lane.provider === 'nvidia')) &&
      !lane.disabled &&
      lane.races !== false &&
      typeof lane.state === 'string' &&
      lane.state.toLowerCase() === 'ready' &&
      typeof lane.model === 'string' &&
      lane.model.length > 0
    );
  });
}
// Source-reviewed privacy contract: attempts AND judges carry the job floor
// through host.mjs to providers.js's refusal boundary. Cloud jobs omit the CLI's
// unenforceable monetary ceiling. New builds fail closed.
const REVIEWED_SOURCE_HASHES: Record<string, string> = {
  'cli/ns.mjs':
    'f6c05c9c30f549eacebefe1a0413730a0e346c20f37896a29f7fc2da52e0f378',
  'cli/lib/transport.mjs':
    '2ba85dbdd7ea8e4d31fc76c60d44e9c4267b097a194d0123e24612d3284eb3a7',
  'engine/js/engine/jobs.js':
    '94bafd05f32a9b7a58ff91be0a7feaf549f5513c078232e9b5d2f26a76a2757a',
  'engine/js/engine/providers.js':
    '04fae12dfdeb4299ee2a36016b437de7bf5120006393d0c8c1d88ac75f288825',
  'engine/host.mjs':
    'ab9e35a78b6545780c904a1d7bc3d6e576598edf5e3e063aebc0c4d2d3e5ce00',
};
// The reviewed strict-inference overlay adds a separate facade and HTTP route.
// Job methods and their local-only refusal boundary are unchanged. Its imported
// modules are pinned too: a matching host alone cannot attest a changed overlay.
const REVIEWED_STRICT_SOURCE_HASHES: Record<string, string> = {
  'engine/host.mjs':
    'e1668b09429e1aca3364a3cbefe2c2b9acb2a2cdc94a0ead9dca582a17bab350',
  'engine/server.mjs':
    'e0ba7c357f688b096c60d7d09937d68ff2102424c329ea55d58a3ddd108e8e80',
  'engine/haze-strict/integration.mjs':
    '8fa11bc9801d62f70a86f7183e4ab3524e1bc49fc5578f3d602e85c03b23233c',
  'engine/haze-strict/handler.mjs':
    '8c709532e5845419b177ff8edc4bcaac345a19ff2aa81d476802cc051422c5d0',
};
export function reviewedNightshiftJobSourceHashes(
  actual: Readonly<Record<string, string>>,
): boolean {
  const matches = (expected: Record<string, string>) =>
    Object.entries(expected).every(([path, hash]) => actual[path] === hash);
  return (
    matches(REVIEWED_SOURCE_HASHES) ||
    matches({ ...REVIEWED_SOURCE_HASHES, ...REVIEWED_STRICT_SOURCE_HASHES })
  );
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function safeText(value: unknown, max = 256): string | null {
  return typeof value === 'string' && value.trim() && value.length <= max
    ? value
    : null;
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
function remoteId(value: string): string {
  if (!ID.test(value))
    throw new NightshiftJobTransportError(
      'rejected-before-acceptance',
      'invalid_remote_id',
      'Nightshift job identity is invalid.',
    );
  return value;
}
export interface NightshiftCliCommand {
  command: string;
  prefix: string[];
  installationRoot: string | null;
}
export function discoverNightshiftCli(
  env: NodeJS.ProcessEnv,
): NightshiftCliCommand {
  let command =
    env.HAZE_NIGHTSHIFT_CLI?.trim() ||
    (process.platform === 'win32'
      ? join(env.LOCALAPPDATA || '', 'Nightshift', 'cli', 'ns.cmd')
      : '/usr/lib/meterless/cli/ns.mjs');
  let script: string;
  if (/\.(cmd|bat)$/iu.test(command)) {
    script = join(dirname(resolve(command)), 'ns.mjs');
    if (!existsSync(script))
      throw new NightshiftJobTransportError(
        'rejected-before-acceptance',
        'cli_unavailable',
        'The installed Nightshift CLI is unavailable.',
      );
  } else if (/\.m?js$/iu.test(command)) script = resolve(command);
  else
    throw new NightshiftJobTransportError(
      'rejected-before-acceptance',
      'cli_unsupported',
      'Configure the installed ns.mjs CLI; shell launchers are not executed.',
    );
  const bundledNode = resolve(dirname(script), '../node/node.exe');
  command =
    process.platform === 'win32' && existsSync(bundledNode)
      ? bundledNode
      : process.execPath;
  return {
    command,
    prefix: [script],
    installationRoot: resolve(dirname(script), '..'),
  };
}
function reviewedInstallation(command: NightshiftCliCommand): boolean {
  if (!command.installationRoot) return false;
  try {
    const paths = Object.keys(REVIEWED_SOURCE_HASHES);
    const actual: Record<string, string> = {};
    const readHash = (path: string) =>
      createHash('sha256')
        .update(readFileSync(join(command.installationRoot!, path)))
        .digest('hex');
    for (const path of paths) actual[path] = readHash(path);
    if (
      actual['engine/host.mjs'] ===
      REVIEWED_STRICT_SOURCE_HASHES['engine/host.mjs']
    )
      for (const path of Object.keys(REVIEWED_STRICT_SOURCE_HASHES))
        actual[path] = readHash(path);
    return reviewedNightshiftJobSourceHashes(actual);
  } catch {
    return false;
  }
}
export interface NightshiftCliInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin?: string;
  signal?: AbortSignal;
  mutation: boolean;
}
export type NightshiftCliRunner = (
  input: NightshiftCliInvocation,
) => Promise<{ stdout: string; exit_code: number }>;
/** No shell, bounded combined output, no upstream diagnostics in thrown errors. */
export const runNightshiftCli: NightshiftCliRunner = (input) =>
  new Promise((done, reject) => {
    let launched = false;
    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const failure = (code: string) =>
      new NightshiftJobTransportError(
        input.mutation
          ? launched
            ? 'unknown'
            : 'rejected-before-acceptance'
          : 'read-failed',
        code,
        `Nightshift CLI ${code.replaceAll('_', ' ')}. No automatic submission replay is permitted.`,
      );
    if (input.signal?.aborted) {
      reject(failure('cancelled'));
      return;
    }
    const child = spawn(input.command, input.args, {
      env: input.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finish = (error?: Error, exitCode?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      if (error) {
        child.kill();
        reject(error);
      } else
        done({
          stdout: Buffer.concat(chunks).toString('utf8'),
          exit_code: exitCode ?? 1,
        });
    };
    const abort = () => finish(failure('cancelled'));
    const timer = setTimeout(() => finish(failure('timed_out')), 30_000);
    child.once('spawn', () => {
      launched = true;
    });
    child.once('error', () => finish(failure('unavailable')));
    child.once('close', (code) => finish(undefined, code ?? 1));
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_STDIO_BYTES) finish(failure('response_oversized'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_STDIO_BYTES) finish(failure('response_oversized'));
    });
    child.stdin.on('error', () => undefined);
    input.signal?.addEventListener('abort', abort, { once: true });
    child.stdin.end(input.stdin ?? '');
  });

/** Parse bounded envelope/NDJSON; never treat a prefix or stream frame as acknowledgement. */
export function parseNightshiftEnvelope(
  stdout: string,
  mutation = false,
): unknown {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_STDIO_BYTES)
    throw new NightshiftJobTransportError(
      mutation ? 'unknown' : 'read-failed',
      'response_oversized',
      'Nightshift response exceeded the retrieval limit.',
    );
  let value: Record<string, unknown> | null = null;
  let finals = 0;
  try {
    const lines = stdout.trim().split(/\r?\n/u);
    for (const line of lines) {
      const frame = record(parseContractJson(line, MAX_STDIO_BYTES));
      if (!frame || frame.ns !== 1) throw new Error();
      if (typeof frame.ok === 'boolean') {
        value = frame;
        finals++;
      } else if (value) throw new Error();
    }
  } catch {
    throw new NightshiftJobTransportError(
      mutation ? 'unknown' : 'read-failed',
      'invalid_envelope',
      'Nightshift returned no valid complete acknowledgement.',
    );
  }
  if (!value || typeof value.ok !== 'boolean' || finals !== 1)
    throw new NightshiftJobTransportError(
      mutation ? 'unknown' : 'read-failed',
      'missing_acknowledgement',
      'Nightshift returned no final acknowledgement.',
    );
  if (!value.ok) {
    const error = record(value.error);
    const status = count(error?.status);
    const preAcceptance =
      (error?.source === 'engine' &&
        status !== null &&
        [400, 401, 403, 404, 409, 422, 429].includes(status)) ||
      (error?.source === 'cli' &&
        ['E_USAGE', 'E_INVALID', 'E_UNAUTHORIZED'].includes(
          String(error.code),
        ));
    throw new NightshiftJobTransportError(
      mutation
        ? preAcceptance
          ? 'rejected-before-acceptance'
          : 'unknown'
        : 'read-failed',
      status !== null ? `http_${status}` : 'cli_rejected',
      'Nightshift rejected the request or did not establish its remote outcome.',
    );
  }
  return value.data;
}

export class CliNightshiftJobAdapter implements NightshiftJobPort {
  private readonly command: NightshiftCliCommand | null;
  private readonly childEnv: NodeJS.ProcessEnv;
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly runner: NightshiftCliRunner = runNightshiftCli,
  ) {
    try {
      this.command = discoverNightshiftCli(env);
    } catch {
      this.command = null;
    }
    const base = new URL(env.NS_BASE_URL || 'http://127.0.0.1:8088');
    if (
      base.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(base.hostname) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== '/'
    )
      throw new Error(
        'Nightshift jobs require a credential-free local HTTP runtime URL.',
      );
    this.childEnv = { ...env, NS_BASE_URL: base.origin };
  }
  private redact(value: string): string {
    const credential = resolveRouteCredential(
      nightshiftCredentialReference(this.env),
      this.env,
    );
    return credential ? value.replaceAll(credential, '[redacted]') : value;
  }
  private text(value: unknown, max = 256): string | null {
    const text = safeText(value, max);
    return text === null ? null : this.redact(text);
  }
  private async invoke(
    args: string[],
    signal?: AbortSignal,
    stdin?: string,
    mutation = false,
  ): Promise<unknown> {
    if (!this.command)
      throw new NightshiftJobTransportError(
        mutation ? 'rejected-before-acceptance' : 'read-failed',
        'cli_unavailable',
        'The installed Nightshift CLI is unavailable.',
      );
    const childEnv = { ...this.childEnv };
    if (this.env.METERLESS_TOKEN === undefined) delete childEnv.METERLESS_TOKEN;
    else childEnv.METERLESS_TOKEN = this.env.METERLESS_TOKEN;
    const invocation: NightshiftCliInvocation = {
      command: this.command.command,
      args: [...this.command.prefix, ...args, '--json', '--timeout', '5000'],
      env: childEnv,
      mutation,
      ...(signal ? { signal } : {}),
      ...(stdin !== undefined ? { stdin } : {}),
    };
    let result;
    try {
      result = await this.runner(invocation);
    } catch (error) {
      if (error instanceof NightshiftJobTransportError) throw error;
      throw new NightshiftJobTransportError(
        mutation ? 'unknown' : 'read-failed',
        'cli_failed',
        'Nightshift CLI request failed without a verified outcome.',
      );
    }
    const data = parseNightshiftEnvelope(result.stdout, mutation);
    if (result.exit_code !== 0)
      throw new NightshiftJobTransportError(
        mutation ? 'unknown' : 'read-failed',
        'unsuccessful_exit',
        'Nightshift did not exit successfully despite its response.',
      );
    return data;
  }
  async readiness(signal?: AbortSignal): Promise<NightshiftJobReadiness> {
    const base: NightshiftJobReadiness = {
      schema_version: 'haze.nightshift.jobs.readiness.v1',
      checked_at: new Date().toISOString(),
      cli_available: false,
      schema_compatible: false,
      runtime_reachable: false,
      local_only_enforced: false,
      local_compute_available: false,
      cloud_enforced: false,
      cloud_compute_available: false,
      ready: false,
      runtime_version: null,
      adapter_version: NIGHTSHIFT_JOB_ADAPTER_VERSION,
      schema_hash: null,
      can_reconcile: false,
      cancellation_idempotent: false,
      reason: null,
      options: {
        judges: ['accuracy', 'consistency', 'creative', 'quality'],
        budgets: ['low', 'mid', 'high', 'max'],
        windows: ['now', 'quiet'],
        max_attempts: 16,
        fleets: [],
      },
    };
    if (!this.command)
      return {
        ...base,
        reason: 'The installed Nightshift CLI is unavailable.',
      };
    if (
      !['', 'false', '0'].includes(
        this.env.SAMPLE_MODE?.trim().toLowerCase() ?? '',
      )
    )
      return { ...base, reason: 'Sample mode disables Nightshift requests.' };
    try {
      const schema = record(await this.invoke(['schema', 'generate'], signal));
      base.cli_available = true;
      const detail =
        record(schema?.detail) ??
        (Array.isArray(schema?.commands) ? record(schema.commands[0]) : null);
      const flags = record(detail?.flags);
      const accepts = (name: string, values: string[]) => {
        const item = record(flags?.[name]);
        const advertised = item?.values;
        return (
          Array.isArray(advertised) &&
          values.every((value) => advertised.includes(value))
        );
      };
      base.schema_compatible =
        !!flags &&
        ['n', 'fleet', 'max-spend', 'prompt'].every(
          (name) => flags[name] !== undefined,
        ) &&
        accepts('kind', ['best_of_n']) &&
        accepts('privacy', ['local-only', 'cloud-ok']) &&
        accepts('judge', base.options.judges) &&
        accepts('budget', base.options.budgets) &&
        accepts('window', base.options.windows);
      base.schema_hash = createHash('sha256')
        .update(JSON.stringify(detail))
        .digest('hex');
      const status = record(await this.invoke(['status'], signal));
      base.runtime_reachable = status?.engine_reachable === true;
      base.runtime_version = this.text(status?.version);
      const discovery = record(await this.invoke(['discover'], signal));
      const caps = record(discovery?.capabilities);
      const generation = record(caps?.generation)?.available === true;
      const outcome = record(caps?.job_outcome)?.available === true;
      const sourceContract =
        reviewedInstallation(this.command) && base.runtime_version === '1.2.1';
      base.local_only_enforced = sourceContract;
      base.cloud_enforced = sourceContract;
      let localCompute = { available: false, fleets: [] as string[] };
      let cloudCompute = false;
      if (base.runtime_reachable && sourceContract) {
        const [fleets, status] = await Promise.all([
          readNightshiftControl(this.env, '/admin/fleets', signal),
          readNightshiftControl(this.env, '/admin/status', signal),
        ]);
        localCompute = inspectLocalCompute(fleets, status);
        cloudCompute = inspectCloudCompute(status);
        // This runtime records fleet_id as metadata; it does not select a
        // different compute roster. Do not advertise it as a submission choice.
      }
      base.local_compute_available = localCompute.available;
      base.cloud_compute_available = cloudCompute;
      const contractAvailable =
        base.schema_compatible &&
        base.runtime_reachable &&
        generation &&
        outcome &&
        sourceContract;
      base.ready =
        contractAvailable && (localCompute.available || cloudCompute);
      base.can_reconcile = contractAvailable;
      base.reason = base.ready
        ? 'Text jobs can use the ready runtime lanes permitted by their grant. Cloud-enabled jobs have no monetary cap; local-only jobs retain $0 cloud spend. Explicit fleet selection is unsupported. Exact native-request reconciliation requires a stored server nonce.'
        : !sourceContract
          ? 'The installed job privacy contract has not been reviewed for this build.'
          : contractAvailable && !localCompute.available && !cloudCompute
            ? 'The daemon is reachable, but no eligible local or cloud text lane is ready. Configure ready models and fleets in Nightshift.'
            : 'The runtime job capabilities are unavailable or unverified.';
      return base;
    } catch {
      return {
        ...base,
        ready: false,
        reason:
          'The installed Nightshift CLI or runtime capabilities are unavailable.',
      };
    }
  }
  async submit(
    value: NightshiftSubmitRequest,
    signal?: AbortSignal,
  ): Promise<{ remote_id: string }> {
    let request: NightshiftSubmitRequest;
    try {
      request = nightshiftJobOptionsSchema.parse(value);
    } catch {
      throw new NightshiftJobTransportError(
        'rejected-before-acceptance',
        'invalid_options',
        'Nightshift job options violate the admitted privacy and spending contract.',
      );
    }
    if (request.fleet !== undefined)
      throw new NightshiftJobTransportError(
        'rejected-before-acceptance',
        'fleet_unverified',
        'The installed runtime records fleet names as metadata and cannot select compute by fleet; use runtime selection.',
      );
    const readiness = await this.readiness(signal);
    const policyReady =
      request.privacy === 'cloud-ok'
        ? readiness.cloud_enforced && readiness.cloud_compute_available === true
        : readiness.local_only_enforced &&
          readiness.local_compute_available !== false;
    if (!readiness.ready || !policyReady)
      throw new NightshiftJobTransportError(
        'rejected-before-acceptance',
        'unavailable',
        'Nightshift job readiness is not established for the requested privacy policy.',
      );
    const args = [
      'generate',
      '-',
      '--kind',
      'best_of_n',
      '--n',
      String(request.n),
      '--judge',
      request.judge,
      '--budget',
      request.budget,
      '--window',
      request.window,
      '--privacy',
      request.privacy,
    ];
    if (request.privacy === 'local-only') args.push('--max-spend', '0');
    const result = record(
      await this.invoke(args, signal, request.prompt, true),
    );
    const id = safeText(result?.job_id, 160);
    if (!id || !ID.test(id))
      throw new NightshiftJobTransportError(
        'unknown',
        'missing_remote_id',
        'Submission returned no valid remote job identity. Do not submit it again.',
      );
    return { remote_id: id };
  }
  async inspect(
    id: string,
    signal?: AbortSignal,
  ): Promise<NightshiftRemoteJob> {
    const data = record(
      await this.invoke(['job', 'get', remoteId(id)], signal),
    );
    if (!data || data.id !== id || typeof data.status !== 'string')
      throw new NightshiftJobTransportError(
        'read-failed',
        'invalid_job',
        'Nightshift returned an incompatible job record.',
      );
    return {
      remote_id: id,
      execution_state:
        data.status === 'errored'
          ? 'failed'
          : data.status === 'sealed'
            ? 'completed'
            : [
                  'queued',
                  'running',
                  'paused',
                  'completed',
                  'cancelled',
                  'failed',
                  'errored',
                  'open',
                  'sealed',
                ].includes(data.status)
              ? data.status
              : 'unknown',
      terminal: TERMINAL.has(data.status),
      generated: count(data.generated),
      requested_attempts: count(data.n),
      privacy: ['local-only', 'cloud-ok', 'edge-only'].includes(
        String(data.privacy),
      )
        ? (data.privacy as string)
        : null,
      fleet: this.text(data.fleet_id),
      runtime_version: null,
      native_execution_state: this.text(data.status),
      failure_code:
        typeof data.error === 'string' &&
        data.error.includes('privacy_floor_refuses_pinned_model')
          ? 'privacy_floor_refuses_pinned_model'
          : [
                'all_attempts_failed',
                'no_candidates',
                'privacy_floor_refuses_pinned_model',
              ].includes(String(data.error_code))
            ? String(data.error_code)
            : null,
    };
  }
  async outcome(
    id: string,
    signal?: AbortSignal,
  ): Promise<NightshiftRemoteOutcome> {
    const data = record(
      await this.invoke(['job', 'outcome', remoteId(id)], signal),
    );
    return {
      status:
        data &&
        ['accepted', 'rejected', 'undecided'].includes(String(data.status))
          ? (data.status as NightshiftRemoteOutcome['status'])
          : 'unknown',
      basis: this.text(data?.basis, 4096),
      explanation:
        typeof data?.explanation === 'string'
          ? this.redact(data.explanation).slice(0, 4096)
          : null,
    };
  }
  async result(
    id: string,
    signal?: AbortSignal,
  ): Promise<NightshiftRemoteResult> {
    const data = record(
      await this.invoke(
        ['context', 'get', remoteId(id), '--view', 'full'],
        signal,
      ),
    );
    const selected = data?.selected_attempts;
    if (
      !data ||
      data.truncated === true ||
      !Array.isArray(selected) ||
      selected.length > NIGHTSHIFT_LIMITS.attempts
    )
      throw new NightshiftJobTransportError(
        'read-failed',
        'result_incomplete',
        'Nightshift result or attempt metadata is incomplete or oversized.',
      );
    const winner = count(data.winner_seq);
    const attempts: NightshiftAttemptMetadata[] = selected.map(
      (entry: unknown) => {
        const a = record(entry);
        const seq = count(a?.seq);
        if (!a || !seq)
          throw new NightshiftJobTransportError(
            'read-failed',
            'invalid_attempt',
            'Nightshift returned incompatible attempt metadata.',
          );
        const model = record(a.model);
        return {
          seq,
          lane: this.text(a.lane),
          model:
            this.redact(safeText(a.model) ?? safeText(model?.resolved) ?? '') ||
            null,
          input_tokens: null,
          output_tokens: null,
          total_tokens: a.tokens_source === 'measured' ? count(a.tokens) : null,
          reported_tokens: count(a.tokens),
          tokens_source: [
            'measured',
            'estimated',
            'event',
            'unavailable',
          ].includes(String(a.tokens_source))
            ? String(a.tokens_source)
            : null,
          finish_reason: this.text(a.finish_reason),
          receipt_id: this.text(a.receipt_id),
          prompt_sha256: this.text(a.prompt_sha256),
        };
      },
    );
    if (
      Buffer.byteLength(JSON.stringify(attempts), 'utf8') >
      NIGHTSHIFT_LIMITS.metadata_bytes
    )
      throw new NightshiftJobTransportError(
        'read-failed',
        'metadata_oversized',
        'Nightshift attempt metadata exceeded the retrieval limit.',
      );
    const choice: unknown = selected.find(
      (item: unknown) => record(item)?.seq === winner,
    );
    const text = record(choice)?.text;
    if (typeof text !== 'string' || !text.trim())
      return {
        text: null,
        attempts,
        winner_seq: winner,
        retrieval_error: 'The terminal job has no retrievable winner text.',
        truncated: false,
      };
    if (text.length > NIGHTSHIFT_LIMITS.result_characters)
      throw new NightshiftJobTransportError(
        'read-failed',
        'result_oversized',
        'Nightshift output exceeded the retrieval limit and is not a usable candidate.',
      );
    return {
      text: this.redact(text),
      attempts,
      winner_seq: winner,
      retrieval_error: null,
      truncated: false,
    };
  }
  async cancel(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ acknowledged: boolean }> {
    await this.invoke(['job', 'cancel', remoteId(id)], signal, undefined, true);
    return { acknowledged: true };
  }
  async verifyReconciliation(
    id: string,
    request: NightshiftSubmitRequest,
    signal?: AbortSignal,
  ): Promise<{ verified: boolean; reason: string | null }> {
    const refused = {
      verified: false,
      reason:
        'The remote native request and original server ownership nonce could not be verified exactly.',
    };
    if (!nightshiftJobOptionsSchema.safeParse(request).success) return refused;
    const marker = OWNERSHIP_NONCE.exec(request.prompt)?.[0];
    if (
      !marker ||
      (request.prompt.match(/\[Haze request /gu)?.length ?? 0) !== 1
    )
      return refused;
    try {
      const readiness = await this.readiness(signal);
      if (
        !readiness.can_reconcile ||
        !readiness.runtime_reachable ||
        !(request.privacy === 'cloud-ok'
          ? readiness.cloud_enforced
          : readiness.local_only_enforced)
      )
        return refused;
      const native = record(
        await this.invoke(['job', 'get', remoteId(id)], signal),
      );
      if (
        !native ||
        native.id !== id ||
        native.app !== 'ns' ||
        native.kind !== 'best_of_n' ||
        native.prompt_full !== request.prompt ||
        canonicalJson(native.messages) !==
          canonicalJson([{ role: 'user', content: request.prompt }]) ||
        native.n !== request.n ||
        native.window !== request.window ||
        native.privacy !== request.privacy ||
        native.judge_mode !== request.judge ||
        record(native.attempt_budget)?.level !== request.budget ||
        (native.fleet_id ?? null) !== (request.fleet ?? null)
      )
        return refused;
      // The reviewed collection route lists all jobs without a hidden page cap.
      // A copied nonce is ambiguous even if one matching record was supplied.
      const listing = record(await this.invoke(['job', 'list'], signal));
      const jobs = listing?.jobs;
      if (
        !Array.isArray(jobs) ||
        jobs.length > 256 ||
        listing?.total !== jobs.length
      )
        return refused;
      const matches = jobs.filter((item: unknown) => {
        const row = record(item);
        return (
          typeof row?.prompt === 'string' &&
          row.prompt.startsWith(marker.trimEnd())
        );
      });
      if (matches.length !== 1 || record(matches[0])?.id !== id) return refused;
      return { verified: true, reason: null };
    } catch {
      return refused;
    }
  }
}
