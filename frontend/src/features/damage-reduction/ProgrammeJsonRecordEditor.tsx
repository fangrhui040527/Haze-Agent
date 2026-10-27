import { useState, type FormEvent, type ReactNode } from 'react';
import type { Artifact } from '../../../../app/contracts/artifacts.ts';
import type { ReductionProgrammeSnapshot } from '../../../../app/contracts/damage-reduction-programme.ts';
import { useAgentRun } from '../dashboard/useAgentRun.ts';
import { SourceImport } from '../chat/SourceImport.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { ExactSource } from './ReductionResults.tsx';
import type { ProgrammeMutation } from './ProgrammeEditors.tsx';
import { exactPreviewRef } from './preview-input.ts';
import { pilotValidationMessage } from './pilot-input.ts';
import styles from './DamageReductionPage.module.css';

export function ProgrammeJsonRecordEditor({
  programme,
  pending,
  mutate,
  onError,
  options,
  parseRecord,
  fieldGuide,
  idPrefix,
  title,
  notice,
  guidance,
  supportTitle,
  supportDescription,
}: {
  programme: ReductionProgrammeSnapshot;
  pending: boolean;
  mutate: ProgrammeMutation;
  onError(message: string | null): void;
  options: readonly { kind: string; label: string; guidance: string }[];
  parseRecord(text: string, kind: string): unknown;
  fieldGuide(kind: string): unknown;
  idPrefix: string;
  title: string;
  notice: ReactNode;
  guidance?: ReactNode;
  supportTitle: string;
  supportDescription: string;
}) {
  const run = useAgentRun(undefined, `haze.reduction.${idPrefix}.support`, {
    restoreFromStorage: false,
  });
  const [kind, setKind] = useState(options[0]!.kind);
  const [text, setText] = useState('');
  const [base, setBase] = useState<number | null>(null);
  const [sources, setSources] = useState<Artifact[]>([]);
  const [validation, setValidation] = useState<string | null>(null);
  const stale = base !== null && base !== programme.revision;
  const change = (next: string) => {
    setText(next);
    setValidation(null);
    if (base === null) setBase(programme.revision);
  };
  const validate = () => {
    try {
      parseRecord(text, kind);
      onError(null);
      setValidation(
        'Local structure is valid. The server separately checks exact sources, scope, timing and current applicability.',
      );
    } catch (cause) {
      setValidation(null);
      onError(pilotValidationMessage(cause));
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (new TextEncoder().encode(text).byteLength > 65536)
        throw new Error(
          'Keep one typed record within 64 KiB. Import larger supporting payloads as exact artifacts.',
        );
      const record = parseRecord(text, kind);
      await mutate('record', {
        schema_version: 'haze.reduction.programme.record-request.v1',
        expected_revision: base ?? programme.revision,
        record,
      });
      setText('');
      setBase(null);
      setValidation(null);
    } catch (cause) {
      onError(pilotValidationMessage(cause));
    }
  };
  return (
    <section
      className={styles.card}
      aria-labelledby={`${idPrefix}-record-editor-heading`}
    >
      <h2 id={`${idPrefix}-record-editor-heading`}>{title}</h2>
      <p className={styles.notice}>{notice}</p>
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <label>
          Typed record kind
          <select
            value={kind}
            disabled={pending}
            onChange={(event) => {
              setKind(event.target.value);
              setText('');
              setBase(null);
              setValidation(null);
            }}
          >
            {options.map((option) => (
              <option key={option.kind} value={option.kind}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <p id={`${idPrefix}-record-guidance`}>
          {options.find((option) => option.kind === kind)?.guidance}
        </p>
        <p className={styles.note}>
          Exact artifact references have id, version and sha256. Dates use ISO
          timestamps. Fill actual attester names, times and record UUIDs; the
          editable guide deliberately leaves required attestations blank. Larger
          supporting payloads belong in imported artifacts.
        </p>
        {guidance}
        <div>
          <Button
            disabled={pending}
            onClick={() => change(JSON.stringify(fieldGuide(kind), null, 2))}
          >
            Insert editable field guide
          </Button>
        </div>
        <label>
          Typed record JSON
          <textarea
            value={text}
            onChange={(event) => change(event.target.value)}
            aria-describedby={`${idPrefix}-record-guidance`}
            maxLength={65536}
            rows={16}
            required
            disabled={pending}
            spellCheck={false}
          />
        </label>
        <p>
          Edit base: revision {base ?? programme.revision}. Current programme:
          revision {programme.revision}.
        </p>
        {stale && (
          <p className={styles.notice}>
            The programme changed after this record draft began. Review the
            current programme and clear this draft before appending.
          </p>
        )}
        {validation && <p role="status">{validation}</p>}
        <div className={styles.actions}>
          <Button disabled={pending || !text.trim()} onClick={validate}>
            Validate record structure
          </Button>
          <Button type="submit" disabled={pending || stale || !text.trim()}>
            Append typed record
          </Button>
          <Button
            disabled={pending}
            onClick={() => {
              setText('');
              setBase(null);
              setValidation(null);
            }}
          >
            Clear typed record draft
          </Button>
        </div>
      </form>
      <details>
        <summary>{supportTitle}</summary>
        <p className={styles.note}>{supportDescription}</p>
        <SourceImport
          sources={sources}
          onChange={setSources}
          importSource={run.importSource}
          disabled={pending}
          idPrefix={`${idPrefix}-support`}
          formats={['json']}
          defaultFilename={`${idPrefix}-support.json`}
          attachmentPurpose="Retain an original supporting payload; references must be explicitly included in a typed record."
        />
        {sources.map((source, index) => (
          <div key={source.id}>
            <pre className={styles.sourceText}>
              {JSON.stringify(exactPreviewRef(source), null, 2)}
            </pre>
            <ExactSource
              reference={exactPreviewRef(source)}
              label={`Imported support ${index + 1}`}
            />
          </div>
        ))}
      </details>
    </section>
  );
}
