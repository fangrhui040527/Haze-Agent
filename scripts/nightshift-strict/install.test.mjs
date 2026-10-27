import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import {
  installStrictEndpoint,
  patchHost,
  patchServer,
  ORIGINAL_HASHES,
} from '../install-nightshift-strict.mjs';
import { STRICT_CONTRACT } from './handler.mjs';

const execute = promisify(execFile);
const BACKUP = 'haze-strict-backup-v1';
const MANIFEST = 'haze-strict-installation.json';
const HOST_IMPORT = "import { makeOpenAIEngine } from './openai.mjs';";
const HOST_RETURN = '  return {\n    ready: engineReady,';
const SERVER_SEAM =
  '    if (await handleDataRoute({ req, res, url, stateDir, hostBridge, readBodyCapped })) return;';
const hostFixture = `${HOST_IMPORT}\nexport function fixture() {\n${HOST_RETURN}\n  };\n}\n`;
const serverFixture = `async function handle() {\n    if (!authorized) return unauthorized();\n${SERVER_SEAM}\n    return ordinaryRoutes();\n}\n`;
const MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const SYNTHETIC_TOKEN = 'synthetic-test-only-proxy-token';

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'haze-strict-install-test-'));
  t.after(async () => {
    const absolute = resolve(directory);
    assert.ok(absolute.startsWith(resolve(tmpdir()) + sep));
    assert.match(
      absolute.slice(absolute.lastIndexOf(sep) + 1),
      /^haze-strict-install-test-/u,
    );
    await rm(absolute, { recursive: true, force: true });
  });
  return directory;
}

async function writeSources(directory, sources) {
  for (const [name, bytes] of sources) {
    const file = join(directory, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
}

async function snapshot(directory, prefix = '') {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) {
      Object.assign(
        files,
        await snapshot(join(directory, entry.name), name + '/'),
      );
    } else {
      files[name] = hash(await readFile(join(directory, entry.name)));
    }
  }
  return files;
}

async function installedOriginalSources() {
  const engineDir =
    process.env.NIGHTSHIFT_TEST_ENGINE_DIR ||
    (process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Nightshift', 'engine')
      : null);
  if (!engineDir) return null;
  const sources = new Map();
  for (const [name, expected] of Object.entries(ORIGINAL_HASHES)) {
    let original;
    for (const file of [join(engineDir, name), join(engineDir, BACKUP, name)]) {
      try {
        const bytes = await readFile(file);
        if (hash(bytes) === expected) {
          original = bytes;
          break;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (!original) return null;
    sources.set(name, original);
  }
  return sources;
}

async function installedServer(t, hazeStrict) {
  const engineDir =
    process.env.NIGHTSHIFT_TEST_ENGINE_DIR ||
    (process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Nightshift', 'engine')
      : null);
  if (!engineDir) {
    t.skip(
      'Installed Nightshift server unavailable for isolated HTTP smoke test.',
    );
    return null;
  }
  const serverFile = join(engineDir, 'server.mjs');
  let source;
  try {
    source = await readFile(serverFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!source?.includes('// HAZE_STRICT_V1: authenticated')) {
    t.skip(
      'Installed Nightshift server does not have the strict route overlay.',
    );
    return null;
  }
  const { startServer } = await import(pathToFileURL(serverFile).href);
  const stateDir = await temporaryDirectory(t);
  await writeFile(join(stateDir, 'proxy-token'), SYNTHETIC_TOKEN + '\n');
  const server = startServer({
    listen: '127.0.0.1:0',
    stateDir,
    hostBridge: {},
    log: () => {},
    engine: {
      hazeStrict,
      execute: () => {
        throw new Error('Strict request entered legacy execution.');
      },
    },
  });
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function pinnedFixture(t) {
  const sources = await installedOriginalSources();
  if (!sources) {
    t.skip(
      'Pinned Nightshift source fixture unavailable; set NIGHTSHIFT_TEST_ENGINE_DIR to run installation integration checks.',
    );
    return null;
  }
  const directory = await temporaryDirectory(t);
  await writeSources(directory, sources);
  return { directory, sources };
}

test('host patch adds one strict facade and is idempotent', () => {
  const patched = patchHost(hostFixture);
  assert.match(
    patched,
    /import \{ makeHazeStrictFacade \} from '\.\/haze-strict\/integration\.mjs';/u,
  );
  assert.match(
    patched,
    /const hazeStrict = makeHazeStrictFacade\(\{ RT \}\);/u,
  );
  assert.match(patched, /ready: engineReady,\n    hazeStrict,/u);
  assert.equal(patchHost(patched), patched);
});

test('host patch rejects absent and ambiguous integration seams', () => {
  for (const source of [
    hostFixture.replace(HOST_IMPORT, ''),
    hostFixture.replace(HOST_RETURN, ''),
    HOST_IMPORT + '\n' + hostFixture,
    hostFixture + '\n' + HOST_RETURN,
  ]) {
    assert.throws(
      () => patchHost(source),
      /Unsupported Nightshift integration seam/u,
    );
  }
});

test('server patch stays after authentication and before ordinary routes', () => {
  const patched = patchServer(serverFixture);
  assert.ok(
    patched.indexOf('if (!authorized)') <
      patched.indexOf('// HAZE_STRICT_V1: authenticated'),
  );
  assert.ok(
    patched.indexOf('// HAZE_STRICT_V1: authenticated') <
      patched.indexOf(SERVER_SEAM),
  );
  assert.match(
    patched,
    /req\.method === 'GET' && url\.pathname === '\/v1\/haze\/contract'/u,
  );
  assert.match(
    patched,
    /req\.method === 'POST' && url\.pathname === '\/v1\/haze\/chat\/completions'/u,
  );
  assert.equal(patchServer(patched), patched);
  assert.throws(
    () => patchServer('no integration seam'),
    /Unsupported Nightshift integration seam/u,
  );
  assert.throws(
    () => patchServer(serverFixture + SERVER_SEAM),
    /Unsupported Nightshift integration seam/u,
  );
});

test('unknown builds fail without changing any source or creating backup files', async (t) => {
  const directory = await temporaryDirectory(t);
  await writeSources(
    directory,
    new Map(
      Object.keys(ORIGINAL_HASHES).map((name) => [
        name,
        Buffer.from(`unknown vendor build: ${name}\n`),
      ]),
    ),
  );
  const before = await snapshot(directory);
  for (const checkOnly of [false, true]) {
    await assert.rejects(
      installStrictEndpoint({ engineDir: directory, checkOnly }),
      /Unsupported Nightshift build/u,
    );
    assert.deepEqual(await snapshot(directory), before);
  }
});

test('unsupported manifests are refused without writes', async (t) => {
  const directory = await temporaryDirectory(t);
  await writeFile(join(directory, MANIFEST), JSON.stringify({ version: 999 }));
  const before = await snapshot(directory);
  await assert.rejects(
    installStrictEndpoint({ engineDir: directory }),
    /Unsupported existing strict integration manifest/u,
  );
  assert.deepEqual(await snapshot(directory), before);
});

test('pinned install check, install, repeat install and restore preserve byte-exact originals', async (t) => {
  const fixture = await pinnedFixture(t);
  if (!fixture) return;
  const { directory, sources } = fixture;
  const before = await snapshot(directory);
  const inspection = await installStrictEndpoint({
    engineDir: directory,
    checkOnly: true,
  });
  assert.equal(inspection.check_only, true);
  assert.equal(inspection.restart_required, true);
  assert.deepEqual(await snapshot(directory), before);

  const installed = await installStrictEndpoint({ engineDir: directory });
  assert.equal(installed.operation, 'install');
  assert.deepEqual(
    new Set(installed.changed_files),
    new Set([
      'host.mjs',
      'server.mjs',
      'haze-strict/handler.mjs',
      'haze-strict/integration.mjs',
    ]),
  );
  assert.equal(installed.restart_required, true);
  for (const [name, bytes] of sources) {
    assert.deepEqual(await readFile(join(directory, BACKUP, name)), bytes);
  }
  const patchedServer = await readFile(join(directory, 'server.mjs'), 'utf8');
  assert.ok(
    patchedServer.indexOf('const token = tokens.current();') <
      patchedServer.indexOf('// HAZE_STRICT_V1: authenticated'),
  );
  for (const name of ['host.mjs', 'server.mjs']) {
    await execute(process.execPath, ['--check', join(directory, name)]);
  }
  const repeated = await installStrictEndpoint({ engineDir: directory });
  assert.deepEqual(repeated.changed_files, []);
  assert.equal(repeated.restart_required, true);

  const restored = await installStrictEndpoint({
    engineDir: directory,
    restore: true,
  });
  assert.equal(restored.operation, 'restore');
  for (const [name, bytes] of sources) {
    assert.deepEqual(await readFile(join(directory, name)), bytes);
  }
  await assert.rejects(readFile(join(directory, MANIFEST)), { code: 'ENOENT' });

  const reinstalled = await installStrictEndpoint({ engineDir: directory });
  assert.equal(reinstalled.operation, 'install');
  assert.equal(reinstalled.restart_required, true);
});

test('pinned installer refuses a missing overlay module before creating backups', async (t) => {
  const fixture = await pinnedFixture(t);
  if (!fixture) return;
  const { directory } = fixture;
  const moduleDir = await temporaryDirectory(t);
  const before = await snapshot(directory);
  await assert.rejects(
    installStrictEndpoint({ engineDir: directory, moduleDir }),
    { code: 'ENOENT' },
  );
  assert.deepEqual(await snapshot(directory), before);
});

test('pinned installer rejects conflicting existing backups during dry-run preflight without writes', async (t) => {
  const fixture = await pinnedFixture(t);
  if (!fixture) return;
  const { directory } = fixture;
  const backup = join(directory, BACKUP, 'server.mjs');
  await mkdir(dirname(backup), { recursive: true });
  await writeFile(backup, 'operator-owned conflicting backup\n');
  const before = await snapshot(directory);
  for (const checkOnly of [true, false]) {
    await assert.rejects(
      installStrictEndpoint({ engineDir: directory, checkOnly }),
      /Conflicting Nightshift backup/u,
    );
    assert.deepEqual(await snapshot(directory), before);
  }
});

test('pinned installer refuses changed installed sources and changed backups without writes', async (t) => {
  for (const name of [
    'host.mjs',
    'haze-strict/handler.mjs',
    `${BACKUP}/server.mjs`,
  ]) {
    const fixture = await pinnedFixture(t);
    if (!fixture) return;
    const { directory } = fixture;
    await installStrictEndpoint({ engineDir: directory });
    const file = join(directory, name);
    await writeFile(
      file,
      Buffer.concat([
        await readFile(file),
        Buffer.from('\n// changed by operator\n'),
      ]),
    );
    const before = await snapshot(directory);
    await assert.rejects(
      installStrictEndpoint({ engineDir: directory }),
      /changed|modified|invalid/u,
    );
    assert.deepEqual(await snapshot(directory), before);
  }
});

test('restore preserves operator-modified overlay files and reinstall refuses to overwrite them', async (t) => {
  const fixture = await pinnedFixture(t);
  if (!fixture) return;
  const { directory } = fixture;
  await installStrictEndpoint({ engineDir: directory });
  const overlay = join(directory, 'haze-strict/handler.mjs');
  const modified = Buffer.concat([
    await readFile(overlay),
    Buffer.from('\n// operator-owned change\n'),
  ]);
  await writeFile(overlay, modified);
  await installStrictEndpoint({ engineDir: directory, restore: true });
  assert.deepEqual(await readFile(overlay), modified);
  const before = await snapshot(directory);
  await assert.rejects(
    installStrictEndpoint({ engineDir: directory }),
    /modified/u,
  );
  assert.deepEqual(await snapshot(directory), before);
});

test('installed server authenticates strict routes and rejects malformed or oversized bodies before execution', async (t) => {
  const calls = [];
  const fixture = await installedServer(t, async (input) => {
    calls.push(input);
    return {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-haze-nightshift-contract': STRICT_CONTRACT.id,
      },
      body:
        input.method === 'GET'
          ? { ...STRICT_CONTRACT, models: [input.model] }
          : { synthetic: true },
    };
  });
  if (!fixture) return;
  const contractUrl = `${fixture.baseUrl}/v1/haze/contract?model=${encodeURIComponent(MODEL)}`;
  const completionUrl = `${fixture.baseUrl}/v1/haze/chat/completions`;
  for (const authorization of [undefined, 'Bearer incorrect-token']) {
    const headers = authorization ? { authorization } : {};
    assert.equal((await fetch(contractUrl, { headers })).status, 401);
    assert.equal(
      (
        await fetch(completionUrl, {
          method: 'POST',
          headers,
          body: '{}',
        })
      ).status,
      401,
    );
  }
  assert.equal(calls.length, 0);

  const headers = { authorization: `Bearer ${SYNTHETIC_TOKEN}` };
  const response = await fetch(contractUrl, { headers });
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('x-haze-nightshift-contract'),
    STRICT_CONTRACT.id,
  );
  assert.deepEqual(await response.json(), {
    ...STRICT_CONTRACT,
    models: [MODEL],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, MODEL);
  assert.equal(calls[0].path, '/v1/haze/contract');

  const malformed = await fetch(completionUrl, {
    method: 'POST',
    headers,
    body: '{invalid json',
  });
  assert.equal(malformed.status, 400);
  assert.equal(calls.length, 1);
  await assert.rejects(
    fetch(completionUrl, {
      method: 'POST',
      headers,
      body: 'x'.repeat(131_073),
    }),
  );
  assert.equal(calls.length, 1);

  const body = { model: MODEL, messages: [{ role: 'user', content: 'test' }] };
  const valid = await fetch(completionUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { synthetic: true });
  assert.deepEqual(calls[1].body, body);
  assert.equal(calls[1].signal.aborted, false);
});

test('installed strict server propagates client disconnect into the engine cancellation signal', async (t) => {
  let entered;
  let cancelled;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const aborted = new Promise((resolve) => {
    cancelled = resolve;
  });
  const fixture = await installedServer(t, (input) => {
    entered();
    return new Promise((resolve) => {
      input.signal.addEventListener(
        'abort',
        () => {
          cancelled();
          resolve({ status: 499, headers: {}, body: {} });
        },
        { once: true },
      );
    });
  });
  if (!fixture) return;
  const controller = new AbortController();
  const pending = fetch(`${fixture.baseUrl}/v1/haze/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SYNTHETIC_TOKEN}` },
    body: '{}',
    signal: controller.signal,
  });
  await started;
  controller.abort();
  await assert.rejects(pending);
  let deadline;
  try {
    await Promise.race([
      aborted,
      new Promise((_resolve, reject) => {
        deadline = setTimeout(
          () =>
            reject(
              new Error(
                'Server did not cancel the disconnected strict request.',
              ),
            ),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
});
