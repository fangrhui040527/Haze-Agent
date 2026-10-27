import { useMemo, useState, type FormEvent } from 'react';
import type { Artifact } from '../../../../app/contracts/artifacts.ts';
import type { ReductionProgrammeView } from '../../../../app/contracts/damage-reduction-programme.ts';
import { useAgentRun } from '../dashboard/useAgentRun.ts';
import { SourceImport } from '../chat/SourceImport.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { ExactSource } from './ReductionResults.tsx';
import type { ProgrammeMutation } from './ProgrammeEditors.tsx';
import { ProgrammeJsonRecordEditor } from './ProgrammeJsonRecordEditor.tsx';
import { exactPreviewRef } from './preview-input.ts';
import { pilotValidationMessage } from './pilot-input.ts';
import {
  EVALUATION_RECORD_TYPES,
  readEvaluationInput,
  readEvaluationDossier,
  parseEvaluationRecord,
  evaluationRecordTemplate,
} from './evaluation-input.ts';
import styles from './DamageReductionPage.module.css';

type Props = {
  view: ReductionProgrammeView;
  pending: boolean;
  mutate: ProgrammeMutation;
  onError(message: string | null): void;
};

export function ProgrammeEvaluationInputEditor({
  view,
  pending,
  mutate,
  onError,
}: Props) {
  const { programme } = view;
  const run = useAgentRun(undefined, 'haze.reduction.evaluation.inputs', {
    restoreFromStorage: false,
  });
  const [inputs, setInputs] = useState<Artifact[]>([]),
    [dossiers, setDossiers] = useState<Artifact[]>([]);
  const [clearInput, setClearInput] = useState(false),
    [clearDossier, setClearDossier] = useState(false);
  const [base, setBase] = useState<number | null>(null),
    [reason, setReason] = useState('');
  const input = useMemo(
    () => (inputs[0] ? readEvaluationInput(inputs[0]) : null),
    [inputs],
  );
  const dossier = useMemo(
    () => (dossiers[0] ? readEvaluationDossier(dossiers[0]) : null),
    [dossiers],
  );
  const touch = () => {
    if (base === null) setBase(programme.revision);
  };
  const reset = () => {
    setInputs([]);
    setDossiers([]);
    setClearInput(false);
    setClearDossier(false);
    setBase(null);
    setReason('');
  };
  const changed =
    !!inputs.length || !!dossiers.length || clearInput || clearDossier;
  const stale = base !== null && base !== programme.revision;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await mutate('revise', {
        schema_version: 'haze.reduction.programme.revise.v1',
        expected_revision: base ?? programme.revision,
        reason,
        ...(clearInput
          ? { evaluation_input_ref: null }
          : inputs[0]
            ? { evaluation_input_ref: exactPreviewRef(inputs[0]) }
            : {}),
        ...(clearDossier
          ? { evaluation_dossier_ref: null }
          : dossiers[0]
            ? { evaluation_dossier_ref: exactPreviewRef(dossiers[0]) }
            : {}),
      });
      reset();
    } catch (cause) {
      onError(pilotValidationMessage(cause));
    }
  };
  return (
    <section
      className={styles.card}
      aria-labelledby="programme-evaluation-input-heading"
    >
      <h2 id="programme-evaluation-input-heading">
        External evaluation inputs and scientific dossier
      </h2>
      <p>
        Import original structured JSON, save an explicit programme revision,
        then separately start evaluation against an exact retained registration.
        A dossier may be absent while numerical checks complete; that does not
        grant a scientific conclusion.
      </p>
      <p className={styles.notice}>
        Engineering fixtures remain synthetic. Operational release requires a
        complete reviewed non-synthetic reference trace. Importing a qualified
        flag never adopts or authenticates scientific qualification.
      </p>
      {programme.evaluation_input_ref ? (
        <ExactSource
          reference={programme.evaluation_input_ref}
          label="Currently selected original external evaluation input"
        />
      ) : (
        <p>No external evaluation input is selected.</p>
      )}
      {programme.evaluation_dossier_ref ? (
        <ExactSource
          reference={programme.evaluation_dossier_ref}
          label="Currently selected scientific qualification dossier"
        />
      ) : (
        <p>No scientific dossier is selected.</p>
      )}
      <details>
        <summary>Select or replace evaluation sources</summary>
        <h3>External comparative input</h3>
        <p className={styles.note}>
          Schema haze.reduction.external-evaluation-input.v1: exact
          programme/target/scope, registration/protocol and delivery records,
          source method/design, comparative decimal estimates, registered
          criterion and uncertainty interpretation, original reports/data,
          external reviews and independently supplied expected outputs.
          Unsupported uncertainty remains a gap.
        </p>
        <SourceImport
          sources={inputs}
          onChange={(next) => {
            if (next.length > 1) {
              onError(
                'Remove the pending evaluation input before importing its replacement.',
              );
              return;
            }
            setInputs(next);
            touch();
          }}
          importSource={async (source, key) => {
            const artifact = await run.importSource(source, key);
            const value = readEvaluationInput(artifact);
            if (value.programme_id !== programme.id)
              throw new Error(
                'The external input identifies another programme.',
              );
            return artifact;
          }}
          disabled={pending || clearInput}
          formats={['json']}
          idPrefix="evaluation-input"
          defaultFilename="external-evaluation-input.json"
          attachmentPurpose="Retain the original external evaluation input; importing does not start a phase."
        />
        {input && (
          <>
            <p>
              Pending input origin: <strong>{input.origin}</strong>; method{' '}
              {input.source_method.id} · {input.source_method.version};
              criterion {input.criterion.kind.replaceAll('_', ' ')}; exact
              registration {input.protocol.registration_id}.
            </p>
            <pre className={styles.sourceText}>
              {JSON.stringify(exactPreviewRef(inputs[0]), null, 2)}
            </pre>
            <ExactSource
              reference={exactPreviewRef(inputs[0])}
              label="Pending exact evaluation input; use this reference in its dossier"
            />
          </>
        )}
        <h3>Optional scientific qualification dossier</h3>
        <p className={styles.note}>
          Schema haze.reduction.scientific-qualification-dossier.v1: exact
          input/method/design/protocol/delivery/evidence, intended use,
          applicability, external reviewer role/independence/conflicts,
          scientific owner, unresolved objections and limitations. Importing the
          dossier and adopting its reviewed decision are separate operations.
        </p>
        <SourceImport
          sources={dossiers}
          onChange={(next) => {
            if (next.length > 1) {
              onError(
                'Remove the pending dossier before importing its replacement.',
              );
              return;
            }
            setDossiers(next);
            touch();
          }}
          importSource={async (source, key) => {
            const artifact = await run.importSource(source, key);
            const value = readEvaluationDossier(artifact);
            if (value.programme_id !== programme.id)
              throw new Error('The dossier identifies another programme.');
            return artifact;
          }}
          disabled={pending || clearDossier}
          formats={['json']}
          idPrefix="evaluation-dossier"
          defaultFilename="scientific-qualification-dossier.json"
          attachmentPurpose="Retain a supplied dossier; imported flags cannot grant qualification."
        />
        {dossier && (
          <>
            <p>
              Pending dossier origin: <strong>{dossier.origin}</strong>;
              imported decision {dossier.decision}; applicability{' '}
              {dossier.applicability.decision}. This is unadopted supplied
              input.
            </p>
            <ExactSource
              reference={exactPreviewRef(dossiers[0])}
              label="Pending exact scientific dossier awaiting explicit revision"
            />
          </>
        )}
        <form className={styles.form} onSubmit={(event) => void submit(event)}>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={clearInput}
              disabled={pending}
              onChange={(event) => {
                setClearInput(event.target.checked);
                touch();
              }}
            />
            Explicitly clear the selected external evaluation input
          </label>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={clearDossier}
              disabled={pending}
              onChange={(event) => {
                setClearDossier(event.target.checked);
                touch();
              }}
            />
            Explicitly clear the selected scientific dossier
          </label>
          <label>
            Reason for evaluation input revision
            <textarea
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                touch();
              }}
              maxLength={4096}
              rows={2}
              required
              disabled={pending}
            />
          </label>
          <p>
            Edit base: revision {base ?? programme.revision}. Current programme:
            revision {programme.revision}.
          </p>
          {stale && (
            <p className={styles.notice}>
              The programme changed. Review the current selection and clear this
              draft before saving.
            </p>
          )}
          <div className={styles.actions}>
            <Button
              type="submit"
              disabled={pending || stale || !changed || !reason.trim()}
            >
              Save evaluation-input revision
            </Button>
            <Button disabled={pending} onClick={reset}>
              Clear evaluation-input draft
            </Button>
          </div>
        </form>
      </details>
    </section>
  );
}

export function ProgrammeEvaluationRecordEditor({
  view,
  pending,
  mutate,
  onError,
}: Props) {
  const current = view.evaluation?.current;
  return (
    <ProgrammeJsonRecordEditor
      programme={view.programme}
      pending={pending}
      mutate={mutate}
      onError={onError}
      options={EVALUATION_RECORD_TYPES}
      parseRecord={parseEvaluationRecord}
      fieldGuide={(kind) =>
        evaluationRecordTemplate(kind, {
          result: current?.result?.artifact ?? null,
          review: current?.review?.artifact ?? null,
          dossier: view.programme.evaluation_dossier_ref ?? null,
        })
      }
      idPrefix="evaluation"
      title="Record scientific adoption, withdrawal or objections"
      notice="A human attestation records local adoption or withdrawal. The server rechecks exact qualification, independence, current evidence, delivery and objections; neither this form nor an imported status grants an evaluated-effect claim."
      supportTitle="Import supporting evaluation, review or objection evidence JSON"
      supportDescription="Retain original supporting payloads, then explicitly reference them in an evaluation input, scientific dossier or typed record. Importing alone does not adopt qualification or resolve an objection."
    />
  );
}
