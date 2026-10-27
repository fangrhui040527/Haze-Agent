import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv, stripVTControlCharacters } from 'node:util';

const choices = (values) => (value) =>
  values.includes(value) ? null : `must be one of ${values.join(', ')}`;
const boundedNumber = (minimum, maximum) => (value) =>
  /^\d+$/u.test(value) &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) >= minimum &&
  Number(value) <= maximum
    ? null
    : `must be an integer from ${minimum} to ${maximum}`;
const text = (value) => (value.length <= 4096 ? null : 'is too long');
const nonempty = (value) => (value.trim() ? text(value) : 'must not be empty');
const secretPattern =
  /(?:API_KEY|_KEY$|_TOKEN$|PASSWORD|SECRET|CREDENTIAL|_USERNAME$|_JDBC_URL$)/iu;
const roles = [
  'Manager',
  'HazeOps',
  'WorkerShield',
  'EvidenceCritic',
  'DamageAccountant',
];
const profileName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const credentialName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

function httpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? null
      : 'must be an HTTP(S) URL without credentials, query, or fragment';
  } catch {
    return 'must be an absolute HTTP(S) URL';
  }
}

function jsonConfiguration(value, type) {
  if (!value) return null;
  try {
    if (Buffer.byteLength(value) > 65_536) return 'exceeds the 64 KiB limit';
    const configuration = JSON.parse(value);
    const field = type === 'models' ? 'profiles' : 'routes';
    if (
      !configuration ||
      Array.isArray(configuration) ||
      configuration.version !== 1 ||
      Object.keys(configuration).some(
        (key) => !['version', field].includes(key),
      ) ||
      !configuration[field] ||
      typeof configuration[field] !== 'object' ||
      Array.isArray(configuration[field])
    )
      return `must contain version: 1 and a ${field} object`;
    for (const [name, item] of Object.entries(configuration[field])) {
      if (type === 'agents') {
        if (
          !roles.includes(name) ||
          typeof item !== 'string' ||
          !profileName.test(item)
        )
          return 'contains an invalid role or profile mapping';
        continue;
      }
      if (
        !profileName.test(name) ||
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        Object.keys(item).some(
          (key) =>
            ![
              'provider',
              'model',
              'base_url',
              'credential_env',
              'policy',
            ].includes(key),
        ) ||
        !['nvidia', 'openai-compatible', 'nightshift'].includes(
          item.provider,
        ) ||
        typeof item.model !== 'string' ||
        !item.model.trim() ||
        item.model.length > 256 ||
        /[\u0000-\u001f]/u.test(item.model) ||
        (item.credential_env !== undefined &&
          (typeof item.credential_env !== 'string' ||
            !credentialName.test(item.credential_env))) ||
        (item.policy !== undefined &&
          !['provider-default', 'local-only'].includes(item.policy)) ||
        (item.base_url !== undefined &&
          (typeof item.base_url !== 'string' ||
            !item.base_url.length ||
            item.base_url.length > 2048 ||
            httpUrl(item.base_url)))
      )
        return 'contains an invalid model profile';
      if (item.provider === 'openai-compatible' && !item.base_url)
        return 'requires base_url for openai-compatible profiles';
      if (
        item.provider === 'nightshift' &&
        item.base_url &&
        !['localhost', '127.0.0.1', '[::1]'].includes(
          new URL(item.base_url).hostname,
        )
      )
        return 'requires a loopback URL for Nightshift profiles';
    }
    return null;
  } catch {
    return 'must contain valid versioned JSON';
  }
}

const settings = {
  STATE_DIR: { validate: nonempty, default: '.state/general-v2' },
  HAZE_TASK_STATE_DIR: { validate: nonempty },
  HAZE_TASK_PORT: { validate: boundedNumber(1, 65535), default: '8787' },
  HAZE_PROVIDER: {
    validate: choices(['offline', 'nvidia', 'openai-compatible', 'nightshift']),
    default: 'offline',
  },
  HAZE_MODEL: {
    validate: (value) =>
      value.length <= 256 ? null : 'exceeds 256 characters',
  },
  HAZE_PROVIDER_BASE_URL: { validate: httpUrl },
  HAZE_PROVIDER_API_KEY: { validate: text },
  NVIDIA_API_KEY: { validate: text },
  HAZE_MODEL_ROUTES_JSON: {
    validate: (value) => jsonConfiguration(value, 'models'),
  },
  HAZE_AGENT_ROUTES_JSON: {
    validate: (value) => jsonConfiguration(value, 'agents'),
  },
  HAZE_MANAGER_MAX_MODEL_CALLS: {
    validate: boundedNumber(1, 64),
    default: '6',
  },
  HAZE_MANAGER_MAX_RETRIEVALS: {
    validate: boundedNumber(0, 32),
    default: '4',
  },
  HAZE_MANAGER_TIMEOUT_MS: {
    validate: boundedNumber(1000, 1_800_000),
    default: '120000',
  },
  HAZE_MANAGER_MAX_OUTPUT_TOKENS: {
    validate: boundedNumber(1, 32_768),
    default: '2400',
  },
  HAZE_MANAGER_MAX_CORRECTIONS: {
    validate: boundedNumber(0, 8),
    default: '1',
  },
  HAZE_NIGHTSHIFT_CLI: { validate: text },
  HAZE_NIGHTSHIFT_MAX_JOBS: { validate: boundedNumber(1, 128), default: '2' },
  HAZE_NIGHTSHIFT_MAX_CHAINS: { validate: boundedNumber(1, 128), default: '8' },
  SAMPLE_MODE: {
    validate: choices(['true', 'false', '1', '0', '']),
    default: 'false',
  },
  HAZEOPS_COVERAGE: {
    validate: choices(['malaysia', 'asean', 'worldwide']),
    default: 'asean',
  },
  HAZEOPS_SCHEDULER: { validate: choices(['off', 'on', '']), default: 'on' },
  HAZEOPS_ZETARIS_QUERIES_FILE: { validate: text },
  HAZE_OPERATOR_TOKEN: { validate: text },
  ZETARIS_BASE_URL: { validate: httpUrl },
  ZETARIS_REST_URL: { validate: httpUrl },
  ZETARIS_JDBC_URL: {
    validate: (value) =>
      !value || value.startsWith('jdbc:zetaris:')
        ? null
        : 'must start with jdbc:zetaris:',
  },
  ZETARIS_JDBC_JAR: { validate: text },
  ZETARIS_ORG_ID: { validate: nonempty },
  ZETARIS_ENGINE_ID: { validate: text },
  ZETARIS_QUERY_LIMIT: {
    validate: boundedNumber(1, 1_000_000),
    default: '1000',
  },
  ZETARIS_API_KEY: { validate: text },
  ZETARIS_USERNAME: { validate: text },
  ZETARIS_PASSWORD: { validate: text },
  ZETARIS_USER_AGENT: { validate: text },
  FIRMS_MAP_KEY: { validate: text },
  WINDY_API_KEY: { validate: text },
  OPEN_AQ_KEY: { validate: text },
  DRIVER_IMAGE: { validate: nonempty },
  API_IMAGE: { validate: nonempty },
  UI_IMAGE: { validate: nonempty },
  POSTGRES_USER: { validate: nonempty },
  POSTGRES_PASSWORD: { validate: text },
  ZETARIS_ADMIN_EMAIL: {
    validate: (value) =>
      /^[^\s@]+@[^\s@]+$/u.test(value) ? null : 'must be an email address',
  },
  ZETARIS_ADMIN_PASSWORD: { validate: text },
  ZETARIS_ADMIN_ORG: { validate: nonempty },
  UI_PORT: { validate: boundedNumber(1, 65535), default: '3000' },
  API_PORT: { validate: boundedNumber(1, 65535), default: '8888' },
  API_INTERNAL_PORT: { validate: boundedNumber(1, 65535), default: '8889' },
  DRIVER_PORT: { validate: boundedNumber(1, 65535), default: '10000' },
  SPARK_UI_PORT: { validate: boundedNumber(1, 65535), default: '4040' },
  GUI_URL: { validate: httpUrl },
};

function readOptional(filename) {
  try {
    return readFileSync(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw new Error(
      `Cannot read configuration file ${filename}: ${error.code ?? 'I/O error'}.`,
    );
  }
}

// Keep each assignment's full span so an existing multiline value cannot leave
// stray lines behind when it is replaced. Unrelated bytes remain unchanged.
function assignments(content) {
  const lines = [...content.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/gu)].filter(
    (match) => match[0],
  );
  const records = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const assignment =
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)/u.exec(line[0]);
    if (!assignment) continue;
    const start = line.index;
    let end = start + line[0].length;
    let tail = assignment[2].replace(/[\r\n]+$/u, '');
    const quote = ['"', "'", '`'].includes(tail[0]) ? tail[0] : undefined;
    let unterminated = false;
    if (quote) {
      let closing = tail.indexOf(quote, 1);
      while (closing < 0 && index + 1 < lines.length) {
        const next = lines[++index];
        tail += next[0];
        end = next.index + next[0].length;
        closing = tail.indexOf(quote, 1);
      }
      unterminated = closing < 0;
      tail = closing >= 0 ? tail.slice(closing + 1) : '';
    }
    const comment = quote
      ? tail.match(/^\s*(#.*)/u)?.[1]
      : tail.match(/(#.*)/u)?.[1];
    records.push({ key: assignment[1], start, end, comment, unterminated });
  }
  return records;
}

function encodeValue(key, value) {
  for (const quote of ['"', "'", '`', '']) {
    if (quote && value.includes(quote)) continue;
    const encoded = `${quote}${value}${quote}`;
    if (parseEnv(`${key}=${encoded}`)[key] === value) return encoded;
  }
  throw new Error(
    `${key} cannot be represented safely in a Node .env file; remove conflicting quote characters.`,
  );
}

/** Inspect and save only supported server settings, without changing this run. */
export function createDevConfig({ root, env = process.env }) {
  const filename = join(root, '.env');
  const legacyFilename = join(root, 'app', 'adapters', 'zetaris', '.env.local');
  let snapshot;
  let secrets = [];
  let credentialKeys = new Set();

  function load() {
    const content = readOptional(filename);
    const rootValues = parseEnv(content);
    const layers = [
      {
        source: 'adapter .env.local',
        values: parseEnv(readOptional(legacyFilename)),
      },
      { source: '.env', values: rootValues },
      ...['.env.local', '.env.development', '.env.development.local'].map(
        (name) => ({
          source: name,
          values: parseEnv(readOptional(join(root, name))),
        }),
      ),
      {
        source: 'environment',
        values: Object.fromEntries(
          Object.entries(env).filter(([, value]) => typeof value === 'string'),
        ),
      },
    ];
    const effective = Object.assign(
      Object.create(null),
      ...layers.map((layer) => layer.values),
    );
    const sources = Object.assign(
      Object.create(null),
      ...layers.map((layer) =>
        Object.fromEntries(
          Object.keys(layer.values).map((key) => [key, layer.source]),
        ),
      ),
    );
    credentialKeys = new Set();
    try {
      const profiles =
        JSON.parse(effective.HAZE_MODEL_ROUTES_JSON || '{}').profiles || {};
      for (const profile of Object.values(profiles))
        if (profile && credentialName.test(profile.credential_env ?? ''))
          credentialKeys.add(profile.credential_env);
    } catch {
      /* Validation reports malformed route configuration. */
    }
    secrets = [
      ...new Set([
        ...secrets,
        ...layers.flatMap(({ values }) =>
          Object.entries(values)
            .filter(
              ([key, value]) =>
                (secretPattern.test(key) || credentialKeys.has(key)) &&
                typeof value === 'string' &&
                value.length,
            )
            .map(([, value]) => value),
        ),
      ]),
    ].sort((left, right) => right.length - left.length);
    snapshot = { content, effective, sources };
    return snapshot;
  }

  function redact(value) {
    let result = stripVTControlCharacters(String(value));
    for (const secret of secrets)
      result = result.split(secret).join('[redacted]');
    return result
      .replace(/(https?:\/\/)[^\s/@]+@/giu, '$1[redacted]@')
      .replace(/\b(Bearer\s+)[A-Za-z0-9_.~+\/-]+=*/giu, '$1[redacted]')
      .replace(
        /("[^"\r\n]*(?:api_key|token|password|secret)[^"\r\n]*"\s*:\s*)"(?:\\.|[^"\\])*"/giu,
        '$1"[redacted]"',
      );
  }

  function known(key) {
    if (!Object.hasOwn(settings, key) && !credentialKeys.has(key))
      throw new Error(
        `Unsupported setting ${JSON.stringify(key)}. Use config show for supported keys.`,
      );
    return Object.hasOwn(settings, key) ? settings[key] : { validate: text };
  }

  function validateValue(key, value) {
    const setting = known(key);
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value))
      return `${key} must be a single line without control characters`;
    const problem = setting.validate(value);
    return problem ? `${key} ${problem}` : null;
  }

  function valueLine(key) {
    const setting = known(key);
    const { effective, sources } = snapshot;
    const source =
      sources[key] ?? (setting.default !== undefined ? 'default' : 'unset');
    const value = effective[key] ?? setting.default;
    const displayed =
      value === undefined
        ? '(unset)'
        : value === ''
          ? '(empty)'
          : secretPattern.test(key) || credentialKeys.has(key)
            ? '[redacted]'
            : redact(JSON.stringify(value));
    return `${key} = ${displayed}  [${source}]`;
  }

  async function save(key, value) {
    const problem = validateValue(key, value);
    if (problem) throw new Error(problem);
    if (/(?<!\\)\$(?:[A-Za-z_]|\{)/u.test(value))
      throw new Error(
        `${key} contains environment interpolation syntax. Use a literal value without $NAME or \${NAME}; Node and Vite otherwise interpret it differently.`,
      );
    const encoded = encodeValue(key, value);
    const content = snapshot.content;
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    const records = assignments(content).filter((record) => record.key === key);
    if (records.some((record) => record.unterminated))
      throw new Error(
        `${key} has an unterminated quoted value in .env. Fix that value before using config set.`,
      );
    let result = content;
    for (const record of records.toReversed()) {
      const line = `${key}=${encoded}${record.comment ? ` ${record.comment}` : ''}${newline}`;
      result = result.slice(0, record.start) + line + result.slice(record.end);
    }
    if (!records.length)
      result += `${content && !/[\r\n]$/u.test(content) ? newline : ''}${key}=${encoded}${newline}`;
    let metadata;
    try {
      metadata = await lstat(filename);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (metadata?.isSymbolicLink())
      throw new Error(
        'config set requires a regular root .env file, not a symbolic link.',
      );
    const temporary = join(root, `.env.haze-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, result, {
        flag: 'wx',
        mode: metadata ? metadata.mode & 0o777 : 0o600,
      });
      let latest = '';
      try {
        latest = await readFile(filename, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (latest !== content)
        throw new Error(
          'The .env file changed during this command. Run config set again.',
        );
      await rename(temporary, filename);
    } finally {
      await rm(temporary, { force: true });
    }
    load();
    const override = snapshot.sources[key];
    return `Saved ${key} to .env. Restart the app to apply configuration.${/^(?:DRIVER_IMAGE|API_IMAGE|UI_IMAGE|POSTGRES_|ZETARIS_ADMIN_|UI_PORT|API_PORT|API_INTERNAL_PORT|DRIVER_PORT|SPARK_UI_PORT|GUI_URL)/u.test(key) ? '\nDocker deployment settings require restarting this project’s Docker services.' : ''}${override !== '.env' ? `\n${key} is overridden by ${override}. Update or remove that override before restarting.` : ''}\nExisting task routes remain pinned; new settings apply to new admissions.`;
  }

  async function execute(tokens) {
    load();
    const [, action, ...args] = tokens;
    if (!action || action === 'help')
      return [
        'Configuration commands:',
        '  config show                  Effective supported values and their sources',
        '  config get KEY               Inspect one setting (credentials are redacted)',
        '  config set KEY VALUE         Validate and save a root .env setting',
        '  config validate              Check effective configuration without network calls',
        'Start with config show, then config set HAZE_PROVIDER offline or config set HAZE_MODEL "your-model".',
        'Precedence: process environment > .env.development.local > .env.development > .env.local > .env > adapter .env.local > defaults.',
        'Changes require an app restart. Existing task routes remain pinned.',
      ].join('\n');
    if (action === 'show' && args.length === 0)
      return (
        [...Object.keys(settings), ...credentialKeys]
          .sort()
          .map(valueLine)
          .join('\n') +
        '\nPrecedence: process environment > Vite development files > root .env > adapter .env.local > defaults. Saved changes require restart.'
      );
    if (action === 'get' && args.length === 1) return valueLine(args[0]);
    if (action === 'set' && args.length === 2) return save(args[0], args[1]);
    if (action === 'validate' && args.length === 0) {
      const problems = [];
      const { effective } = snapshot;
      for (const key of [...Object.keys(settings), ...credentialKeys]) {
        if (effective[key] === undefined) continue;
        const problem = validateValue(key, effective[key]);
        if (problem) problems.push(problem);
      }
      if (
        !jsonConfiguration(effective.HAZE_MODEL_ROUTES_JSON || '', 'models') &&
        !jsonConfiguration(effective.HAZE_AGENT_ROUTES_JSON || '', 'agents')
      ) {
        const profiles = JSON.parse(
          effective.HAZE_MODEL_ROUTES_JSON || '{"profiles":{}}',
        ).profiles;
        const mappings = JSON.parse(
          effective.HAZE_AGENT_ROUTES_JSON || '{"routes":{}}',
        ).routes;
        for (const [role, profile] of Object.entries(mappings))
          if (!Object.hasOwn(profiles, profile))
            problems.push(`${role} references a missing model profile`);
      }
      if (
        effective.HAZE_PROVIDER === 'openai-compatible' &&
        !effective.HAZE_PROVIDER_BASE_URL
      )
        problems.push(
          'HAZE_PROVIDER_BASE_URL is required for openai-compatible',
        );
      if (
        ['openai-compatible', 'nightshift'].includes(effective.HAZE_PROVIDER) &&
        !effective.HAZE_MODEL
      )
        problems.push(`HAZE_MODEL is required for ${effective.HAZE_PROVIDER}`);
      if (
        effective.HAZE_PROVIDER === 'nightshift' &&
        effective.HAZE_PROVIDER_BASE_URL &&
        !httpUrl(effective.HAZE_PROVIDER_BASE_URL) &&
        !['localhost', '127.0.0.1', '[::1]'].includes(
          new URL(effective.HAZE_PROVIDER_BASE_URL).hostname,
        )
      )
        problems.push(
          'HAZE_PROVIDER_BASE_URL must use loopback for Nightshift',
        );
      return problems.length
        ? `Configuration needs attention:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`
        : 'Configuration syntax is valid. This offline check does not verify credentials, model readiness, or source access.';
    }
    throw new Error('Usage: config [show|get KEY|set KEY VALUE|validate]');
  }

  load();
  return {
    execute,
    get keys() {
      return [...Object.keys(settings), ...credentialKeys].sort();
    },
    redact,
  };
}
