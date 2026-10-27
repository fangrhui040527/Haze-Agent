import { damageAccountSchema } from '../../contracts/damage-account.js';
import type { FinalRenderer } from '../../orchestration/ports.js';
import { finalAnswerFormat as format } from '../../orchestration/final-answer.js';

const money = (total: {
  scenario_id: string;
  amount: number;
  currency: string;
  price_year: number;
}) =>
  `${total.scenario_id}: ${format.number(total.amount)} ${total.currency} (${total.price_year} prices)`;

/**
 * Physical endpoints are never summed across units, and financial incidence and
 * selected welfare totals stay in separate sections with their price basis.
 */
export const damageAccountFinalRenderer: FinalRenderer = {
  artifact_kinds: ['damage.account'],
  render({ artifacts, reviews }) {
    const sections: ReturnType<FinalRenderer['render']>['sections'] = [];
    const limitations: string[] = [];
    const gaps: string[] = [];
    for (const artifact of artifacts) {
      const account = damageAccountSchema.parse(artifact.content);
      const { scope } = account;
      const review = format.review(reviews, artifact);
      const title = `Damage account ${account.account_id}`;
      sections.push({
        heading: `${title}: scope`,
        lines: [
          `Event ${scope.event_id}; geography ${scope.countries.join(', ')}; population ${scope.population}.`,
          `Effect period ${scope.effect_period.start} to ${scope.effect_period.end}; emissions period ${scope.emissions_period.start} to ${scope.emissions_period.end}.`,
          `Currency ${scope.currency}; price year ${scope.price_year}; valuation date ${scope.valuation_date}.`,
          `Historical scenario ${scope.historical_scenario_id}; baseline ${scope.baseline_scenario_id}.`,
          `Account status ${account.status}; evidence origin ${account.evidence_origin}${account.evidence_origin === 'synthetic' ? ' (synthetic, not a real-data result)' : ''}.`,
          `Independent reconstruction: ${review?.verdict ?? 'not recorded'}; account ${format.ref(artifact)}.`,
        ],
      });
      sections.push({
        heading: `${title}: physical outcomes by endpoint and unit`,
        lines: account.physical_totals.length
          ? account.physical_totals.map(
              (total) =>
                `${total.scenario_id} — ${total.endpoint_id}: ${format.number(total.quantity)} ${total.unit}`,
            )
          : ['No physical total is available for the declared scope.'],
      });
      sections.push({
        heading: `${title}: financial incidence totals`,
        lines: account.financing_totals.length
          ? account.financing_totals.map(money)
          : ['No financial incidence total is available.'],
      });
      sections.push({
        heading: `${title}: selected social-welfare totals`,
        lines: account.welfare_totals.length
          ? account.welfare_totals.map(money)
          : ['No welfare total is available.'],
      });
      if (account.omissions.length) {
        sections.push({
          heading: `${title}: omissions`,
          lines: account.omissions.map(
            (omission) =>
              `${omission.endpoint_id} (${omission.scenario_id}, ${omission.geography}, ${omission.unit}): ${omission.status} — ${omission.reason}`,
          ),
        });
        gaps.push(
          `Damage account ${account.account_id} omits ${account.omissions.length} endpoint record(s); totals exclude them.`,
        );
      }
      if (account.scenarios.length)
        sections.push({
          heading: `${title}: scenario comparisons`,
          lines: account.scenarios.map((comparison) =>
            comparison.status === 'withheld'
              ? `${comparison.scenario_id} vs ${comparison.comparator_id} (${comparison.interpretation}): withheld — ${comparison.limitation ?? 'no limitation recorded'}`
              : `${comparison.scenario_id} vs ${comparison.comparator_id} (${comparison.interpretation}): avoided damage ${format.number(comparison.avoided_damage)} ${comparison.currency}, project cost ${format.number(comparison.project_cost)} ${comparison.currency}, net benefit ${format.number(comparison.net_benefit)} ${comparison.currency} (${comparison.price_year} prices); benefit-cost ratio ${format.number(comparison.benefit_cost_ratio)} (dimensionless); not a cash-return claim`,
          ),
        });
      if (account.status !== 'complete_for_declared_imported_scope')
        gaps.push(
          `Damage account ${account.account_id} is ${account.status} for its declared scope.`,
        );
      limitations.push(
        ...account.limitations,
        ...(review?.limitations ?? []),
        'Arithmetic reconstruction does not establish scientific applicability, causal attribution or legal findings.',
      );
    }
    return { sections, limitations, gaps };
  },
};
