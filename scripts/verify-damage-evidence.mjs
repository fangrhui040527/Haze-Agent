import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  acquireDamageEvidence,
  acquisitionRequestSchema,
  DamageEvidenceArchive,
  selectDamageEvidenceCase,
} from '../dist/capabilities/damage-evidence/index.js';

const caseOnly = process.argv.includes('--case-only');
if (!process.argv.includes('--live') && !caseOnly)
  throw new Error(
    'Usage: npm run build && node scripts/verify-damage-evidence.mjs --live | --case-only',
  );
const date = '2026-10-27';
const archiveRoot = resolve(
  process.env.DAMAGE_EVIDENCE_ARCHIVE_DIR ||
    `.state/damage-evidence-verification/${date}`,
);
const outputRoot = resolve(`data/damage-evidence-verification/${date}`);
await mkdir(outputRoot, { recursive: true });
const archive = new DamageEvidenceArchive(archiveRoot);
const scope = (start, end) => ({
  geography: {
    country: 'MY',
    level: 'country',
    id: 'MY',
    name: 'Malaysia',
    boundary_version: null,
  },
  occurrence_period: { start, end },
  outcome: 'deaths',
  attribution_basis: 'fire_attributed',
  monetary_view: 'physical_only',
  currency: null,
  price_year: null,
});
const requests = [
  ['dosm-district-population', '2024-01-01', '2024-12-31'],
  ['dosm-district-deaths', '2024-01-01', '2024-12-31'],
  ['dosm-selangor-wages', '2024-01-01', '2024-12-31'],
  ['malaysia-monthly-pollution', '2024-09-01', '2024-10-31'],
  ['koplitz-2016-fire-mortality', '2015-09-01', '2015-10-31'],
  ['crippa-2016-acute-mortality', '2015-09-01', '2015-10-31'],
  ['crippa-2016-acute-mortality-pmc', '2015-09-01', '2015-10-31'],
];
const outcomes = caseOnly
  ? JSON.parse(
      await readFile(
        resolve(outputRoot, 'acquisition-verification.json'),
        'utf8',
      ),
    ).outcomes
  : [];
for (const [source_id, start, end] of caseOnly ? [] : requests) {
  const request = acquisitionRequestSchema.parse({
    source_id,
    selection: { state: 'Selangor', district: 'Klang', period: { start, end } },
  });
  try {
    const result = await acquireDamageEvidence(archive, request, {
      signal: AbortSignal.timeout(120_000),
    });
    outcomes.push({ source_id, status: 'acquired', ...result });
    console.log(
      `${source_id}: ${result.capture.stage}, ${result.capture.raw_bytes} original bytes, ${result.capture.normalized_values.length} normalized rows`,
    );
  } catch (error) {
    outcomes.push({
      source_id,
      status: 'failed',
      error: error.message,
      availability: archive.availability(request),
    });
    console.log(`${source_id}: retained failure: ${error.message}`);
  }
}
const published = outcomes
  .filter(
    (item) =>
      item.status === 'acquired' &&
      [
        'koplitz-2016-fire-mortality',
        'crippa-2016-acute-mortality',
        'crippa-2016-acute-mortality-pmc',
      ].includes(item.source_id),
  )
  .map((item) => item.capture);
const cases = selectDamageEvidenceCase([
  {
    id: 'malaysia-2015-september-october',
    scope: scope('2015-09-01', '2015-10-31'),
    retained: published,
    rationale:
      'Primary-study leads address the 2015 event; original acquisition, country-specific endpoint and duration applicability remain gates before any estimate is imported.',
  },
  {
    id: 'malaysia-2006-september-october',
    scope: scope('2006-09-01', '2006-10-31'),
    retained: published.filter(
      (capture) => capture.source_id === 'koplitz-2016-fire-mortality',
    ),
    rationale:
      'Primary-study lead for the 2006 event; original acquisition and historical compatibility remain gaps.',
  },
  {
    id: 'malaysia-2019-september',
    scope: scope('2019-09-01', '2019-09-30'),
    retained: [],
    rationale:
      'Candidate requiring further published physical-effect discovery; current acquired annual 2024 rows cannot support a 2019 fire-attributed estimate.',
  },
]);
const caseRef = archive.saveCaseManifest(cases);
if (!caseOnly)
  await writeFile(
    resolve(outputRoot, 'acquisition-verification.json'),
    JSON.stringify(
      {
        schema_version: 'haze.damage.evidence.live-verification.v1',
        verified_at: new Date().toISOString(),
        verification_level: 'real_public_source_acquisition_only',
        archive_root: archiveRoot,
        outcomes,
        limitations: [
          '2024 numerical samples verify provider contracts; they are not the 2015 occurrence period and do not supply physical-effect inputs.',
          'This execution does not demonstrate live model routing, scientific qualification, genuine source revision, or intervention effectiveness.',
        ],
      },
      null,
      2,
    ) + '\n',
  );
await writeFile(
  resolve(outputRoot, 'case-selection.json'),
  JSON.stringify({ ...cases, retained_manifest_ref: caseRef }, null, 2) + '\n',
);
console.log(
  `Saved ${caseOnly ? 'rederived blocked case feasibility' : 'live acquisition and blocked public-case feasibility'} reports in ${outputRoot}`,
);
if (
  !outcomes.some(
    (item) => item.status === 'acquired' && item.capture.stage === 'validated',
  )
)
  process.exitCode = 1;
