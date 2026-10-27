import { useState, type FormEvent } from 'react';
import type { Artifact } from '../../../../app/contracts/artifacts.ts';
import type { ReductionPreviewRequest } from '../../../../app/contracts/damage-reduction-plan.ts';
import {
  reductionProgrammeRecordRequestSchema,
  reductionProgrammeRevisionRequestSchema,
  type ReductionProgrammeMutationReceipt,
  type ReductionProgrammeSnapshot,
} from '../../../../app/contracts/damage-reduction-programme.ts';
import { agentService } from '../../services/agents/index.ts';
import { useAgentRun } from '../dashboard/useAgentRun.ts';
import { SourceImport } from '../chat/SourceImport.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { ExactSource } from './ReductionResults.tsx';
import { ReductionIntake } from './ReductionIntake.tsx';
import { exactPreviewRef, readResidualSource } from './preview-input.ts';
import styles from './DamageReductionPage.module.css';

export type ProgrammeMutation = (
  operation: 'revise' | 'record' | 'phase',
  body: unknown,
) => Promise<ReductionProgrammeMutationReceipt>;

export function ProgrammeMetadataEditor({
  programme,
  pending,
  mutate,
  onError,
}: {
  programme: ReductionProgrammeSnapshot;
  pending: boolean;
  mutate: ProgrammeMutation;
  onError(message: string | null): void;
}) {
  const [base, setBase] = useState(programme.revision);
  const [reason, setReason] = useState('');
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState('');
  const [scientificOwner, setScientificOwner] = useState('');
  const [clearScientificOwner, setClearScientificOwner] = useState(false);
  const [reviseBudget, setReviseBudget] = useState(false);
  const [budget, setBudget] = useState(() => ({ ...programme.budget }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const result = await mutate(
        'revise',
        reductionProgrammeRevisionRequestSchema.parse({
          schema_version: 'haze.reduction.programme.revise.v1',
          expected_revision: base,
          reason,
          ...(title.trim() ? { title } : {}),
          ...(owner.trim() ? { accountable_owner: owner } : {}),
          ...(clearScientificOwner
            ? { scientific_owner: null }
            : scientificOwner.trim()
              ? { scientific_owner: scientificOwner }
              : {}),
          ...(reviseBudget ? { budget } : {}),
        }),
      );
      setBase(result.revision);
      setReason('');
      setTitle('');
      setOwner('');
      setScientificOwner('');
      setClearScientificOwner(false);
      setReviseBudget(false);
    } catch (cause) {
      onError(
        cause instanceof Error
          ? cause.message
          : 'The programme revision was not confirmed.',
      );
    }
  };
  return (
    <details className={styles.card}>
      <summary>Revise programme title, recorded owners or ceilings</summary>
      <p className={styles.note}>
        Unchanged fields are omitted. Owner names are local attestations;
        scientific qualification remains separate.
      </p>
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <p>
          Edit base: revision {base}. Current programme: revision{' '}
          {programme.revision}.
        </p>
        {base !== programme.revision && (
          <p className={styles.notice}>
            The programme changed. Refresh the edit base before saving to avoid
            overwriting an unseen revision.
          </p>
        )}
        <Button
          size="small"
          disabled={pending}
          onClick={() => {
            setBase(programme.revision);
            setReason('');
            setTitle('');
            setOwner('');
            setScientificOwner('');
            setClearScientificOwner(false);
            setReviseBudget(false);
            setBudget({ ...programme.budget });
          }}
        >
          Refresh edit base and clear draft
        </Button>
        <label>
          New programme title
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={256}
            disabled={pending}
            placeholder={programme.title}
          />
        </label>
        <label>
          New accountable owner
          <input
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
            maxLength={4096}
            disabled={pending}
            placeholder={programme.accountable_owner}
          />
        </label>
        <label>
          New scientific owner
          <input
            value={scientificOwner}
            onChange={(event) => setScientificOwner(event.target.value)}
            maxLength={4096}
            disabled={pending || clearScientificOwner}
            placeholder={programme.scientific_owner ?? 'Not supplied'}
          />
        </label>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={clearScientificOwner}
            onChange={(event) => setClearScientificOwner(event.target.checked)}
            disabled={pending}
          />
          Clear the recorded scientific owner
        </label>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={reviseBudget}
            onChange={(event) => setReviseBudget(event.target.checked)}
            disabled={pending}
          />
          Revise programme ceilings
        </label>
        {reviseBudget && (
          <fieldset disabled={pending} className={styles.fieldset}>
            <legend>Explicit revised resource ceilings</legend>
            <p className={styles.note}>
              Existing charged and reserved use remains authoritative. The
              server rejects limits that cannot cover retained commitments or
              exceed runtime ceilings.
            </p>
            <div className={styles.twoColumn}>
              {(
                [
                  ['max_model_calls', 'Maximum model calls', 0, 400],
                  ['max_tool_calls', 'Maximum tool calls', 0, 400],
                  ['max_runs', 'Maximum admitted runs', 1, 12],
                  [
                    'max_attempts_per_phase',
                    'Maximum attempts per phase',
                    1,
                    3,
                  ],
                ] as const
              ).map(([field, label, minimum, maximum]) => (
                <label key={field}>
                  {label}
                  <input
                    type="number"
                    value={budget[field]}
                    min={minimum}
                    max={maximum}
                    step={1}
                    required
                    onChange={(event) =>
                      setBudget((value) => ({
                        ...value,
                        [field]: Number(event.target.value),
                      }))
                    }
                  />
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <label>
          Reason for this revision
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={4096}
            rows={2}
            required
            disabled={pending}
          />
        </label>
        <div>
          <Button
            type="submit"
            disabled={
              pending ||
              base !== programme.revision ||
              !reason.trim() ||
              !(
                title.trim() ||
                owner.trim() ||
                scientificOwner.trim() ||
                clearScientificOwner ||
                reviseBudget
              )
            }
          >
            Save metadata revision
          </Button>
        </div>
      </form>
    </details>
  );
}

export function ProgrammeInputEditor({
  programme,
  pending,
  mutate,
  onError,
}: {
  programme: ReductionProgrammeSnapshot;
  pending: boolean;
  mutate: ProgrammeMutation;
  onError(message: string | null): void;
}) {
  const run = useAgentRun(undefined, 'haze.reduction.programme.revision', {
    restoreFromStorage: false,
  });
  const [loaded, setLoaded] = useState<{
    revision: number;
    preview: ReductionPreviewRequest;
    sources: Artifact[];
    editId: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [reason, setReason] = useState('');
  const load = async () => {
    setLoading(true);
    onError(null);
    try {
      if (!agentService.readArtifact)
        throw new Error('Exact original retrieval is unavailable.');
      const sources = await Promise.all(
        programme.preview.selection.sources.map(
          async ({ artifact: reference }) => {
            const artifact = await agentService.readArtifact!(reference.id);
            if (
              artifact.version !== reference.version ||
              artifact.sha256 !== reference.sha256
            )
              throw new Error(
                'A programme original no longer matches its exact version/hash.',
              );
            readResidualSource(artifact);
            return artifact;
          },
        ),
      );
      setLoaded({
        revision: programme.revision,
        preview: programme.preview,
        sources,
        editId: crypto.randomUUID(),
      });
      setReason('');
    } catch (cause) {
      onError(
        cause instanceof Error
          ? cause.message
          : 'Programme inputs are unavailable.',
      );
    } finally {
      setLoading(false);
    }
  };
  const revise = async (preview: ReductionPreviewRequest) => {
    if (!loaded)
      throw new Error(
        'Load the current exact programme inputs before editing.',
      );
    await mutate(
      'revise',
      reductionProgrammeRevisionRequestSchema.parse({
        schema_version: 'haze.reduction.programme.revise.v1',
        expected_revision: loaded.revision,
        reason,
        preview,
      }),
    );
    setLoaded(null);
    setReason('');
  };
  return (
    <details className={styles.card}>
      <summary>
        Revise the target, selected evidence or proposed digital rules
      </summary>
      <p className={styles.note}>
        Material changes can stale affected assessments and plans. Previous
        exact runs and artifacts remain in history. A revision starts no new
        phase.
      </p>
      <div>
        <Button disabled={pending || loading} onClick={() => void load()}>
          {loading
            ? 'Checking original access…'
            : 'Load current exact inputs for editing'}
        </Button>
        <Button
          disabled={pending || loading}
          onClick={() => {
            setLoaded({
              revision: programme.revision,
              preview: programme.preview,
              sources: [],
              editId: crypto.randomUUID(),
            });
            setReason('');
            onError(null);
          }}
        >
          Replace inputs with a fresh evidence selection
        </Button>
      </div>
      {loaded && (
        <>
          <p>
            Editing programme revision {loaded.revision}.{' '}
            {loaded.revision !== programme.revision
              ? 'The programme has changed; reload the edit inputs before saving.'
              : 'Selected original versions are retained.'}
          </p>
          {loaded.revision === programme.revision && (
            <ReductionIntake
              key={loaded.editId}
              run={run}
              disabled={pending}
              initialPreview={loaded.preview}
              initialSources={loaded.sources}
              onError={onError}
              onSubmitPreview={revise}
              submitLabel="Save material input revision"
              detailsHeading="Revision reason"
            >
              <label>
                Why are these programme inputs changing?
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  rows={2}
                  maxLength={4096}
                  required
                />
              </label>
            </ReductionIntake>
          )}
        </>
      )}
    </details>
  );
}

export function ProgrammeRecordEditor({
  programme,
  pending,
  mutate,
  onError,
}: {
  programme: ReductionProgrammeSnapshot;
  pending: boolean;
  mutate: ProgrammeMutation;
  onError(message: string | null): void;
}) {
  const run = useAgentRun(undefined, 'haze.reduction.programme.attachments', {
    restoreFromStorage: false,
  });
  const [note, setNote] = useState('');
  const [noteBase, setNoteBase] = useState<number | null>(null);
  const [sources, setSources] = useState<Artifact[]>([]);
  const [attachmentBase, setAttachmentBase] = useState<number | null>(null);
  const [description, setDescription] = useState('');
  const saveNote = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await mutate(
        'record',
        reductionProgrammeRecordRequestSchema.parse({
          schema_version: 'haze.reduction.programme.record-request.v1',
          expected_revision: noteBase ?? programme.revision,
          record: { kind: 'note', text: note },
        }),
      );
      setNote('');
      setNoteBase(null);
    } catch (cause) {
      onError(
        cause instanceof Error ? cause.message : 'The note was not confirmed.',
      );
    }
  };
  const attach = async (artifact: Artifact) => {
    try {
      await mutate(
        'record',
        reductionProgrammeRecordRequestSchema.parse({
          schema_version: 'haze.reduction.programme.record-request.v1',
          expected_revision: attachmentBase ?? programme.revision,
          record: {
            kind: 'attachment',
            artifact: exactPreviewRef(artifact),
            description,
          },
        }),
      );
      setSources([]);
      setDescription('');
      setAttachmentBase(null);
    } catch (cause) {
      onError(
        cause instanceof Error
          ? cause.message
          : 'The attachment was not confirmed.',
      );
    }
  };
  return (
    <section
      className={styles.card}
      aria-labelledby="programme-records-heading"
    >
      <h2 id="programme-records-heading">
        Notes and exact artifact attachments
      </h2>
      <p className={styles.note}>
        Records are historical context. An attached preview or source does not
        become a current programme result or recreate a reservation. Unrelated
        notes do not alter the numerical input fingerprint.
      </p>
      <form className={styles.form} onSubmit={(event) => void saveNote(event)}>
        <label>
          Programme note
          <textarea
            value={note}
            onChange={(event) => {
              if (noteBase === null) setNoteBase(programme.revision);
              setNote(event.target.value);
            }}
            maxLength={4096}
            rows={3}
            required
            disabled={pending}
          />
        </label>
        {noteBase !== null && noteBase !== programme.revision && (
          <p className={styles.notice}>
            The note draft began at revision {noteBase}; the programme is now
            revision {programme.revision}. Review the current programme and
            reset this draft before saving.
          </p>
        )}
        <div className={styles.actions}>
          <Button
            type="submit"
            disabled={
              pending ||
              !note.trim() ||
              (noteBase !== null && noteBase !== programme.revision)
            }
          >
            Append note
          </Button>
          <Button
            disabled={pending}
            onClick={() => {
              setNote('');
              setNoteBase(null);
            }}
          >
            Clear note draft
          </Button>
        </div>
      </form>
      <details>
        <summary>Attach an existing immutable artifact</summary>
        <ExistingArtifactAttachment
          programme={programme}
          pending={pending}
          mutate={mutate}
          onError={onError}
        />
      </details>
      <details>
        <summary>Import a new context attachment</summary>
        <SourceImport
          sources={sources}
          onChange={(next) => {
            setSources(next);
            if (attachmentBase === null) setAttachmentBase(programme.revision);
          }}
          importSource={run.importSource}
          disabled={pending}
          idPrefix="programme-context"
          attachmentPurpose="Context attachments do not supply implicit assessment quantities."
        />
        <label className={styles.form}>
          Attachment purpose
          <input
            value={description}
            onChange={(event) => {
              if (attachmentBase === null)
                setAttachmentBase(programme.revision);
              setDescription(event.target.value);
            }}
            maxLength={4096}
            disabled={pending}
          />
        </label>
        {attachmentBase !== null && attachmentBase !== programme.revision && (
          <p className={styles.notice}>
            The programme revision changed. Clear the attachment draft and
            review the new revision.
          </p>
        )}
        {sources.map((source) => (
          <div className={styles.actions} key={source.id}>
            <ExactSource
              reference={exactPreviewRef(source)}
              label={source.filename ?? 'Imported context'}
            />
            <Button
              disabled={
                pending ||
                !description.trim() ||
                attachmentBase !== programme.revision
              }
              onClick={() => void attach(source)}
            >
              Attach exact version
            </Button>
          </div>
        ))}
        <Button
          disabled={pending}
          onClick={() => {
            setSources([]);
            setDescription('');
            setAttachmentBase(null);
          }}
        >
          Clear attachment draft
        </Button>
      </details>
    </section>
  );
}

function ExistingArtifactAttachment({
  programme,
  pending,
  mutate,
  onError,
}: {
  programme: ReductionProgrammeSnapshot;
  pending: boolean;
  mutate: ProgrammeMutation;
  onError(message: string | null): void;
}) {
  const [id, setId] = useState('');
  const [version, setVersion] = useState('1');
  const [hash, setHash] = useState('');
  const [description, setDescription] = useState('');
  const [base, setBase] = useState<number | null>(null);
  const change = (update: () => void) => {
    if (base === null) setBase(programme.revision);
    update();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await mutate(
        'record',
        reductionProgrammeRecordRequestSchema.parse({
          schema_version: 'haze.reduction.programme.record-request.v1',
          expected_revision: base ?? programme.revision,
          record: {
            kind: 'attachment',
            artifact: { id, version: Number(version), sha256: hash },
            description,
          },
        }),
      );
      setId('');
      setVersion('1');
      setHash('');
      setDescription('');
      setBase(null);
    } catch (cause) {
      onError(
        cause instanceof Error
          ? cause.message
          : 'The exact artifact reference was not confirmed.',
      );
    }
  };
  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)}>
      <p className={styles.note}>
        For a prior standalone preview, copy the exact assessment or
        conditional-plan artifact reference from its saved task. Attaching it
        retains historical context and does not reuse its admission reservation.
      </p>
      <label>
        Exact artifact ID
        <input
          value={id}
          onChange={(event) => change(() => setId(event.target.value))}
          required
          maxLength={36}
          disabled={pending}
        />
      </label>
      <label>
        Artifact version
        <input
          value={version}
          onChange={(event) => change(() => setVersion(event.target.value))}
          type="number"
          min={1}
          step={1}
          required
          disabled={pending}
        />
      </label>
      <label>
        SHA-256
        <input
          value={hash}
          onChange={(event) => change(() => setHash(event.target.value))}
          required
          minLength={64}
          maxLength={64}
          disabled={pending}
        />
      </label>
      <label>
        Purpose of the historical attachment
        <input
          value={description}
          onChange={(event) => change(() => setDescription(event.target.value))}
          required
          maxLength={4096}
          disabled={pending}
        />
      </label>
      <div className={styles.actions}>
        <Button
          type="submit"
          disabled={
            pending ||
            !id ||
            !hash ||
            !description.trim() ||
            (base !== null && base !== programme.revision)
          }
        >
          Attach exact reference
        </Button>
        <Button
          disabled={pending}
          onClick={() => {
            setId('');
            setVersion('1');
            setHash('');
            setDescription('');
            setBase(null);
          }}
        >
          Clear reference draft
        </Button>
      </div>
    </form>
  );
}
