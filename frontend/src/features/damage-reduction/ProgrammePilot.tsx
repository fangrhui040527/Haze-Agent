import { useMemo, useState, type FormEvent } from 'react';
import type { Artifact } from '../../../../app/contracts/artifacts.ts';
import type { PilotTaskView } from '../../../../app/contracts/damage-reduction-pilot.ts';
import { syntheticPilotInputExample } from '../../../../app/contracts/damage-reduction-pilot.ts';
import type { ReductionProgrammeView } from '../../../../app/contracts/damage-reduction-programme.ts';
import { useAgentRun } from '../dashboard/useAgentRun.ts';
import { SourceImport, sourceImportFromFile } from '../chat/SourceImport.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { ExactSource } from './ReductionResults.tsx';
import type { ProgrammeMutation } from './ProgrammeEditors.tsx';
import { exactPreviewRef } from './preview-input.ts';
import {
  PILOT_RECORD_TYPES,
  parsePilotRecord,
  pilotRecordTemplate,
  pilotValidationMessage,
  readPilotInputSource,
  type PilotRecordKind,
} from './pilot-input.ts';
import styles from './DamageReductionPage.module.css';
import { ProgrammeJsonRecordEditor } from './ProgrammeJsonRecordEditor.tsx';

type EditorProps = {
  view: ReductionProgrammeView;
  pending: boolean;
  mutate: ProgrammeMutation;
  onError(message: string | null): void;
};

export function ProgrammePilotInputEditor({
  view,
  pending,
  mutate,
  onError,
}: EditorProps) {
  const { programme } = view;
  const run = useAgentRun(undefined, 'haze.reduction.pilot.input', {
    restoreFromStorage: false,
  });
  const [sources, setSources] = useState<Artifact[]>([]);
  const [base, setBase] = useState<number | null>(null);
  const [clear, setClear] = useState(false);
  const [reason, setReason] = useState('');
  const [importing, setImporting] = useState(false);
  const loadExample = async () => {
    setImporting(true);
    try {
      const input = syntheticPilotInputExample(
        programme.preview.selection.target,
        programme.preview.candidate.kind,
      );
      const original = await sourceImportFromFile(
        new File(
          [JSON.stringify(input, null, 2)],
          'synthetic-pilot-input.json',
          { type: 'application/json' },
        ),
      );
      const artifact = await run.importSource(original, crypto.randomUUID());
      readPilotInputSource(artifact);
      setSources([artifact]);
      if (base === null) setBase(programme.revision);
    } catch (cause) {
      onError(pilotValidationMessage(cause));
    } finally {
      setImporting(false);
    }
  };
  const source = sources[0];
  const selectedOrigin = useMemo(
    () => (source ? readPilotInputSource(source).origin : null),
    [source],
  );
  const stale = base !== null && base !== programme.revision;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (!clear && !source)
        throw new Error('Import one supplied pilot-input JSON artifact first.');
      if (source && !clear) readPilotInputSource(source);
      await mutate('revise', {
        schema_version: 'haze.reduction.programme.revise.v1',
        expected_revision: base ?? programme.revision,
        reason,
        pilot_input_ref: clear ? null : exactPreviewRef(source),
      });
      setSources([]);
      setBase(null);
      setClear(false);
      setReason('');
    } catch (cause) {
      onError(pilotValidationMessage(cause));
    }
  };
  return (
    <section
      className={styles.card}
      aria-labelledby="programme-pilot-input-heading"
    >
      <h2 id="programme-pilot-input-heading">Supplied pilot inputs</h2>
      <p>
        Import original pilot-input JSON, save an explicit programme revision,
        then separately start a pilot draft. Importing or saving inputs executes
        no pilot or digital action.
      </p>
      <p className={styles.note}>
        Schema: haze.reduction.pilot-input.v1. Supply origin, scientific owner,
        intended kind, design-specific findings and calculations, assumptions,
        scientific design review and protocol specification. Missing science
        stays a prerequisite; no case-specific estimates are filled
        automatically.
      </p>
      {programme.pilot_input_ref ? (
        <ExactSource
          reference={programme.pilot_input_ref}
          label="Currently selected exact pilot-input artifact"
        />
      ) : (
        <p>No pilot-input artifact is selected.</p>
      )}
      <details>
        <summary>Select or replace pilot inputs</summary>
        <div className={styles.actions}>
          <Button
            disabled={pending || importing || clear || !!sources.length}
            onClick={() => void loadExample()}
          >
            Load synthetic pilot-input example
          </Button>
        </div>
        <p className={styles.note}>
          The explicit example copies only the declared target scope and leaves
          scientific findings unknown. It remains synthetic, unqualified and
          disabled for live execution. Edit the JSON to supply reviewed inputs;
          do not relabel a fixture as empirical evidence.
        </p>
        <SourceImport
          sources={sources}
          onChange={(next) => {
            if (next.length > 1) {
              onError(
                'Remove the selected pilot input before importing its replacement.',
              );
              return;
            }
            setSources(next);
            if (base === null) setBase(programme.revision);
          }}
          importSource={async (input, key) => {
            const artifact = await run.importSource(input, key);
            readPilotInputSource(artifact);
            return artifact;
          }}
          disabled={pending || importing || clear}
          idPrefix="pilot-input"
          formats={['json']}
          defaultFilename="pilot-input.json"
          attachmentPurpose="Retain a supplied pilot-input payload. This does not register a protocol."
        />
        {source && (
          <>
            <p>
              Validated pilot input origin: <strong>{selectedOrigin}</strong>.
            </p>
            <ExactSource
              reference={exactPreviewRef(source)}
              label="Selected pilot input awaiting explicit revision"
            />
          </>
        )}
        <form className={styles.form} onSubmit={(event) => void submit(event)}>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={clear}
              disabled={pending || importing}
              onChange={(event) => {
                setClear(event.target.checked);
                if (base === null) setBase(programme.revision);
              }}
            />
            Explicitly clear the selected pilot-input reference
          </label>
          <label>
            Reason for the pilot-input revision
            <textarea
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                if (base === null) setBase(programme.revision);
              }}
              maxLength={4096}
              rows={2}
              required
              disabled={pending || importing}
            />
          </label>
          <p>
            Edit base: revision {base ?? programme.revision}. Current programme:
            revision {programme.revision}.
          </p>
          {stale && (
            <p className={styles.notice}>
              The programme changed. Review current inputs and clear this draft
              before saving.
            </p>
          )}
          <div className={styles.actions}>
            <Button
              type="submit"
              disabled={
                pending ||
                importing ||
                stale ||
                (!clear && !source) ||
                !reason.trim()
              }
            >
              Save pilot-input revision
            </Button>
            <Button
              disabled={pending || importing}
              onClick={() => {
                setSources([]);
                setBase(null);
                setClear(false);
                setReason('');
              }}
            >
              Clear pilot-input draft
            </Button>
          </div>
        </form>
      </details>
    </section>
  );
}

export function ProgrammePilotRecordEditor({
  view,
  pending,
  mutate,
  onError,
}: EditorProps) {
  const draft: PilotTaskView | null =
    [...view.attempts]
      .reverse()
      .find(
        (entry) =>
          entry.attempt.phase === 'pilot' &&
          entry.currency === 'current' &&
          entry.execution_status === 'completed' &&
          entry.pilot?.state === 'current' &&
          entry.pilot.review?.value.verdict === 'supported',
      )?.pilot ?? null;
  return (
    <ProgrammeJsonRecordEditor
      programme={view.programme}
      pending={pending}
      mutate={mutate}
      onError={onError}
      options={PILOT_RECORD_TYPES}
      parseRecord={(text, kind) =>
        parsePilotRecord(text, kind as PilotRecordKind)
      }
      fieldGuide={(kind) =>
        pilotRecordTemplate(kind as PilotRecordKind, view.programme, draft)
      }
      idPrefix="pilot"
      title="Append a pilot or delivery record"
      notice="Live execution is deferred. These append-only records register attestations or imported evidence. They send no alert and apply no schedule. All mutations use the edit revision and an idempotency key."
      guidance={
        <p className={styles.note}>
          Action payload versions and the exact permitted action must match the
          supplied receipt. Receipts and independent verification bind the same
          trigger references, action version, rule and operating scope; a
          generic receipt cannot confirm a different action.
        </p>
      }
      supportTitle="Import supporting receipt, registration or verification JSON"
      supportDescription="Importing supporting evidence does not append an event, register a protocol or confirm delivery. Copy its exact reference into a typed record, then explicitly append that record."
    />
  );
}
