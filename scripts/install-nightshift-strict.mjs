import { createHash, randomUUID } from 'node:crypto';
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  unlink,
  stat,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = 'haze-strict-backup-v1';
const MANIFEST = 'haze-strict-installation.json';
export const ORIGINAL_HASHES = Object.freeze({
  'host.mjs':
    'ab9e35a78b6545780c904a1d7bc3d6e576598edf5e3e063aebc0c4d2d3e5ce00',
  'server.mjs':
    'c0866047e8a2df96d17a2b25d04929f3830b4d98a76cd0eab87328df1478ca06',
  'js/engine/providers.js':
    '04fae12dfdeb4299ee2a36016b437de7bf5120006393d0c8c1d88ac75f288825',
  'js/engine/models.js':
    '98d276d1871a2338873afca05d747cf847f558be37614539a3597f39576153e4',
  'js/engine/select.js':
    '9121bcbe9c3c8e8b02ddd24299888c46a6d577d7c099489c7d65d975fafea775',
  'js/engine/orchestrator.js':
    '2c7cee5e79737922f28b317f03f4fde4f7a33f473f11e7576b2c73d5de058cce',
  'js/engine/redact.js':
    '6c38e3964f6e1c21f26b13d40dfc072fd357df15f90a3b2b2dbbb4b1f4319b21',
});

const SERVER_ROUTE = `    // HAZE_STRICT_V1: authenticated, policy-checked, single provider call.
    if ((req.method === 'GET' && url.pathname === '/v1/haze/contract') ||
        (req.method === 'POST' && url.pathname === '/v1/haze/chat/completions')) {
      if (typeof engine.hazeStrict !== 'function') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'strict_runtime_unavailable' } }));
        return;
      }
      if (inflight >= MAX_INFLIGHT) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'engine_saturated' } }));
        return;
      }
      inflight++;
      const abort = new AbortController();
      const disconnected = () => { if (!res.writableEnded) abort.abort(); };
      res.on('close', disconnected);
      try {
        let body;
        if (req.method === 'POST') {
          try {
            const raw = await readBodyCapped(req, 131072);
            body = JSON.parse(raw.toString('utf8'));
          } catch (error) {
            if (!res.destroyed) {
              res.writeHead(error?.status === 413 ? 413 : 400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: { code: 'strict_request_invalid' } }));
            }
            return;
          }
        }
        const result = await engine.hazeStrict({
          method: req.method, path: url.pathname, model: url.searchParams.get('model'),
          body, headers: req.headers, signal: abort.signal,
        });
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(result.status, result.headers);
          res.end(JSON.stringify(result.body));
        }
      } catch {
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'strict_runtime_failed' } }));
        }
      } finally {
        res.removeListener('close', disconnected);
        inflight--;
      }
      return;
    }

`;

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2)
    throw new Error(
      'Unsupported Nightshift integration seam; nothing was installed.',
    );
  return source.replace(before, after);
}

export function patchHost(source) {
  if (source.includes('// HAZE_STRICT_V1: facade')) return source;
  source = replaceOnce(
    source,
    "import { makeOpenAIEngine } from './openai.mjs';",
    "import { makeOpenAIEngine } from './openai.mjs';\nimport { makeHazeStrictFacade } from './haze-strict/integration.mjs';",
  );
  return replaceOnce(
    source,
    '  return {\n    ready: engineReady,',
    '  // HAZE_STRICT_V1: facade\n  const hazeStrict = makeHazeStrictFacade({ RT });\n  return {\n    ready: engineReady,\n    hazeStrict,',
  );
}

export function patchServer(source) {
  if (source.includes('// HAZE_STRICT_V1: authenticated')) return source;
  const seam =
    '    if (await handleDataRoute({ req, res, url, stateDir, hostBridge, readBodyCapped })) return;';
  return replaceOnce(source, seam, SERVER_ROUTE + seam);
}

async function readOptional(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWrite(path, bytes) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/**
 * Hash-pinned overlay for one inspected Nightshift build. The CLI exposes no
 * force/skip-verification switch and never restarts an active runtime.
 */
export async function installStrictEndpoint({
  engineDir,
  checkOnly = false,
  restore = false,
  moduleDir = join(HERE, 'nightshift-strict'),
}) {
  engineDir = resolve(engineDir);
  const previousBytes = await readOptional(join(engineDir, MANIFEST));
  const previous = previousBytes
    ? JSON.parse(previousBytes.toString('utf8'))
    : null;
  if (previous && previous.version !== 1)
    throw new Error('Unsupported existing strict integration manifest.');
  const current = new Map();
  const originals = new Map();
  // Validate every dependency and original backup before creating any files.
  for (const [name, expected] of Object.entries(ORIGINAL_HASHES)) {
    const bytes = await readFile(join(engineDir, name));
    current.set(name, bytes);
    if (previous) {
      if (hash(bytes) !== previous.installed[name])
        throw new Error(`Nightshift file changed since installation: ${name}.`);
      const backup = await readFile(join(engineDir, BACKUP_DIR, name));
      if (hash(backup) !== expected)
        throw new Error(`Original Nightshift backup is invalid: ${name}.`);
      originals.set(name, backup);
    } else {
      if (hash(bytes) !== expected)
        throw new Error(
          `Unsupported Nightshift build: ${name}. No files changed.`,
        );
      const backup = await readOptional(join(engineDir, BACKUP_DIR, name));
      if (backup && !backup.equals(bytes))
        throw new Error(`Conflicting Nightshift backup: ${name}.`);
      originals.set(name, bytes);
    }
  }
  if (restore && !previous)
    throw new Error('No verified strict integration is installed.');
  const updates = new Map();
  if (restore) {
    updates.set('host.mjs', originals.get('host.mjs'));
    updates.set('server.mjs', originals.get('server.mjs'));
  } else {
    for (const name of ['handler.mjs', 'integration.mjs']) {
      const target = `haze-strict/${name}`;
      const existing = await readOptional(join(engineDir, target));
      const moduleBytes = await readFile(join(moduleDir, name));
      if (
        existing &&
        (previous
          ? hash(existing) !== previous.installed[target]
          : !existing.equals(moduleBytes))
      )
        throw new Error(
          `Existing strict integration file was modified: ${target}.`,
        );
      current.set(target, existing);
      updates.set(target, moduleBytes);
    }
    updates.set(
      'host.mjs',
      Buffer.from(patchHost(originals.get('host.mjs').toString('utf8'))),
    );
    updates.set(
      'server.mjs',
      Buffer.from(patchServer(originals.get('server.mjs').toString('utf8'))),
    );
  }
  const installed = Object.fromEntries(
    [...originals].map(([name, bytes]) => [
      name,
      hash(updates.get(name) ?? bytes),
    ]),
  );
  for (const [name, bytes] of updates) installed[name] = hash(bytes);
  const changed = [...updates].filter(
    ([name, bytes]) => !current.get(name)?.equals(bytes),
  );
  const result = {
    version: 1,
    operation: restore ? 'restore' : 'install',
    check_only: checkOnly,
    changed_files: changed.map(([name]) => name),
    original: ORIGINAL_HASHES,
    installed,
    restart_required:
      changed.length !== 0 || previous?.restart_required === true,
  };
  if (checkOnly) return result;
  if (!previous) {
    for (const [name, bytes] of originals) {
      const backup = join(engineDir, BACKUP_DIR, name);
      await mkdir(dirname(backup), { recursive: true });
      const existing = await readOptional(backup);
      if (existing && !existing.equals(bytes))
        throw new Error(`Conflicting Nightshift backup: ${name}.`);
      if (!existing) await writeFile(backup, bytes, { flag: 'wx' });
    }
  }
  await mkdir(join(engineDir, 'haze-strict'), { recursive: true });
  const written = [];
  try {
    // Modules land first; only then may a new host import them. The running
    // process stays on its existing modules until a separate controlled reload.
    for (const [name, bytes] of changed) {
      await atomicWrite(join(engineDir, name), bytes);
      written.push(name);
    }
    if (restore) await unlink(join(engineDir, MANIFEST));
    else
      await atomicWrite(
        join(engineDir, MANIFEST),
        JSON.stringify(result, null, 2) + '\n',
      );
  } catch (error) {
    for (const name of written.reverse()) {
      const bytes = current.get(name);
      if (bytes) await atomicWrite(join(engineDir, name), bytes);
      else await unlink(join(engineDir, name));
    }
    throw error;
  }
  return result;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      engine: { type: 'string' },
      check: { type: 'boolean', default: false },
      restore: { type: 'boolean', default: false },
    },
  });
  const defaultEngine = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Nightshift', 'engine')
    : null;
  const engineDir = values.engine || defaultEngine;
  if (!engineDir || !(await stat(engineDir)).isDirectory())
    throw new Error(
      'Specify the inspected Nightshift engine directory with --engine.',
    );
  console.log(
    JSON.stringify(
      await installStrictEndpoint({
        engineDir,
        checkOnly: values.check,
        restore: values.restore,
      }),
      null,
      2,
    ),
  );
}
