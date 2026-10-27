import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    evidence: { type: 'string' },
    state: { type: 'string' },
    output: { type: 'string' },
    publish: { type: 'boolean', default: false },
  },
});
if (!values.evidence || !values.state)
  throw new Error(
    'Provide --evidence <reviewed bundle directory> and --state <server state directory>. Validation is read-only unless --publish is explicit.',
  );
const {
  createExecutionRegistry,
  createModelRouteRegistry,
  createNightshiftJobAdapter,
} = await import('../dist/composition.js');
const {
  currentReleaseBindings,
  RELEASE_EVIDENCE_SLOTS,
  STRICT_RELEASE_ROLES,
  releaseManifestSchema,
  validateRelease,
  publishNightshiftRelease,
  createNightshiftReleasePolicy,
} = await import('../dist/release/nightshift-release.js');
const { INITIAL_AUTOMATIC_SCOPE } =
  await import('../dist/contracts/nightshift-automatic.js');
const output = resolve(
  values.output ?? '.state/nightshift-release-assembly',
  randomUUID(),
);
await mkdir(output, { recursive: true });
const path = join(output, 'report.json');
const report = {
  version: 1,
  started_at: new Date().toISOString(),
  mode: values.publish ? 'publish-requested' : 'read-only-validation',
  passed: false,
  published: false,
  gaps: [],
  evidence_sha256: {},
};
const evidence = {};
const bindings = () =>
  currentReleaseBindings({
    registry: createExecutionRegistry({ mode: 'live', env: process.env }),
    modelRoutes: createModelRouteRegistry(process.env),
    nightshiftJobs: createNightshiftJobAdapter(process.env),
    signal: AbortSignal.timeout(10_000),
  });
try {
  // A bundle contains only the fixed gate names, never arbitrary manifest paths.
  for (const slot of RELEASE_EVIDENCE_SLOTS) {
    let file;
    try {
      file = await open(join(resolve(values.evidence), `${slot}.json`), 'r');
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 4_194_304)
        throw new Error('out-of-bounds');
      const bytes = await file.readFile();
      if (bytes.byteLength > 4_194_304) throw new Error('out-of-bounds');
      evidence[slot] = bytes;
      report.evidence_sha256[slot] = createHash('sha256')
        .update(bytes)
        .digest('hex');
    } catch {
      report.gaps.push(`Missing or oversized reviewed ${slot}.json evidence.`);
    } finally {
      await file?.close();
    }
  }
  if (report.gaps.length) throw new Error('incomplete-bundle');
  const current = await bindings();
  if (!current) {
    report.gaps.push(
      'Current reviewed build, routes, installation and cloud roster identities could not be established.',
    );
    throw new Error('identities-unavailable');
  }
  const manifest = releaseManifestSchema.parse({
    schema_version: 'haze.nightshift.release.manifest.v1',
    release_id: randomUUID(),
    published_at: new Date().toISOString(),
    bindings: current,
    strict_roles: [...STRICT_RELEASE_ROLES],
    scope: structuredClone(INITIAL_AUTOMATIC_SCOPE),
    evidence: report.evidence_sha256,
  });
  validateRelease(manifest, evidence, current);
  report.bindings = current;
  report.scope = manifest.scope;
  if (values.publish) {
    // Resolve current identities again immediately before publication. Changed
    // routes/build/runtime/roster invalidate the evidence rather than remap it.
    const latest = await bindings();
    if (!latest) throw new Error('identities-unavailable');
    validateRelease(manifest, evidence, latest);
    report.manifest = publishNightshiftRelease({
      stateDirectory: resolve(values.state),
      bindings: latest,
      scope: manifest.scope,
      evidence,
    });
    report.published = true;
    report.production_readiness = await createNightshiftReleasePolicy({
      stateDirectory: resolve(values.state),
      bindings,
    })();
    if (
      !report.production_readiness.released ||
      !report.production_readiness.ready
    )
      throw new Error('production-readback-blocked');
  }
  report.passed = true;
} catch (error) {
  report.error = [
    'incomplete-bundle',
    'identities-unavailable',
    'production-readback-blocked',
  ].includes(error?.message)
    ? error.message
    : 'release-validation-rejected';
  // ReleaseRejection messages contain only known gate names and safe identities.
  if (error?.constructor?.name === 'ReleaseRejection')
    report.gaps.push(error.message);
} finally {
  report.finished_at = new Date().toISOString();
  await writeFile(path, JSON.stringify(report, null, 2) + '\n');
}
console.log(
  JSON.stringify({
    report: path,
    passed: report.passed,
    published: report.published,
    gaps: report.gaps,
    error: report.error ?? null,
  }),
);
if (!report.passed) process.exitCode = 1;
