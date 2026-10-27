import { useState, type FormEvent } from 'react';
import type { NightshiftChain } from '../../../../app/contracts/nightshift-records.ts';
import type { NightshiftJobReadiness } from '../../../../app/contracts/nightshift.ts';
import { Button } from '../../shared/ui/Button.tsx';
import styles from './NightshiftPage.module.css';

export type ChainDraft = {
  task_id: string;
  total_runs: number;
  max_jobs: number;
  max_attempts: number;
  lifetime_seconds: number;
  automatic_opt_in: boolean;
  automatic_followup_runs: number;
  purpose: string;
  instruction: string;
  input_refs_text: string;
  previous_chain_id: string;
};
export type JobDraft = {
  chain_id: string;
  prompt: string;
  input_refs_text: string;
  role: string;
  n: number;
  judge: string;
  budget: string;
  window: string;
  fleet: string;
};

export function ChainAdmissionForm({
  busy,
  available,
  automaticAvailable = false,
  automaticReason = null,
  onSubmit,
}: {
  busy: boolean;
  available: boolean;
  automaticAvailable?: boolean;
  automaticReason?: string | null;
  onSubmit(draft: ChainDraft): void;
}) {
  const [automatic, setAutomatic] = useState(false);
  const [totalRuns, setTotalRuns] = useState(1);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSubmit({
      task_id: String(data.get('task_id')).trim(),
      total_runs: Number(data.get('total_runs')),
      max_jobs: Number(data.get('max_jobs')),
      max_attempts: Number(data.get('max_attempts')),
      lifetime_seconds: Math.floor(Number(data.get('lifetime_hours')) * 3600),
      automatic_opt_in: automatic && automaticAvailable,
      automatic_followup_runs: automatic
        ? Number(data.get('automatic_followup_runs'))
        : 0,
      purpose: String(data.get('purpose') ?? 'evidence_linked_draft'),
      instruction: String(data.get('instruction') ?? '').trim(),
      input_refs_text: String(data.get('initial_input_refs') ?? '[]'),
      previous_chain_id: String(data.get('previous_chain_id') ?? '').trim(),
    });
  };
  return (
    <form className={styles.panel} onSubmit={submit}>
      <h2>Admit a bounded chain</h2>
      <p>
        Attach a grant to an existing authorized task. Create a task on the
        dashboard first if needed. Enrollment preserves its existing charges and
        deadline.
      </p>
      <label>
        Task ID
        <input name="task_id" required maxLength={36} placeholder="Task UUID" />
      </label>
      <div className={styles.fields}>
        <label>
          Total admitted runs
          <select
            name="total_runs"
            value={totalRuns}
            onChange={(event) => setTotalRuns(Number(event.target.value))}
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n} disabled={automatic && n === 1}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          Maximum jobs
          <input
            name="max_jobs"
            type="number"
            min={1}
            max={4}
            defaultValue={4}
            required
          />
        </label>
        <label>
          Maximum requested attempts
          <input
            name="max_attempts"
            type="number"
            min={1}
            max={16}
            defaultValue={16}
            required
          />
        </label>
        <label>
          Absolute lifetime (hours)
          <input
            name="lifetime_hours"
            type="number"
            min={0.01}
            max={24}
            step={0.01}
            defaultValue={24}
            required
          />
        </label>
      </div>
      <label>
        <input
          type="checkbox"
          name="automatic_opt_in"
          checked={automatic}
          disabled={busy || !automaticAvailable}
          onChange={(event) => {
            setAutomatic(event.target.checked);
            if (event.target.checked)
              setTotalRuns((value) => Math.max(2, value));
          }}
        />
        Explicitly authorize bounded automatic follow-ups
      </label>
      {!automaticAvailable ? (
        <p role="status">
          Automatic mode is blocked:{' '}
          {automaticReason ??
            'the server has not released the required live and recovery gates.'}
        </p>
      ) : null}
      {automatic ? (
        <>
          <label>
            Maximum automatic follow-ups
            <select
              name="automatic_followup_runs"
              defaultValue="1"
              key={totalRuns}
            >
              {Array.from(
                { length: Math.min(3, totalRuns - 1) },
                (_, index) => index + 1,
              ).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label>
            Permitted next purpose
            <select name="purpose" defaultValue="evidence_linked_draft">
              <option value="evidence_linked_draft">
                Evidence-linked draft
              </option>
              <option value="alternative_explanation">
                Alternative explanation
              </option>
              <option value="critique_candidate">Critique candidate</option>
            </select>
          </label>
          <label>
            Outstanding instruction
            <textarea
              name="instruction"
              required
              maxLength={2000}
              rows={3}
              placeholder="Describe the unresolved purpose and the evidence limits."
            />
          </label>
          <label>
            Initial exact input references (JSON array)
            <textarea
              name="initial_input_refs"
              required
              maxLength={16384}
              defaultValue="[]"
              spellCheck={false}
              rows={3}
            />
          </label>
          <label>
            Previous closed grant ID (optional)
            <input
              name="previous_chain_id"
              maxLength={36}
              placeholder="Previous chain UUID"
            />
          </label>
          <p>
            A replacement grant requires a separately admitted task. Its
            historical link cannot enlarge or reopen the previous grant.
          </p>
          <p>
            Automatic and user-triggered successors spend this same cumulative
            grant. Neither a new run nor Resume renews counters or the absolute
            expiry. Candidate generation still requires independent review.
          </p>
        </>
      ) : (
        <p>
          Local-only · $0 cloud spend · zero automatic follow-ups. Additional
          runs require explicit user controls and share this grant.
        </p>
      )}
      <Button
        type="submit"
        disabled={busy || !available || (automatic && !automaticAvailable)}
      >
        Admit chain
      </Button>
    </form>
  );
}

export function JobSubmissionForm({
  chains,
  readiness,
  busy,
  onSubmit,
}: {
  chains: NightshiftChain[];
  readiness: NightshiftJobReadiness | null;
  busy: boolean;
  onSubmit(draft: JobDraft): void;
}) {
  const available = chains.filter((chain) => chain.status === 'active');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSubmit({
      chain_id: String(data.get('chain_id')),
      prompt: String(data.get('prompt')),
      input_refs_text: String(data.get('input_refs')),
      role: String(data.get('role')),
      n: Number(data.get('n')),
      judge: String(data.get('judge')),
      budget: String(data.get('budget')),
      window: String(data.get('window')),
      fleet: String(data.get('fleet')).trim(),
    });
  };
  return (
    <form className={styles.panel} onSubmit={submit}>
      <h2>Submit a local text job</h2>
      <p>
        Generate an evidence-linked draft, alternative explanation or critique
        candidate. Retrieval, calculations and independent review stay with
        registered Haze capabilities.
      </p>
      <label>
        Active bounded chain
        <select name="chain_id" required defaultValue="">
          <option value="" disabled>
            Select an active chain
          </option>
          {available.map((chain) => (
            <option key={chain.id} value={chain.id}>
              {chain.id} · {chain.remaining.jobs} jobs /{' '}
              {chain.remaining.requested_attempts} attempts remaining
            </option>
          ))}
        </select>
      </label>
      <label>
        Brief
        <textarea
          name="prompt"
          required
          maxLength={12000}
          rows={5}
          placeholder="Describe the draft and the limits of the supplied evidence."
        />
      </label>
      <label>
        Exact input artifact references (JSON array)
        <textarea
          name="input_refs"
          required
          maxLength={16384}
          rows={3}
          defaultValue="[]"
          spellCheck={false}
          aria-describedby="job-input-help"
        />
      </label>
      <p id="job-input-help">
        Copy each authorized artifact's id, version and sha256. Candidates
        retain these exact dependencies; generated citations require checking.
      </p>
      <div className={styles.fields}>
        <label>
          Admitted route role
          <select name="role" defaultValue="Manager">
            {[
              'Manager',
              'HazeOps',
              'WorkerShield',
              'EvidenceCritic',
              'DamageAccountant',
            ].map((role) => (
              <option key={role}>{role}</option>
            ))}
          </select>
        </label>
        <label>
          Requested attempts
          <input
            name="n"
            type="number"
            required
            min={1}
            max={Math.min(16, readiness?.options.max_attempts ?? 16)}
            defaultValue={4}
          />
        </label>
        <label>
          Judge
          <select name="judge" defaultValue="accuracy">
            {['accuracy', 'consistency', 'creative', 'quality'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Budget
          <select name="budget" defaultValue="low">
            {['low', 'mid', 'high', 'max'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Execution window
          <select name="window" defaultValue="now">
            <option value="now">Now</option>
            <option value="quiet">Quiet window</option>
          </select>
        </label>
        <label>
          Configured fleet (optional)
          <input name="fleet" maxLength={128} placeholder="Runtime selection" />
        </label>
      </div>
      <p>
        Text best_of_n only · local-only · $0 cloud spend. The server checks
        options and remaining reservations before submission. There is no
        unbounded local queue.
      </p>
      <Button
        type="submit"
        disabled={busy || !readiness?.ready || available.length === 0}
      >
        Submit job
      </Button>
      {!readiness?.ready ? (
        <p role="status">
          Submission unavailable:{' '}
          {readiness?.reason ?? 'waiting for runtime readiness.'}
        </p>
      ) : null}
    </form>
  );
}
