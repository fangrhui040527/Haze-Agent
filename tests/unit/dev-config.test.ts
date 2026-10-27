import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

interface Configuration {
  keys: string[];
  execute(tokens: string[]): Promise<string>;
  redact(value: string): string;
}

const { createDevConfig } = (await import(
  new URL('../../scripts/dev-config.mjs', import.meta.url).href
)) as {
  createDevConfig: (options: {
    root: string;
    env?: NodeJS.ProcessEnv;
  }) => Configuration;
};
const directories: string[] = [];

async function workspace(content = '', env: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), 'haze-dev-config-'));
  directories.push(root);
  await writeFile(join(root, '.env'), content);
  return { root, configuration: createDevConfig({ root, env }) };
}

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe('development console configuration', () => {
  it('redacts secrets before startup, including overridden credentials and URL userinfo', async () => {
    const { root } = await workspace('NVIDIA_API_KEY=root-secret-value\n');
    await writeFile(
      join(root, '.env.local'),
      'HAZE_PROVIDER_API_KEY=local-secret-value\n',
    );
    const configuration = createDevConfig({
      root,
      env: { NVIDIA_API_KEY: 'process-secret-value' },
    });
    const logs = configuration.redact(
      'root-secret-value local-secret-value process-secret-value https://user:password@example.com/path Authorization: Bearer token-value',
    );
    expect(logs).not.toMatch(
      /root-secret|local-secret|process-secret|user:password|token-value/,
    );
    const result = await configuration.execute(['config', 'show']);
    expect(result).toContain('NVIDIA_API_KEY = [redacted]  [environment]');
    expect(result).toContain(
      'HAZE_PROVIDER_API_KEY = [redacted]  [.env.local]',
    );
    expect(result).not.toContain('secret-value');
  });

  it('reports the same development file precedence as Vite, including explicit empties', async () => {
    const { root } = await workspace(
      'HAZE_MODEL=root-model\nZETARIS_API_KEY=\n',
    );
    const adapter = join(root, 'app', 'adapters', 'zetaris');
    await mkdir(adapter, { recursive: true });
    await writeFile(
      join(adapter, '.env.local'),
      'HAZE_MODEL=legacy-model\nZETARIS_API_KEY=legacy-secret\n',
    );
    await writeFile(join(root, '.env.local'), 'HAZE_MODEL=local-model\n');
    await writeFile(
      join(root, '.env.development'),
      'HAZE_MODEL=development-model\n',
    );
    await writeFile(
      join(root, '.env.development.local'),
      'HAZE_MODEL=development-local-model\n',
    );
    const configuration = createDevConfig({ root, env: {} });
    expect(
      await configuration.execute(['config', 'get', 'HAZE_MODEL']),
    ).toContain('"development-local-model"  [.env.development.local]');
    expect(
      await configuration.execute(['config', 'get', 'ZETARIS_API_KEY']),
    ).toContain('(empty)  [.env]');
  });

  it('updates duplicate assignments while preserving unrelated bytes and comments', async () => {
    const original =
      '# keep this comment\r\nUNRELATED="one\r\ntwo" # retain inline\r\nHAZE_MODEL=old # selected model\r\nexport HAZE_MODEL=shadowed\r\nTAIL=value\r\n';
    const { root, configuration } = await workspace(original);
    const message = await configuration.execute([
      'config',
      'set',
      'HAZE_MODEL',
      'new-model',
    ]);
    const result = await readFile(join(root, '.env'), 'utf8');
    expect(result).toContain(
      '# keep this comment\r\nUNRELATED="one\r\ntwo" # retain inline\r\n',
    );
    expect(result).toContain('HAZE_MODEL="new-model" # selected model\r\n');
    expect(result).toContain('TAIL=value\r\n');
    expect(parseEnv(result).HAZE_MODEL).toBe('new-model');
    expect(result).not.toMatch(/old|shadowed/);
    expect(message).toContain('Restart the app');
    expect(await readdir(root)).toEqual(['.env']);
  });

  it('does not change the running environment or expose a newly saved credential', async () => {
    const env = { NVIDIA_API_KEY: 'running-secret' };
    const { root, configuration } = await workspace('', env);
    const message = await configuration.execute([
      'config',
      'set',
      'NVIDIA_API_KEY',
      'new-secret-value',
    ]);
    expect(env.NVIDIA_API_KEY).toBe('running-secret');
    expect(
      parseEnv(await readFile(join(root, '.env'), 'utf8')).NVIDIA_API_KEY,
    ).toBe('new-secret-value');
    expect(message).toContain('overridden by environment');
    expect(message).not.toContain('new-secret-value');
    expect(configuration.redact('running-secret new-secret-value')).toBe(
      '[redacted] [redacted]',
    );
  });

  it('warns when a development-specific file overrides a saved setting', async () => {
    const { root, configuration } = await workspace('');
    await writeFile(
      join(root, '.env.development.local'),
      'HAZE_MODEL=override-model\n',
    );
    expect(
      await configuration.execute([
        'config',
        'set',
        'HAZE_MODEL',
        'saved-model',
      ]),
    ).toContain('overridden by .env.development.local');
    expect(
      await configuration.execute(['config', 'get', 'HAZE_MODEL']),
    ).toContain('override-model');
  });

  it('round-trips JSON and literal punctuation through Node dotenv without shell expansion', async () => {
    const { root, configuration } = await workspace('');
    const value = JSON.stringify({
      version: 1,
      profiles: { local: { provider: 'nightshift', model: 'model-name' } },
    });
    await configuration.execute([
      'config',
      'set',
      'HAZE_MODEL_ROUTES_JSON',
      value,
    ]);
    await configuration.execute([
      'config',
      'set',
      'NVIDIA_API_KEY',
      'literal $0 $(command) # apostrophe\' quote"',
    ]);
    const values = parseEnv(await readFile(join(root, '.env'), 'utf8'));
    expect(values.HAZE_MODEL_ROUTES_JSON).toBe(value);
    expect(values.NVIDIA_API_KEY).toBe(
      'literal $0 $(command) # apostrophe\' quote"',
    );
  });

  it.each([
    ['PATH', 'new-path', 'Unsupported setting'],
    ['HAZE_TASK_PORT', '0', 'integer from 1 to 65535'],
    ['HAZEOPS_COVERAGE', 'moon', 'must be one of'],
    ['HAZE_PROVIDER', 'unknown-provider', 'must be one of'],
    ['HAZE_MODEL', 'bad\nINJECTED=true', 'single line'],
    ['HAZE_MODEL', 'bad\u001b[2J', 'control characters'],
    ['NVIDIA_API_KEY', '$HOME', 'interpolation syntax'],
    [
      'HAZE_PROVIDER_BASE_URL',
      'https://user:password@example.com',
      'without credentials',
    ],
    ['HAZE_MODEL_ROUTES_JSON', '{"version":2,"profiles":{}}', 'version: 1'],
  ])(
    'rejects invalid %s before writing anything',
    async (key, value, expected) => {
      const initial = 'KEEP=untouched\n';
      const { root, configuration } = await workspace(initial);
      await expect(
        configuration.execute(['config', 'set', key, value]),
      ).rejects.toThrow(expected);
      expect(await readFile(join(root, '.env'), 'utf8')).toBe(initial);
    },
  );

  it('validates model-route references and supports credentials explicitly named by profiles', async () => {
    const profiles = JSON.stringify({
      version: 1,
      profiles: {
        specialist: {
          provider: 'openai-compatible',
          model: 'test-model',
          base_url: 'https://example.com/v1',
          credential_env: 'SPECIALIST_ACCESS',
        },
      },
    });
    const mappings = JSON.stringify({
      version: 1,
      routes: { Manager: 'missing' },
    });
    const { root, configuration } = await workspace(
      `HAZE_MODEL_ROUTES_JSON='${profiles}'\nHAZE_AGENT_ROUTES_JSON='${mappings}'\n`,
    );
    expect(configuration.keys).toContain('SPECIALIST_ACCESS');
    await configuration.execute([
      'config',
      'set',
      'SPECIALIST_ACCESS',
      'named-secret',
    ]);
    expect(
      await configuration.execute(['config', 'get', 'SPECIALIST_ACCESS']),
    ).toContain('[redacted]');
    expect(configuration.redact('named-secret')).toBe('[redacted]');
    expect(await configuration.execute(['config', 'validate'])).toContain(
      'Manager references a missing model profile',
    );
    expect(
      parseEnv(await readFile(join(root, '.env'), 'utf8')).SPECIALIST_ACCESS,
    ).toBe('named-secret');
  });

  it('safely replaces an existing multiline target value', async () => {
    const { root, configuration } = await workspace(
      'HAZE_MODEL="first\nsecond" # explanation\nKEEP=untouched\n',
    );
    await configuration.execute(['config', 'set', 'HAZE_MODEL', 'replacement']);
    expect(await readFile(join(root, '.env'), 'utf8')).toBe(
      'HAZE_MODEL="replacement" # explanation\nKEEP=untouched\n',
    );
  });

  it('does not discard following lines when the target has an unterminated quote', async () => {
    const initial = 'HAZE_MODEL="broken\nKEEP=untouched\n';
    const { root, configuration } = await workspace(initial);
    await expect(
      configuration.execute(['config', 'set', 'HAZE_MODEL', 'replacement']),
    ).rejects.toThrow('unterminated');
    expect(await readFile(join(root, '.env'), 'utf8')).toBe(initial);
  });

  it('provides a bounded offline validation result without claiming live readiness', async () => {
    const { configuration } = await workspace(
      'HAZE_PROVIDER=offline\nHAZE_NIGHTSHIFT_MAX_JOBS=128\n',
    );
    expect(await configuration.execute(['config', 'validate'])).toContain(
      'does not verify credentials, model readiness, or source access',
    );
    expect(await configuration.execute(['config'])).toContain(
      'config set KEY VALUE',
    );
  });
});
