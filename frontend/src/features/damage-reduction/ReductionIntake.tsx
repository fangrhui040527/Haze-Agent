import {
  useState,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
} from 'react';
import type {
  Artifact,
  ArtifactRef,
} from '../../../../app/contracts/artifacts.ts';
import { reductionScopeSchema } from '../../../../app/contracts/damage-reduction.ts';
import type {
  ReductionCandidate,
  ReductionPreviewRequest,
} from '../../../../app/contracts/damage-reduction-plan.ts';
import { syntheticResidualImport } from '../../../../app/capabilities/damage-reduction-planning/fixtures.ts';
import { syntheticReductionCandidate } from '../../../../app/capabilities/damage-reduction-planning/planning-fixtures.ts';
import type { AgentRun } from '../dashboard/useAgentRun.ts';
import { SourceImport, sourceImportFromFile } from '../chat/SourceImport.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import {
  blankCandidate,
  createPreviewRequest,
  exactPreviewRef,
  readResidualSource,
  proposeEditedCandidate,
  targetFromSources,
} from './preview-input.ts';
import styles from './DamageReductionPage.module.css';

const nullable = (value: string) => value || null;

export function ReductionIntake({
  run,
  onError,
  onSubmitPreview,
  submitLabel = 'Create conditional preview',
  initialPreview,
  initialSources = [],
  children,
  detailsHeading = 'Request details',
  disabled = false,
}: {
  run: AgentRun;
  onError(message: string | null): void;
  onSubmitPreview?(
    preview: ReductionPreviewRequest,
    contextRefs: ArtifactRef[],
  ): Promise<void>;
  submitLabel?: string;
  initialPreview?: ReductionPreviewRequest;
  initialSources?: Artifact[];
  children?: ReactNode;
  detailsHeading?: string;
  disabled?: boolean;
}) {
  const [sources, setSources] = useState<Artifact[]>(initialSources);
  const [selected, setSelected] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      initialPreview?.selection.sources.map((source) => [
        source.artifact.id,
        source.row_ids,
      ]) ?? [],
    ),
  );
  const [scopeText, setScopeText] = useState(() =>
    initialPreview
      ? JSON.stringify(initialPreview.selection.target.scope, null, 2)
      : '',
  );
  const [comparator, setComparator] = useState(
    initialPreview?.selection.target.comparator ?? '',
  );
  const [intervention, setIntervention] = useState(
    initialPreview?.selection.target.intervention ?? '',
  );
  const [fraction, setFraction] = useState(
    initialPreview?.selection.target.target_fraction ?? '0.1',
  );
  const [relation, setRelation] = useState<'at_least' | 'greater_than'>(
    initialPreview?.selection.target.relation ?? 'at_least',
  );
  const [candidate, updateCandidate] = useState<ReductionCandidate>(
    () => initialPreview?.candidate ?? blankCandidate(''),
  );
  const setCandidate = (action: SetStateAction<ReductionCandidate>) =>
    updateCandidate((current) =>
      proposeEditedCandidate(
        typeof action === 'function' ? action(current) : action,
      ),
    );
  const [submitting, setSubmitting] = useState(false);
  const busy =
    disabled || submitting || run.operationPending || run.status === 'running';
  const imported = sources.map((source) => ({
    source,
    data: readResidualSource(source),
  }));
  const changeSources = (next: Artifact[]) => {
    try {
      for (const source of next) readResidualSource(source);
      if (next.length > 16)
        throw new Error('A preview supports at most 16 original sources.');
      const target = targetFromSources(next);
      if (target && (!sources.length || !scopeText)) {
        setScopeText(JSON.stringify(target.scope, null, 2));
        setComparator(target.comparator);
        setIntervention(target.intervention);
        setCandidate((current) => ({ ...current, name: target.intervention }));
      }
      setSources(next);
      setSelected((current) =>
        Object.fromEntries(
          next.map((source) => [
            source.id,
            current[source.id] ??
              readResidualSource(source).records.map((row) => row.row_id),
          ]),
        ),
      );
      onError(null);
    } catch (cause) {
      onError(
        cause instanceof Error
          ? cause.message
          : 'The physical source could not be read.',
      );
    }
  };
  const syntheticExample = async () => {
    setSubmitting(true);
    onError(null);
    try {
      const source = await run.importSource(
        {
          ...(await sourceImportFromFile(
            new File(
              [JSON.stringify(syntheticResidualImport())],
              'synthetic-residual-scenario.json',
            ),
          )),
          declared_origin:
            'Explicit synthetic engineering example. No empirical or scientific applicability evidence.',
        },
        crypto.randomUUID(),
      );
      const target = targetFromSources([source])!;
      setSources([source]);
      setSelected({
        [source.id]: readResidualSource(source).records.map(
          (row) => row.row_id,
        ),
      });
      setScopeText(JSON.stringify(target.scope, null, 2));
      setComparator(target.comparator);
      setIntervention(target.intervention);
      setCandidate(syntheticReductionCandidate());
      setFraction('0.1');
      setRelation('at_least');
    } catch (cause) {
      onError(
        cause instanceof Error
          ? cause.message
          : 'The synthetic source could not be imported.',
      );
    } finally {
      setSubmitting(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    onError(null);
    setSubmitting(true);
    try {
      const scope = await createPreviewRequest(
        {
          scope: reductionScopeSchema.parse(JSON.parse(scopeText)),
          target_fraction: fraction,
          relation,
          comparator,
          intervention,
          assessment_rule: 'point_estimate',
        },
        {
          ...candidate,
          name: intervention,
          rule_owner: candidate.rule_owner?.trim() || null,
          trigger_rule: candidate.trigger_rule?.trim() || null,
          action_rule: candidate.action_rule?.trim() || null,
        },
        sources
          .map((source) => ({
            artifact: exactPreviewRef(source),
            row_ids: selected[source.id] ?? [],
          }))
          .filter((source) => source.row_ids.length),
      );
      if (onSubmitPreview) {
        await onSubmitPreview(scope, sources.map(exactPreviewRef));
      } else
        await run.ask({
          question:
            'Prepare a reviewed conditional damage-reduction planning preview from the explicitly selected supplied scenario and digital intervention. Preserve prerequisites, objections and scientific qualification limits.',
          focusItemId: null,
          contextRefs: sources.map(exactPreviewRef),
          scope,
        });
    } catch (cause) {
      if (!(cause instanceof Error && cause.name === 'AbortError'))
        onError(
          cause instanceof Error
            ? cause.message
            : 'The planning task could not be started.',
        );
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <form
      className={styles.form}
      onSubmit={(event) => void submit(event)}
      aria-label="Create a conditional planning preview"
    >
      {children && (
        <fieldset disabled={busy} className={styles.fieldset}>
          <legend>{detailsHeading}</legend>
          {children}
        </fieldset>
      )}
      <div className={styles.actions}>
        <Button onClick={() => void syntheticExample()} disabled={busy}>
          Load synthetic engineering example
        </Button>
        <span className={styles.note}>
          Examples remain visibly synthetic and unqualified.
        </span>
      </div>
      <fieldset disabled={busy} className={styles.fieldset}>
        <legend>Supplied physical scenario evidence</legend>
        <p>
          Import original residual estimates with decimal strings. Select the
          numerical rows below; the server checks compatibility and overlap.
        </p>
        <SourceImport
          sources={sources}
          onChange={changeSources}
          importSource={run.importSource}
          disabled={busy || sources.length >= 16}
          idPrefix="reduction"
          formats={['json']}
          defaultFilename="physical-residuals.json"
          required
          attachmentPurpose="Only explicitly selected rows supply numerical quantities."
        />
        {imported.map(({ source, data }) => (
          <div key={source.id} className={styles.source}>
            <h3>
              {source.filename ?? 'Original physical source'}{' '}
              <span className={styles.note}>({data.origin})</span>
            </h3>
            <p className={styles.identifier}>
              Original version {source.version} · SHA-256 {source.sha256}
            </p>
            <div className={styles.tableWrap}>
              <table>
                <caption>Selected numerical rows from this original</caption>
                <thead>
                  <tr>
                    <th scope="col">Include</th>
                    <th scope="col">Role / row</th>
                    <th scope="col">Supplied quantity</th>
                    <th scope="col">Scenario / evidence basis</th>
                  </tr>
                </thead>
                <tbody>
                  {data.records.map((row) => (
                    <tr key={row.row_id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${row.row_id} from ${source.filename ?? source.id}`}
                          checked={
                            selected[source.id]?.includes(row.row_id) ?? false
                          }
                          onChange={(event) =>
                            setSelected((current) => ({
                              ...current,
                              [source.id]: event.target.checked
                                ? [...(current[source.id] ?? []), row.row_id]
                                : (current[source.id] ?? []).filter(
                                    (id) => id !== row.row_id,
                                  ),
                            }))
                          }
                        />
                      </td>
                      <th scope="row">
                        {row.role}
                        <br />
                        <span className={styles.identifier}>{row.row_id}</span>
                      </th>
                      <td>
                        {row.quantity ?? 'Unknown'} {row.scope.unit}
                      </td>
                      <td>
                        {row.scenario}
                        <br />
                        {row.evidence_basis}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </fieldset>
      <fieldset disabled={busy} className={styles.fieldset}>
        <legend id="reduction-target-heading">Target</legend>
        <div className={styles.twoColumn}>
          <label>
            Ordinary-management comparator
            <input
              value={comparator}
              onChange={(event) => setComparator(event.target.value)}
              maxLength={4096}
              required
            />
          </label>
          <label>
            One digital intervention
            <input
              value={intervention}
              onChange={(event) => {
                setIntervention(event.target.value);
                setCandidate((current) => ({
                  ...current,
                  name: event.target.value,
                }));
              }}
              maxLength={4096}
              required
            />
          </label>
          <label>
            Target fraction (0.1 = 10%)
            <input
              value={fraction}
              onChange={(event) => setFraction(event.target.value)}
              inputMode="decimal"
              maxLength={33}
              required
            />
          </label>
          <label>
            Threshold relation
            <select
              value={relation}
              onChange={(event) =>
                setRelation(event.target.value as typeof relation)
              }
            >
              <option value="at_least">At least (inclusive)</option>
              <option value="greater_than">Strictly greater than</option>
            </select>
          </label>
        </div>
        <details open={!scopeText}>
          <summary>Physical endpoint and affected scope</summary>
          <p className={styles.note}>
            The scope is copied from the supplied baseline for review. Changing
            it does not relabel the original evidence.
          </p>
          <label htmlFor="reduction-scope">Target scope JSON</label>
          <textarea
            id="reduction-scope"
            value={scopeText}
            onChange={(event) => {
              setScopeText(event.target.value);
              setCandidate((current) => current);
            }}
            rows={10}
            maxLength={50000}
            required
          />
        </details>
      </fieldset>
      <fieldset disabled={busy} className={styles.fieldset}>
        <legend>Proposed digital action and rules</legend>
        <p className={styles.note}>
          Missing rules, costs or capacity become prerequisites. This preview
          sends no alerts and applies no schedules.
        </p>
        <div className={styles.twoColumn}>
          <label>
            Digital action
            <select
              value={candidate.kind}
              onChange={(event) =>
                setCandidate((current) => ({
                  ...current,
                  kind: event.target.value as ReductionCandidate['kind'],
                }))
              }
            >
              <option value="exposure_alert">Exposure alerts</option>
              <option value="work_schedule">Work-schedule changes</option>
            </select>
          </label>
          <label>
            Rule owner
            <input
              value={candidate.rule_owner ?? ''}
              onChange={(event) =>
                setCandidate((current) => ({
                  ...current,
                  rule_owner: nullable(event.target.value),
                }))
              }
              maxLength={4096}
              placeholder="Unknown until assigned"
            />
          </label>
        </div>
        <label>
          Intervention description
          <textarea
            value={candidate.description}
            onChange={(event) =>
              setCandidate((current) => ({
                ...current,
                description: event.target.value,
              }))
            }
            rows={2}
            maxLength={4096}
            required
          />
        </label>
        <label>
          Proposed trigger rule
          <textarea
            value={candidate.trigger_rule ?? ''}
            onChange={(event) =>
              setCandidate((current) => ({
                ...current,
                trigger_rule: nullable(event.target.value),
              }))
            }
            rows={2}
            maxLength={4096}
            placeholder="What exact supplied conditions would trigger the service?"
          />
        </label>
        <label>
          Proposed action rule
          <textarea
            value={candidate.action_rule ?? ''}
            onChange={(event) =>
              setCandidate((current) => ({
                ...current,
                action_rule: nullable(event.target.value),
              }))
            }
            rows={2}
            maxLength={4096}
            placeholder="Who is affected and what exact action would occur?"
          />
        </label>
        <p>
          {candidate.approval.status === 'approved'
            ? `Recorded human-approval attestation: ${candidate.approval.approver ?? 'unspecified approver'}, ${candidate.approval.approved_at ?? 'time not supplied'}.`
            : 'Human approval: proposed, not approved.'}{' '}
          Editing candidate details or affected scope marks the rule draft
          proposed and requires fresh human review before future delivery.
        </p>
      </fieldset>
      <fieldset disabled={busy} className={styles.fieldset}>
        <legend>Constraints, costs and capacity</legend>
        <p className={styles.note}>
          Include subgroup protections. A hard violation blocks a recommendation
          even when the numerical target is met. Unverified availability remains
          a prerequisite.
        </p>
        {candidate.constraints.map((constraint, index) => (
          <div key={constraint.id} className={styles.item}>
            <label>
              Constraint {index + 1}
              <input
                value={constraint.description}
                onChange={(event) =>
                  setCandidate((current) => ({
                    ...current,
                    constraints: current.constraints.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, description: event.target.value }
                        : item,
                    ),
                  }))
                }
                maxLength={4096}
                required
              />
            </label>
            <div className={styles.actions}>
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={constraint.hard}
                  onChange={(event) =>
                    setCandidate((current) => ({
                      ...current,
                      constraints: current.constraints.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, hard: event.target.checked }
                          : item,
                      ),
                    }))
                  }
                />
                Hard constraint
              </label>
              <label>
                Status
                <select
                  value={constraint.status}
                  onChange={(event) =>
                    setCandidate((current) => ({
                      ...current,
                      constraints: current.constraints.map((item, itemIndex) =>
                        itemIndex === index
                          ? {
                              ...item,
                              status: event.target.value as typeof item.status,
                            }
                          : item,
                      ),
                    }))
                  }
                >
                  <option value="unknown">Unknown</option>
                  <option value="violated">Violated</option>
                  <option value="satisfied">
                    Reported satisfied (evidence needed)
                  </option>
                </select>
              </label>
              <Button
                onClick={() =>
                  setCandidate((current) => ({
                    ...current,
                    constraints: current.constraints.filter(
                      (_, itemIndex) => itemIndex !== index,
                    ),
                  }))
                }
              >
                Remove constraint {index + 1}
              </Button>
            </div>
          </div>
        ))}
        <div>
          <Button
            disabled={candidate.constraints.length >= 16}
            onClick={() =>
              setCandidate((current) => ({
                ...current,
                constraints: [
                  ...current.constraints,
                  {
                    id: crypto.randomUUID(),
                    description: '',
                    hard: true,
                    status: 'unknown',
                    evidence: [],
                  },
                ],
              }))
            }
          >
            Add hard or subgroup constraint
          </Button>
        </div>
        <label>
          Cost and resource requirements
          <textarea
            value={candidate.costs[0]?.description ?? ''}
            onChange={(event) =>
              setCandidate((current) => ({
                ...current,
                costs: event.target.value.trim()
                  ? [
                      {
                        id: 'service-cost',
                        description: event.target.value,
                        amount: null,
                        unit: 'unpriced',
                        evidence: [],
                        prerequisite:
                          'Obtain a scoped cost estimate and budget decision.',
                      },
                    ]
                  : [],
              }))
            }
            rows={2}
            maxLength={4096}
            placeholder="Unknown costs stay unpriced; no available budget is assumed."
          />
        </label>
        <label>
          Service dependencies and capacity
          <textarea
            value={candidate.dependencies[0]?.description ?? ''}
            onChange={(event) =>
              setCandidate((current) => ({
                ...current,
                dependencies: event.target.value.trim()
                  ? [
                      {
                        id: 'service-capacity',
                        description: event.target.value,
                        status: 'unknown',
                        evidence: [],
                      },
                    ]
                  : [],
              }))
            }
            rows={2}
            maxLength={4096}
            placeholder="For example, authorized recipient list, service integration and staffing."
          />
        </label>
      </fieldset>
      <div className={styles.actions}>
        <Button
          type="submit"
          variant="primary"
          disabled={
            busy ||
            !sources.length ||
            !scopeText ||
            !comparator.trim() ||
            !intervention.trim()
          }
        >
          {submitLabel}
        </Button>
        <span className={styles.note}>
          Scientific qualification remains unqualified. No action is delivered.
        </span>
      </div>
    </form>
  );
}
