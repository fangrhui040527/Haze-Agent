#!/usr/bin/env node
// Haze Agent <-> TestRail CLI.
//
//   node qa/testrail/cli.mjs status  [--project N] [--suite N] [--dry-run]
//   node qa/testrail/cli.mjs import  --project N [--suite N] [--dry-run]
//   node qa/testrail/cli.mjs run     --project N [--suite N] [--name "..."] [--dry-run]
//   node qa/testrail/cli.mjs push    --run N [--dry-run]
//
// --dry-run performs no writes and needs NO credentials: it resolves the local
// catalogue, maps every result and prints exactly what would be sent.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  TestRailClient,
  readCredentials,
  STATUS,
  TestRailError,
} from './client.mjs';
import { buildCatalogue, bySection, loadArtifacts } from './cases.mjs';
import { collectArtifactResults, collectVitestResults } from './collect.mjs';

const MAP_PATH = 'qa/testrail/case-map.json';
const STATUS_NAME = Object.fromEntries(
  Object.entries(STATUS).map(([k, v]) => [v, k]),
);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i += 1;
      }
    } else out._.push(a);
  }
  return out;
}

const log = (s = '') => process.stdout.write(`${s}\n`);

const loadMap = () =>
  existsSync(MAP_PATH) ? JSON.parse(readFileSync(MAP_PATH, 'utf8')) : {};
const saveMap = (map) => {
  mkdirSync(dirname(MAP_PATH), { recursive: true });
  writeFileSync(MAP_PATH, `${JSON.stringify(map, null, 2)}\n`);
};

function makeClient(dryRun) {
  const creds = readCredentials();
  const offline = creds.missing.length > 0;
  if (offline && !dryRun) {
    log('TestRail credentials are not configured.');
    log('');
    log(`  Missing: ${creds.missing.join(', ')}`);
    log('');
    log('Set them (PowerShell, persisted for your user):');
    log(
      "  [Environment]::SetEnvironmentVariable('TESTRAIL_URL','https://your-instance.testrail.io','User')",
    );
    log(
      "  [Environment]::SetEnvironmentVariable('TESTRAIL_USER','you@example.com','User')",
    );
    log(
      "  [Environment]::SetEnvironmentVariable('TESTRAIL_API_KEY','<key>','User')",
    );
    log('');
    log('Key: TestRail -> My Settings -> API Keys -> Add Key.');
    log('An admin must also enable Administration -> Site Settings -> API.');
    log('');
    log(
      'Re-run with --dry-run to exercise everything locally without credentials.',
    );
    process.exit(2);
  }
  return {
    client: new TestRailClient({
      ...creds,
      dryRun,
      verbose: process.argv.includes('--verbose'),
      log,
    }),
    offline,
  };
}

// --------------------------------------------------------------------------
async function cmdStatus(args) {
  const dryRun = Boolean(args['dry-run']);
  const catalogue = buildCatalogue();
  const map = loadMap();
  const vitest = collectVitestResults();

  log('Haze Agent — TestRail sync status');
  log('='.repeat(62));
  log('');
  log(`Local catalogue cases : ${catalogue.length}`);
  for (const [section, cases] of bySection(catalogue))
    log(`  ${String(cases.length).padStart(3)}  ${section}`);
  log('');

  const mapped = catalogue.filter((c) => map[c.key]).length;
  log(`Mapped to TestRail ids: ${mapped} / ${catalogue.length}`);
  if (mapped < catalogue.length)
    log(
      `  -> run "import" to create the remaining ${catalogue.length - mapped}`,
    );
  log('');

  if (vitest.missing) {
    log('vitest link coverage  : no report found');
    log('  -> generate one:');
    log(
      '     npx vitest run --project unit --reporter=json --outputFile=qa/vitest-results.json',
    );
  } else {
    log(`vitest tests total    : ${vitest.totals.total}`);
    log(`  with TestRail ids   : ${vitest.totals.linked}`);
    log(`  without ids         : ${vitest.totals.unlinked}`);
    log('  (link a test by putting [C12345] in its title)');
  }
  log('');

  if (dryRun) {
    log('[dry-run] skipping remote comparison.');
    return;
  }

  const { client } = makeClient(false);
  const projectId = args.project;
  if (!projectId) {
    const projects = await client.projects();
    log(`TestRail projects (${projects.length}):`);
    for (const p of projects) log(`  ${p.id}  ${p.name}`);
    log('');
    log('Pass --project <id> for per-project coverage.');
    return;
  }
  const remote = await client.cases(projectId, args.suite);
  const remoteIds = new Set(remote.map((c) => c.id));
  const stale = Object.entries(map).filter(([, id]) => !remoteIds.has(id));
  log(`TestRail cases in project ${projectId}: ${remote.length}`);
  log(`Local keys pointing at missing remote cases: ${stale.length}`);
  for (const [key] of stale.slice(0, 20)) log(`  stale: ${key}`);
}

// --------------------------------------------------------------------------
async function cmdImport(args) {
  const dryRun = Boolean(args['dry-run']);
  const projectId = args.project;
  if (!projectId && !dryRun) {
    log('ERROR: --project <id> is required for import.');
    process.exit(1);
  }
  const catalogue = buildCatalogue();
  if (!catalogue.length) {
    log('ERROR: catalogue is empty — run the audit first so qa/*.json exist.');
    process.exit(1);
  }
  const { client, offline } = makeClient(dryRun);
  const map = loadMap();

  // Resolve existing sections so re-running import is idempotent.
  let existingSections = [];
  let existingCases = [];
  if (!offline) {
    existingSections = await client.sections(projectId, args.suite);
    existingCases = await client.cases(projectId, args.suite);
  }
  const sectionByName = new Map(existingSections.map((s) => [s.name, s]));
  const caseByTitle = new Map(existingCases.map((c) => [c.title, c]));

  let created = 0;
  let updated = 0;
  let reused = 0;

  for (const [sectionName, cases] of bySection(catalogue)) {
    let section = sectionByName.get(sectionName);
    if (!section) {
      log(`  + section "${sectionName}"`);
      const body = {
        name: sectionName,
        ...(args.suite ? { suite_id: Number(args.suite) } : {}),
      };
      section = await client.addSection(projectId ?? 0, body);
      sectionByName.set(sectionName, section);
    } else {
      log(`  = section "${sectionName}" (${section.id})`);
    }

    for (const c of cases) {
      const body = {
        title: c.title,
        custom_preconds: c.preconds ?? '',
        custom_steps: c.steps ?? '',
        custom_expected: c.expected ?? '',
        ...(c.refs ? { refs: c.refs } : {}),
      };
      const known = map[c.key];
      const byTitle = caseByTitle.get(c.title);

      if (known) {
        await client.updateCase(known, body);
        updated += 1;
      } else if (byTitle) {
        // Adopt a case that already exists under the same title.
        map[c.key] = byTitle.id;
        await client.updateCase(byTitle.id, body);
        reused += 1;
      } else {
        const result = await client.addCase(section.id, body);
        if (result?.id && result.id > 0) map[c.key] = result.id;
        created += 1;
      }
    }
  }

  if (!dryRun) saveMap(map);
  log('');
  log(
    `import: ${created} created, ${updated} updated, ${reused} adopted (catalogue ${catalogue.length})`,
  );
  if (dryRun) {
    log(
      `[dry-run] ${client.writes.length} write(s) suppressed; case-map.json untouched.`,
    );
    const sample = client.writes.slice(0, 2);
    for (const w of sample)
      log(
        `  sample -> ${w.endpoint}: ${JSON.stringify(w.body).slice(0, 220)}...`,
      );
  } else {
    log(`case-map.json now holds ${Object.keys(map).length} mappings.`);
  }
}

// --------------------------------------------------------------------------
async function cmdRun(args) {
  const dryRun = Boolean(args['dry-run']);
  const projectId = args.project;
  if (!projectId && !dryRun) {
    log('ERROR: --project <id> is required for run.');
    process.exit(1);
  }
  const { client } = makeClient(dryRun);
  const map = loadMap();
  const catalogue = buildCatalogue();
  const caseIds = catalogue.map((c) => map[c.key]).filter((id) => id > 0);
  const vitest = collectVitestResults();
  for (const r of vitest.linked) caseIds.push(r.case_id);

  const unique = [...new Set(caseIds)];
  if (!unique.length) {
    log(
      'ERROR: no mapped case ids. Run "import" first (or link vitest tests).',
    );
    if (!dryRun) process.exit(1);
  }

  const name =
    args.name ??
    `Haze Agent automated — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const body = {
    name,
    include_all: false,
    case_ids: unique,
    ...(args.suite ? { suite_id: Number(args.suite) } : {}),
  };
  const run = await client.addRun(projectId ?? 0, body);
  log('');
  log(`run: "${name}" with ${unique.length} case(s)`);
  if (dryRun) log('[dry-run] no run created.');
  else {
    log(`run id: ${run.id}`);
    log(`next: node qa/testrail/cli.mjs push --run ${run.id}`);
  }
}

// --------------------------------------------------------------------------
async function cmdPush(args) {
  const dryRun = Boolean(args['dry-run']);
  const runId = args.run;
  if (!runId && !dryRun) {
    log('ERROR: --run <id> is required for push.');
    process.exit(1);
  }
  const { client } = makeClient(dryRun);
  const map = loadMap();
  const artifactResults = collectArtifactResults();
  const vitest = collectVitestResults();

  const payload = [];
  const unmapped = [];
  let placeholder = 0;
  for (const r of artifactResults) {
    const case_id = map[r.key];
    const { key, ...rest } = r;
    if (!case_id || case_id < 0) {
      unmapped.push(r.key);
      // In dry-run, stand in a placeholder id so the payload shape and the
      // full status tally are still demonstrable without a real import.
      if (dryRun) {
        placeholder += 1;
        payload.push({ case_id: `<unmapped:${key}>`, ...rest });
      }
      continue;
    }
    payload.push({ case_id, ...rest });
  }
  payload.push(...vitest.linked);

  const tally = payload.reduce((acc, r) => {
    acc[r.status_id] = (acc[r.status_id] ?? 0) + 1;
    return acc;
  }, {});

  log('Haze Agent — push results to TestRail');
  log('='.repeat(62));
  log(`artifact results collected : ${artifactResults.length}`);
  log(`vitest linked results      : ${vitest.linked.length}`);
  log(`mappable payload           : ${payload.length - placeholder}`);
  log(`unmapped catalogue keys    : ${unmapped.length}`);
  if (placeholder)
    log(
      `  (dry-run stands in ${placeholder} placeholder id(s) so the shape is visible)`,
    );
  for (const k of unmapped.slice(0, 8)) log(`    unmapped: ${k}`);
  if (unmapped.length > 8) log(`    ...and ${unmapped.length - 8} more`);
  log('');
  log('by status:');
  for (const [id, n] of Object.entries(tally))
    log(`  ${String(n).padStart(4)}  ${STATUS_NAME[id] ?? id}`);
  log('');

  if (!payload.length) {
    log('Nothing to push. Run "import" to create the case mapping first.');
    return;
  }
  if (dryRun) {
    log(
      `[dry-run] would POST add_results_for_cases/${runId ?? '<run>'} with ${payload.length} result(s).`,
    );
    log('sample payload entry:');
    log(JSON.stringify(payload[0], null, 2).slice(0, 700));
    return;
  }

  // TestRail accepts bulk results; chunk to stay well inside request limits.
  const CHUNK = 200;
  let sent = 0;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const slice = payload.slice(i, i + CHUNK);
    await client.addResultsForCases(runId, slice);
    sent += slice.length;
    log(`  pushed ${sent}/${payload.length}`);
  }
  log('');
  log(`push complete: ${sent} result(s) -> run ${runId}`);
  const base = readCredentials().url;
  if (base) log(`view: ${base}/index.php?/runs/view/${runId}`);
}

// --------------------------------------------------------------------------
const COMMANDS = {
  status: cmdStatus,
  import: cmdImport,
  run: cmdRun,
  push: cmdPush,
};

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

if (!command || !COMMANDS[command]) {
  log('Haze Agent <-> TestRail');
  log('');
  log(
    '  node qa/testrail/cli.mjs status  [--project N] [--suite N] [--dry-run]',
  );
  log('  node qa/testrail/cli.mjs import  --project N [--suite N] [--dry-run]');
  log(
    '  node qa/testrail/cli.mjs run     --project N [--suite N] [--name "..."] [--dry-run]',
  );
  log('  node qa/testrail/cli.mjs push    --run N [--dry-run]');
  log('');
  log('--dry-run needs no credentials and performs no writes.');
  process.exit(command ? 1 : 0);
}

try {
  await COMMANDS[command](args);
} catch (error) {
  if (error instanceof TestRailError) {
    log('');
    log(`TestRail API error on ${error.endpoint}: HTTP ${error.status}`);
    log(
      typeof error.body === 'string'
        ? error.body.slice(0, 500)
        : JSON.stringify(error.body).slice(0, 500),
    );
    if (error.status === 401 || error.status === 403)
      log(
        'Check TESTRAIL_USER / TESTRAIL_API_KEY and that the API is enabled.',
      );
    process.exit(1);
  }
  throw error;
}
