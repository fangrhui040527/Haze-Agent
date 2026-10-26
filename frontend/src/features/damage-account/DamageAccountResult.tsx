import type { ReactNode } from 'react';
import type {
  ArtifactRef,
  JsonValue,
} from '../../../../app/contracts/artifacts.ts';
import type { ArtifactReviewCheck } from '../../../../app/contracts/manager.ts';
import {
  damageAccountSchema,
  damageCheckSchema,
  damageCoverageSchema,
  damageIncidenceSchema,
  damageInputsSchema,
  damageMethodsSchema,
  damageOverlapSchema,
  damagePhysicalSchema,
  damageReviewSchema,
  damageRevisionBridgeSchema,
  damageScenariosSchema,
  damageScopeSchema,
  damageSourceFireExtensionSchema,
  damageWelfareSchema,
  type DamageAccount,
} from '../../../../app/contracts/damage-account.ts';
import styles from './DamageAccountResult.module.css';

type ReviewStatus = 'supported' | 'needs_review' | 'rejected' | 'not_required';
const NUMERICAL_COMPONENTS = new Set([
  'damage.physical',
  'damage.incidence',
  'damage.welfare',
  'damage.scenarios',
]);
const REQUIRED_NUMERICAL_COMPONENTS = [
  'damage.physical',
  'damage.incidence',
  'damage.welfare',
];
export const exactArtifactMatch = (a: ArtifactRef, b: ArtifactRef): boolean =>
  a.id === b.id && a.version === b.version && a.sha256 === b.sha256;

/** Rejection wins when contradictory exact checks have been retained in history. */
export function damageArtifactReview(
  reference: ArtifactRef,
  checks: readonly ArtifactReviewCheck[],
  kind?: string,
): ReviewStatus {
  const matching = checks.filter((check) =>
    exactArtifactMatch(check.artifact, reference),
  );
  if (matching.some((check) => check.verdict === 'rejected')) return 'rejected';
  if (
    matching.length === 0 &&
    kind &&
    !NUMERICAL_COMPONENTS.has(kind) &&
    kind !== 'damage.account' &&
    kind !== 'damage.revision-bridge'
  )
    return 'not_required';
  return matching.some((check) => check.verdict === 'supported')
    ? 'supported'
    : 'needs_review';
}

function Sources({
  references,
  baseUrl,
}: {
  references: readonly ArtifactRef[];
  baseUrl: string;
}) {
  if (!references.length) return <p>No exact sources were supplied.</p>;
  return (
    <ul>
      {references.map((reference) => (
        <li key={`${reference.id}/${reference.version}/${reference.sha256}`}>
          <a
            href={`${baseUrl}/api/artifacts/${encodeURIComponent(reference.id)}`}
            target="_blank"
            rel="noreferrer"
          >
            Exact source {reference.id}, version {reference.version}
          </a>
          <span className={styles.hash}>SHA-256 {reference.sha256}</span>
        </li>
      ))}
    </ul>
  );
}

function Table({
  caption,
  headings,
  rows,
}: {
  caption: string;
  headings: string[];
  rows: ReactNode[][];
}) {
  if (!rows.length) return <p>{caption}: no values estimated.</p>;
  return (
    <div
      className={styles.tableScroll}
      role="region"
      aria-label={caption}
      tabIndex={0}
    >
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {headings.map((heading) => (
              <th scope="col" key={heading}>
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, column) => (
                <td key={column}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Notes({ title, notes }: { title: string; notes: readonly string[] }) {
  if (!notes.length) return null;
  return (
    <section>
      <h5>{title}</h5>
      <ul>
        {notes.map((note, index) => (
          <li key={index}>{note}</li>
        ))}
      </ul>
    </section>
  );
}

function Omissions({ omissions }: { omissions: DamageAccount['omissions'] }) {
  if (!omissions.length) return null;
  return (
    <section>
      <h5>Omitted effect records</h5>
      <p>
        Missing and disclosure-suppressed quantities are not zero. Missing harm
        remains outside quantified uncertainty intervals.
      </p>
      <Table
        caption="Omitted effects by scenario"
        headings={[
          'Effect / scenario',
          'Endpoint / geography / population',
          'Missingness / origin',
          'Unit',
          'Reason',
          'Uncertainty basis',
        ]}
        rows={omissions.map((omission) => [
          `${omission.effect_id} / ${omission.scenario_id}`,
          `${omission.endpoint_id} / ${omission.geography} / ${omission.population_stratum}`,
          `${words(omission.status)} / ${omission.origin}`,
          omission.unit,
          omission.reason,
          `${words(omission.uncertainty.interpretation)}: ${omission.uncertainty.basis}`,
        ])}
      />
    </section>
  );
}

const words = (value: string) => value.replaceAll('_', ' ');
type MoneyTotal = {
  scenario_id: string;
  amount: number;
  currency: string;
  price_year: number;
};
function MoneyTable({
  title,
  totals,
  publish,
}: {
  title: string;
  totals: MoneyTotal[];
  publish: boolean;
}) {
  return (
    <section>
      <h5>{title}</h5>
      {publish ? (
        <Table
          caption={`${title} by scenario`}
          headings={['Scenario', 'Server total', 'Currency / price year']}
          rows={totals.map((total) => [
            total.scenario_id,
            String(total.amount),
            `${total.currency} / ${total.price_year}`,
          ])}
        />
      ) : (
        <p>Numerical values withheld pending a supported exact review.</p>
      )}
    </section>
  );
}

/** Optional schema-validated presentation. All quantities and totals are server results. */
export function DamageAccountResult({
  content,
  kind = 'damage.account',
  baseUrl = '',
  reviewStatus = 'needs_review',
  checks = [],
  stale = false,
}: {
  content: JsonValue;
  kind?: string;
  baseUrl?: string;
  reviewStatus?: ReviewStatus;
  checks?: readonly ArtifactReviewCheck[];
  stale?: boolean;
}) {
  if (!kind.startsWith('damage.')) return null;
  const publish = reviewStatus === 'supported';
  const banner = (
    <p className={styles.status} role="status">
      {stale
        ? 'Historical component — stale for the current task.'
        : 'Current component.'}{' '}
      Review: {words(reviewStatus)}.
      {stale && publish
        ? ' Values are historical, not a current supported subtotal.'
        : ''}
    </p>
  );
  const invalid = (
    <p role="status">
      This damage artifact does not match a supported schema. Inspect the exact
      artifact content below.
    </p>
  );
  let detail: ReactNode;
  let references: readonly ArtifactRef[] = [];

  switch (kind) {
    case 'damage.account': {
      const parsed = damageAccountSchema.safeParse(content);
      if (!parsed.success) return invalid;
      const account = parsed.data;
      const componentReviews = account.component_refs
        .filter((component) => NUMERICAL_COMPONENTS.has(component.kind))
        .map((component) => ({
          ...component,
          verdict: damageArtifactReview(component.artifact, checks),
        }));
      const supported =
        publish &&
        REQUIRED_NUMERICAL_COMPONENTS.every(
          (kind) =>
            componentReviews.filter((component) => component.kind === kind)
              .length === 1,
        ) &&
        (account.scenarios.length === 0 ||
          componentReviews.some(
            (component) => component.kind === 'damage.scenarios',
          )) &&
        componentReviews.every(
          (component) => component.verdict === 'supported',
        );
      references = [
        ...account.source_refs,
        ...account.omissions.flatMap((omission) => omission.source_refs),
      ];
      detail = (
        <>
          <h4>Damage account: {account.account_id}</h4>
          <p>
            Coverage: {words(account.status)}. Evidence origin:{' '}
            {account.evidence_origin === 'synthetic'
              ? 'synthetic fixture — illustrative, not a regional estimate'
              : 'imported quantities and declared unit values'}
            .
          </p>
          <p>
            {account.scope.intended_use} {account.scope.population}.{' '}
            {account.scope.countries.join(', ')}.
          </p>
          <p>
            Effects: {account.scope.effect_period.start} to{' '}
            {account.scope.effect_period.end}. Emissions:{' '}
            {account.scope.emissions_period.start} to{' '}
            {account.scope.emissions_period.end}. Valuation:{' '}
            {account.scope.valuation_date}; {account.scope.currency}, price year{' '}
            {account.scope.price_year}.
          </p>
          <p>
            Source scope: {account.scope.source_scope}. Smoke boundary:{' '}
            {account.scope.smoke_boundary}. Source-fire boundary:{' '}
            {account.scope.source_fire_boundary}.
          </p>
          {!supported && (
            <p className={styles.status}>
              Account totals withheld: the account and every numerical component
              require a supported review of their exact version and hash.
            </p>
          )}
          <section>
            <h5>Physical outcomes</h5>
            {supported ? (
              <Table
                caption="Physical outcomes by scenario and endpoint"
                headings={['Scenario', 'Endpoint', 'Quantity', 'Unit']}
                rows={account.physical_totals.map((total) => [
                  total.scenario_id,
                  total.endpoint_id,
                  String(total.quantity),
                  total.unit,
                ])}
              />
            ) : (
              <p>Numerical values withheld pending a supported exact review.</p>
            )}
          </section>
          <MoneyTable
            title="Financial incidence"
            totals={account.financing_totals}
            publish={supported}
          />
          <MoneyTable
            title="Selected social welfare"
            totals={account.welfare_totals}
            publish={supported}
          />
          <p>
            Financial incidence and social welfare are separate accounting
            views. Source removal differences do not establish a project's
            achieved benefit or cash return.
          </p>
          {supported && account.scenarios.length > 0 && (
            <Table
              caption="Scenario comparisons"
              headings={[
                'Scenario / comparator',
                'Interpretation',
                'Support / limitation',
                'Avoided damage',
                'Project cost',
                'Net benefit',
                'Benefit / cost ratio',
                'Currency / price year',
              ]}
              rows={account.scenarios.map((scenario) => [
                `${scenario.scenario_id} / ${scenario.comparator_id}`,
                words(scenario.interpretation),
                `${scenario.status}${scenario.limitation ? `: ${scenario.limitation}` : ''}`,
                scenario.avoided_damage === null
                  ? 'Not estimated'
                  : String(scenario.avoided_damage),
                scenario.project_cost === null
                  ? 'Not applicable'
                  : String(scenario.project_cost),
                scenario.net_benefit === null
                  ? 'Not applicable'
                  : String(scenario.net_benefit),
                scenario.benefit_cost_ratio === null
                  ? 'Not applicable'
                  : String(scenario.benefit_cost_ratio),
                `${scenario.currency} / ${scenario.price_year}`,
              ])}
            />
          )}
          <Table
            caption="Coverage and omissions"
            headings={[
              'Endpoint / geography',
              'Population',
              'Status / origin',
              'Monetary inclusion',
              'Reason',
            ]}
            rows={account.coverage.map((entry) => [
              `${entry.endpoint_id} / ${entry.geography}`,
              entry.population_stratum,
              `${words(entry.status)} / ${entry.origin}`,
              entry.monetary_inclusion ? 'Included' : 'Excluded',
              entry.reason,
            ])}
          />
          <Omissions omissions={account.omissions} />
          <section>
            <h5>Exact component review</h5>
            <ul>
              {account.component_refs.map((component) => (
                <li key={component.kind}>
                  <a
                    href={`${baseUrl}/api/artifacts/${encodeURIComponent(component.artifact.id)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {component.kind}, version {component.artifact.version}
                  </a>{' '}
                  —{' '}
                  {words(
                    damageArtifactReview(
                      component.artifact,
                      checks,
                      component.kind,
                    ),
                  )}
                  <span className={styles.hash}>
                    SHA-256 {component.artifact.sha256}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <Notes
            title="Limitations and uncertainty"
            notes={account.limitations}
          />
        </>
      );
      break;
    }
    case 'damage.physical': {
      const parsed = damagePhysicalSchema.safeParse(content);
      if (!parsed.success) return invalid;
      const physical = parsed.data;
      references = physical.effects.flatMap((effect) => effect.source_refs);
      detail = (
        <>
          <h4>Physical outcomes</h4>
          <Table
            caption="Physical effect records"
            headings={[
              'Effect / scenario',
              'Endpoint / geography / population',
              'Quantity / status',
              'Origin / inclusion',
              'Applicability and uncertainty',
            ]}
            rows={physical.effects.map((effect) => [
              `${effect.effect_id} / ${effect.scenario_id}`,
              `${effect.endpoint_id} / ${effect.geography} / ${effect.population_stratum}`,
              `${publish && effect.quantity !== null ? `${effect.quantity} ${effect.unit}` : effect.quantity === null ? 'Not estimated' : 'Withheld'} / ${words(effect.status)}`,
              `${effect.origin} / ${effect.included ? 'Included' : `Excluded: ${effect.exclusion_reason}`}`,
              <>
                {effect.applicability}
                <br />
                Causal method: {effect.causal_method}.<br />
                Uncertainty: {words(effect.uncertainty.interpretation)} —{' '}
                {effect.uncertainty.basis}
                {publish &&
                effect.quantity !== null &&
                effect.uncertainty.lower !== undefined
                  ? ` (${effect.uncertainty.lower} to ${effect.uncertainty.upper} ${effect.unit})`
                  : ''}
              </>,
            ])}
          />
        </>
      );
      break;
    }
    case 'damage.welfare': {
      const parsed = damageWelfareSchema.safeParse(content);
      if (!parsed.success) return invalid;
      detail = (
        <>
          <h4>Selected social welfare</h4>
          <MoneyTable
            title="Selected social welfare"
            totals={parsed.data.totals}
            publish={publish}
          />
          {publish && (
            <Table
              caption="Valuation records"
              headings={[
                'Effect / scenario',
                'Physical quantity',
                'Declared unit value',
                'Server amount',
              ]}
              rows={parsed.data.lines.map((line) => [
                `${line.effect_id} / ${line.scenario_id}`,
                `${line.quantity} ${line.quantity_unit}`,
                String(line.unit_value),
                String(line.amount),
              ])}
            />
          )}
          <Notes
            title="Excluded alternatives"
            notes={parsed.data.excluded_effect_ids}
          />
        </>
      );
      break;
    }
    case 'damage.incidence': {
      const parsed = damageIncidenceSchema.safeParse(content);
      if (!parsed.success) return invalid;
      references = parsed.data.entries.flatMap((entry) => entry.source_refs);
      detail = (
        <>
          <h4>Financial incidence</h4>
          <MoneyTable
            title="Resource financing"
            totals={parsed.data.financing_totals}
            publish={publish}
          />
          <MoneyTable
            title="Net boundary transfers"
            totals={parsed.data.net_boundary_transfers}
            publish={publish}
          />
          <Table
            caption="Financing and transfer records"
            headings={[
              'Effect / transaction',
              'Payer → recipient',
              'Boundary membership',
              'Type',
              'Amount / currency / price year',
            ]}
            rows={parsed.data.entries.map((entry) => [
              `${entry.effect_id} / ${entry.transaction_id}`,
              `${entry.payer} → ${entry.recipient}`,
              `Payer ${entry.payer_in_boundary ? 'inside' : 'outside'}; recipient ${entry.recipient_in_boundary ? 'inside' : 'outside'}`,
              words(entry.financing_type),
              publish
                ? `${entry.amount} ${entry.currency} / ${entry.price_year}`
                : 'Withheld',
            ])}
          />
        </>
      );
      break;
    }
    case 'damage.coverage': {
      const parsed = damageCoverageSchema.safeParse(content);
      if (!parsed.success) return invalid;
      references = parsed.data.omissions.flatMap(
        (omission) => omission.source_refs,
      );
      detail = (
        <>
          <h4>Coverage and omissions</h4>
          <p>{words(parsed.data.status)}</p>
          <Table
            caption="Coverage records"
            headings={[
              'Endpoint / geography',
              'Population',
              'Status / origin',
              'Monetary inclusion',
              'Reason',
            ]}
            rows={parsed.data.entries.map((entry) => [
              `${entry.endpoint_id} / ${entry.geography}`,
              entry.population_stratum,
              `${words(entry.status)} / ${entry.origin}`,
              entry.monetary_inclusion ? 'Included' : 'Excluded',
              entry.reason,
            ])}
          />
          <Omissions omissions={parsed.data.omissions} />
          <Notes title="Limitations" notes={parsed.data.limitations} />
        </>
      );
      break;
    }
    case 'damage.source-fire-extension': {
      const parsed = damageSourceFireExtensionSchema.safeParse(content);
      if (!parsed.success) return invalid;
      detail = (
        <>
          <h4>Source-fire extension</h4>
          <Table
            caption="Source-fire categories"
            headings={['Category', 'Status', 'Reason']}
            rows={parsed.data.categories.map((category) => [
              category.category,
              words(category.status),
              category.reason,
            ])}
          />
        </>
      );
      break;
    }
    case 'damage.overlap': {
      const parsed = damageOverlapSchema.safeParse(content);
      if (!parsed.success) return invalid;
      detail = (
        <>
          <h4>Overlap decisions</h4>
          <Table
            caption="Inclusion decisions"
            headings={['Effect', 'Overlap group', 'Selection', 'Reason']}
            rows={parsed.data.decisions.map((decision) => [
              decision.effect_id,
              decision.overlap_group,
              decision.included ? 'Included' : 'Excluded alternative',
              decision.reason,
            ])}
          />
        </>
      );
      break;
    }
    case 'damage.scenarios': {
      const parsed = damageScenariosSchema.safeParse(content);
      if (!parsed.success) return invalid;
      detail = (
        <>
          <h4>Scenario assumptions</h4>
          <ul>
            {parsed.data.scenarios.map((scenario) => (
              <li key={scenario.scenario_id}>
                <strong>
                  {scenario.scenario_id}: {words(scenario.kind)}
                </strong>
                <p>
                  {scenario.description} Comparator: {scenario.comparator_id}.
                </p>
                <p>
                  Effectiveness: {scenario.effectiveness}. Adoption:{' '}
                  {scenario.adoption}. Maintenance: {scenario.maintenance}.
                  Durability: {scenario.durability}. Displacement:{' '}
                  {scenario.displacement}. Costs and adverse effects:{' '}
                  {scenario.costs_and_adverse_effects}.
                </p>
              </li>
            ))}
          </ul>
          {publish && (
            <Table
              caption="Scenario differences"
              headings={[
                'Scenario / comparator',
                'Interpretation',
                'Support / limitation',
                'Avoided damage',
                'Project cost',
                'Net benefit',
                'Benefit / cost ratio',
                'Currency / price year',
              ]}
              rows={parsed.data.comparisons.map((scenario) => [
                `${scenario.scenario_id} / ${scenario.comparator_id}`,
                words(scenario.interpretation),
                `${scenario.status}${scenario.limitation ? `: ${scenario.limitation}` : ''}`,
                scenario.avoided_damage === null
                  ? 'Not estimated'
                  : String(scenario.avoided_damage),
                scenario.project_cost === null
                  ? 'Not applicable'
                  : String(scenario.project_cost),
                scenario.net_benefit === null
                  ? 'Not applicable'
                  : String(scenario.net_benefit),
                scenario.benefit_cost_ratio === null
                  ? 'Not applicable'
                  : String(scenario.benefit_cost_ratio),
                `${scenario.currency} / ${scenario.price_year}`,
              ])}
            />
          )}
        </>
      );
      break;
    }
    case 'damage.methods': {
      const parsed = damageMethodsSchema.safeParse(content);
      if (!parsed.success) return invalid;
      detail = (
        <>
          <h4>Accounting methods</h4>
          <ul>
            {parsed.data.methods.map((method) => (
              <li key={method.method_id}>
                {method.method_id}, version {method.version}:{' '}
                {method.description}
              </li>
            ))}
          </ul>
          <Notes title="Method limitations" notes={parsed.data.limitations} />
        </>
      );
      break;
    }
    case 'damage.inputs': {
      const parsed = damageInputsSchema.safeParse(content);
      if (!parsed.success) return invalid;
      references = parsed.data.source_refs;
      detail = (
        <>
          <h4>Imported input manifest</h4>
          <p>
            Importing a quantity does not establish scientific applicability.
          </p>
          <Table
            caption="Pinned input selections"
            headings={['Table', 'Selected rows', 'Support', 'Access']}
            rows={parsed.data.manifest.map((entry) => [
              entry.table_type,
              entry.selected_rows.join(', '),
              entry.native_support,
              entry.access_classification,
            ])}
          />
          <Notes title="Input limitations" notes={parsed.data.limitations} />
        </>
      );
      break;
    }
    case 'damage.scope': {
      const parsed = damageScopeSchema.safeParse(content);
      if (!parsed.success) return invalid;
      const scope = parsed.data;
      detail = (
        <>
          <h4>Declared account scope</h4>
          <p>
            {scope.intended_use}. {scope.source_scope}. {scope.population}.{' '}
            {scope.countries.join(', ')}.
          </p>
          <p>
            Smoke boundary: {scope.smoke_boundary}. Source-fire boundary:{' '}
            {scope.source_fire_boundary}. Social boundary members:{' '}
            {scope.social_boundary_members.join(', ')}.
          </p>
          <p>
            Emissions: {scope.emissions_period.start} to{' '}
            {scope.emissions_period.end}. Effects: {scope.effect_period.start}{' '}
            to {scope.effect_period.end}. Valuation: {scope.valuation_date},{' '}
            {scope.currency}, price year {scope.price_year}.
          </p>
          <p>
            Historical scenario: {scope.historical_scenario_id}. Baseline:{' '}
            {scope.baseline_scenario_id}. Approved methods:{' '}
            {scope.approved_method_ids.join(', ')}.
          </p>
        </>
      );
      break;
    }
    case 'damage.review': {
      const review = damageReviewSchema.safeParse(content);
      const check = damageCheckSchema.safeParse(content);
      if (!review.success && !check.success) return invalid;
      const parsed = review.success ? review.data : check.data!;
      references = review.success ? review.data.reviewed_artifacts : [];
      detail = (
        <>
          <h4>Independent accounting check</h4>
          <p>
            Arithmetic:{' '}
            {review.success
              ? words(review.data.verdict)
              : check.data!.valid
                ? 'passed'
                : 'failed'}
            . Scientific applicability: not established by arithmetic.
          </p>
          {review.success && (
            <p>
              Reviewer {review.data.reviewer.assignment_id}, revision{' '}
              {review.data.reviewer.revision}.
            </p>
          )}
          <Notes title="Executed checks" notes={parsed.checks} />
          <Notes title="Findings and objections" notes={parsed.findings} />
          <Notes title="Review limitations" notes={parsed.limitations} />
        </>
      );
      break;
    }
    case 'damage.revision-bridge': {
      const parsed = damageRevisionBridgeSchema.safeParse(content);
      if (!parsed.success) return invalid;
      const bridge = parsed.data;
      references = [
        bridge.previous_account,
        bridge.current_account,
        ...bridge.source_refs,
      ];
      detail = (
        <>
          <h4>Account revision bridge</h4>
          <p>
            Changes reflect declared accounting quantities, coverage, methods,
            values and boundaries. They are not an observed change in haze.
            Currency: {bridge.currency}; price years{' '}
            {bridge.previous_price_year} to {bridge.current_price_year}.
          </p>
          {publish ? (
            <Table
              caption="Server revision decomposition by scenario"
              headings={[
                'Scenario',
                'Previous total',
                'Current total',
                'Total change',
                'Quantities',
                'Coverage',
                'Methods',
                'Values',
                'Boundary / incidence',
              ]}
              rows={bridge.changes.map((change) => [
                change.scenario_id,
                String(change.previous_total),
                String(change.current_total),
                String(change.total_change),
                String(change.quantities),
                String(change.coverage),
                String(change.methods),
                String(change.values),
                String(change.boundary_and_incidence),
              ])}
            />
          ) : (
            <p>Revision amounts withheld pending a supported exact review.</p>
          )}
          <Notes title="Revision limitations" notes={bridge.limitations} />
        </>
      );
      break;
    }
    default:
      return null;
  }
  const uniqueReferences = [
    ...new Map(
      references.map((reference) => [
        `${reference.id}/${reference.version}/${reference.sha256}`,
        reference,
      ]),
    ).values(),
  ];
  return (
    <div className={styles.result}>
      {banner}
      {detail}
      {uniqueReferences.length > 0 && (
        <section>
          <h5>Exact input sources</h5>
          <Sources references={uniqueReferences} baseUrl={baseUrl} />
        </section>
      )}
    </div>
  );
}
