import { z } from 'zod';
import type { JsonValue } from '../../../../app/contracts/artifacts.ts';
import { webSearchCaptureSchema } from '../../../../app/contracts/web-search.ts';
import {
  damageComparisonSchema,
  damageScientificCheckSchema,
} from '../../../../app/contracts/damage-evidence-review.ts';

const refLink = (id: string, baseUrl: string) =>
  `${baseUrl}/api/artifacts/${encodeURIComponent(id)}`;
const textList = z.array(z.string());
const planSchema = z.object({
  schema_version: z.literal('haze.damage.evidence.plan.v1'),
  feasibility: z.string(),
  requirements: z.array(
    z.object({
      id: z.string(),
      stage: z.string(),
      retained_captures: textList,
      gaps: textList,
    }),
  ),
  gaps: textList,
});
const captureSchema = z.object({
  schema_version: z.literal('haze.damage.evidence.capture.v1'),
  source_id: z.string(),
  stage: z.string(),
  source_url: z.url(),
  raw_ref: z.string(),
  raw_sha256: z.string(),
  retrieved_at: z.string(),
  evidence_origin: z.string(),
  observation_period: z
    .object({ start: z.string(), end: z.string() })
    .nullable(),
  normalized_values: z.array(
    z.object({
      input: z.string(),
      value: z.number(),
      unit: z.string(),
      source_locator: z.string(),
    }),
  ),
  gaps: textList,
});
function Gaps({ values }: { values: readonly string[] }) {
  return values.length ? (
    <ul>
      {values.map((value, index) => (
        <li key={`${index}:${value}`}>{value}</li>
      ))}
    </ul>
  ) : null;
}
/** Pure browser-safe rendering of retained evidence; source text is never rendered as HTML. */
export function DamageEvidenceResult({
  content,
  baseUrl = '',
}: {
  content: JsonValue;
  baseUrl?: string;
}) {
  const search = webSearchCaptureSchema.safeParse(content);
  if (search.success)
    return (
      <section aria-label="Retained search evidence">
        <h4>Source discovery</h4>
        <p>
          {search.data.evidence_origin.replaceAll('_', ' ')} · Retrieved{' '}
          {search.data.retrieved_at}. Search results await review.
        </p>
        <ul>
          {search.data.results.map((result, index) => (
            <li key={`${index}:${result.url}`}>
              <a href={result.url} target="_blank" rel="noreferrer">
                {result.title}
              </a>
              <p>Published: {result.published_date ?? 'not supplied'}</p>
              <p>{result.snippet}</p>
            </li>
          ))}
        </ul>
      </section>
    );
  const science = damageScientificCheckSchema.safeParse(content);
  if (science.success)
    return (
      <section aria-label="Scientific review status">
        <h4>Scientific applicability</h4>
        <p>
          {science.data.qualified
            ? 'Applicable at the recorded review time'
            : 'Qualification withheld'}{' '}
          · Checked {science.data.checked_at}
        </p>
        <p>
          <a href={refLink(science.data.expert_review.id, baseUrl)}>
            Exact expert review
          </a>
        </p>
        <Gaps values={science.data.reasons} />
      </section>
    );
  const comparison = damageComparisonSchema.safeParse(content);
  if (comparison.success) {
    const value = comparison.data,
      unit =
        value.baseline.valuation.view === 'physical'
          ? value.baseline.applicability.unit
          : `${value.baseline.valuation.currency ?? 'Unspecified currency'} (${value.baseline.valuation.price_year ?? 'unspecified price year'})`;
    return (
      <section aria-label="Baseline and intervention comparison">
        <h4>Historical baseline and hypothetical interventions</h4>
        <p>
          <a href={refLink(value.baseline.account.id, baseUrl)}>
            Baseline version {value.baseline.account.version}
          </a>{' '}
          · {value.baseline.applicability.endpoint} · {unit}
        </p>
        <p>
          {value.baseline.applicability.occurrence_period.start} to{' '}
          {value.baseline.applicability.occurrence_period.end} ·{' '}
          {value.baseline.applicability.attribution_basis.replaceAll('_', ' ')}
        </p>
        <p>
          {value.lower_budget_verified
            ? 'B has a lower evidenced cost on the same basis.'
            : 'A lower compatible cost for B has not been verified.'}{' '}
          These estimates describe hypothetical avoided damage.
        </p>
        <table>
          <caption>Same baseline, outcome and units; target 10%</caption>
          <thead>
            <tr>
              <th scope="col">Scenario</th>
              <th scope="col">Damage ({unit})</th>
              <th scope="col">Avoided ({unit})</th>
              <th scope="col">Reduction</th>
              <th scope="col">Cost</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Baseline</th>
              <td>{value.baseline.quantity ?? 'Unestimated'}</td>
              <td>—</td>
              <td>—</td>
              <td>—</td>
              <td>Historical</td>
            </tr>
            {value.interventions.map((item) => (
              <tr key={item.id}>
                <th scope="row">{item.id}</th>
                <td>{item.residual_damage ?? 'Unestimated'}</td>
                <td>{item.avoided_damage ?? 'Unestimated'}</td>
                <td>
                  {item.reduction_percent === null
                    ? 'Unestimated'
                    : `${item.reduction_percent.toFixed(2)}%`}
                </td>
                <td>
                  {item.intervention_cost === null
                    ? 'Unestimated'
                    : `${item.intervention_cost} ${item.cost_basis.currency} (${item.cost_basis.price_year})`}
                </td>
                <td>{item.status.replaceAll('_', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {value.interventions.map((item) => (
          <div key={item.id}>
            <h5>Intervention {item.id}</h5>
            <p>
              Cost horizon: {item.cost_basis.horizon.start} to{' '}
              {item.cost_basis.horizon.end}. Monetary net benefit:{' '}
              {item.net_monetary_benefit === null
                ? 'Unestimated'
                : `${item.net_monetary_benefit} ${item.cost_basis.currency} (${item.cost_basis.price_year})`}
            </p>
            <Gaps values={item.assumptions} />
            <Gaps values={item.gaps} />
            <ul>
              {item.evidence.map((ref) => (
                <li key={`${ref.id}:${ref.version}`}>
                  <a href={refLink(ref.id, baseUrl)}>
                    Evidence {ref.id}, version {ref.version}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <Gaps values={value.gaps} />
      </section>
    );
  }
  const plan = planSchema.safeParse(content);
  if (plan.success)
    return (
      <section aria-label="Evidence requirements">
        <h4>Evidence coverage</h4>
        <p>Feasibility: {plan.data.feasibility}</p>
        <ul>
          {plan.data.requirements.map((item) => (
            <li key={item.id}>
              <strong>{item.id.replaceAll('_', ' ')}</strong>: {item.stage} (
              {item.retained_captures.length} retained captures)
              <Gaps values={item.gaps} />
            </li>
          ))}
        </ul>
        <Gaps values={plan.data.gaps} />
      </section>
    );
  const wrapper = z.object({ capture: z.unknown() }).safeParse(content);
  const capture = captureSchema.safeParse(
    wrapper.success ? wrapper.data.capture : content,
  );
  if (capture.success)
    return (
      <section aria-label="Original evidence provenance">
        <h4>Retained original evidence</h4>
        <p>
          <a href={capture.data.source_url} target="_blank" rel="noreferrer">
            {capture.data.source_id}
          </a>{' '}
          · {capture.data.stage} ·{' '}
          {capture.data.evidence_origin.replaceAll('_', ' ')}
        </p>
        <p>
          Retrieved {capture.data.retrieved_at}. Observation period:{' '}
          {capture.data.observation_period
            ? `${capture.data.observation_period.start} to ${capture.data.observation_period.end}`
            : 'unverified'}
          .
        </p>
        <p>
          Original bytes: <code>{capture.data.raw_ref}</code>
        </p>
        <p>Scientific applicability requires a separate review.</p>
        <ul>
          {capture.data.normalized_values.slice(0, 20).map((value, index) => (
            <li key={`${index}:${value.source_locator}`}>
              {value.input}: {value.value} {value.unit} · {value.source_locator}
            </li>
          ))}
        </ul>
        {capture.data.normalized_values.length > 20 ? (
          <p>
            Showing 20 of {capture.data.normalized_values.length} values. The
            exact artifact contains the complete bounded selection.
          </p>
        ) : null}
        <Gaps values={capture.data.gaps} />
      </section>
    );
  return null;
}
