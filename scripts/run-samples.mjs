import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { taskRequestSchema } from '../dist/contracts/tasks.js';
import { createReductionSelection } from '../dist/capabilities/damage-reduction-planning/inputs.js';
import { createReductionVerificationReader } from './reduction-verification-http.mjs';
import {
  captureSchema,
  validateCapture,
} from '../dist/capabilities/pm25/methods.js';
import { validateSampleOutput } from './sample-output-validation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const examples = {
  'evidence-investigation': 1,
  'damage-account': 2,
  'damage-reduction': 3,
};
export const sampleRequestSchema = z.strictObject({
  schema_version: z.literal('haze.sample.request.v1'),
  scenario_id: z.enum([
    'evidence-investigation',
    'damage-account',
    'damage-reduction',
  ]),
  request: taskRequestSchema,
  inputs: z
    .strictObject({
      pm25_capture: z.unknown().optional(),
      notes: z.string().min(1).max(16_000).optional(),
      damage: z.unknown().optional(),
      residuals: z.unknown().optional(),
      target: z.unknown().optional(),
      candidate: z.unknown().optional(),
    })
    .optional(),
});

/** User-supplied native inputs replace defaults; IDs select a format, never an answer. */
export async function resolveSampleInputs(wrapper, defaults) {
  const inputs = wrapper.inputs ?? {};
  const allowed =
    defaults.manifest.kind === 'pm25'
      ? ['pm25_capture', 'notes']
      : defaults.manifest.kind === 'damage-account'
        ? ['damage']
        : ['residuals', 'target', 'candidate'];
  if (Object.keys(inputs).some((key) => !allowed.includes(key)))
    throw new Error(
      'An input override belongs to a different capability format.',
    );
  if (defaults.manifest.kind === 'pm25') {
    const capture = captureSchema.parse(
      inputs.pm25_capture ?? defaults.capture,
    );
    if (
      capture.mode !== 'fixture' ||
      capture.evidence_origin !== 'synthetic_fixture'
    )
      throw new Error(
        'Sample PM2.5 inputs must retain explicit synthetic provenance.',
      );
    // Validate the complete catalogue independently of the requested subset.
    // The source adapter then filters by the caller's actual location/period.
    const times = capture.rows.map(({ start }) => Date.parse(start));
    const catalogueScope = times.length
      ? {
          location: capture.location,
          period: {
            start: new Date(Math.min(...times)).toISOString(),
            end: new Date(
              Math.max(...times) + capture.sample_interval_minutes * 60_000,
            ).toISOString(),
          },
        }
      : wrapper.request.scope;
    if (catalogueScope !== undefined) validateCapture(capture, catalogueScope);
    return { ...defaults, capture, notes: inputs.notes ?? defaults.notes };
  }
  const { parseSampleScenario } = await import('../dist/sample-data/index.js');
  return parseSampleScenario(
    defaults.manifest.kind === 'damage-account'
      ? { ...defaults, input: inputs.damage ?? defaults.input }
      : {
          ...defaults,
          input: inputs.residuals ?? defaults.input,
          target: inputs.target ?? defaults.target,
          candidate: inputs.candidate ?? defaults.candidate,
        },
  );
}

const exactRef = ({ id, version, sha256 }) => ({ id, version, sha256 });
const sameRef = (left, right) =>
  Boolean(
    left &&
    right &&
    left.id === right.id &&
    left.version === right.version &&
    left.sha256 === right.sha256,
  );

async function loadRequest(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (value?.schema_version === 'haze.task.request.v3')
    throw new Error(
      'For sample datasets, wrap this native request as haze.sample.request.v1 with scenario_id, request and optional inputs. Native haze.task.request.v3 is also accepted by POST /api/tasks. See docs/guides/sample-mode.md.',
    );
  return sampleRequestSchema.parse(value);
}

/** Fresh inputs enter a real runtime; saved output files are never read. */
async function runScenario(wrapper, scenario, runRoot) {
  const directory = resolve(runRoot, wrapper.scenario_id);
  const logsDirectory = resolve(runRoot, 'logs');
  const outputPath = resolve(
    root,
    `output_examples/example_${examples[wrapper.scenario_id]}_output.json`,
  );
  let samplePm25File;
  if (scenario.manifest.kind === 'pm25') {
    const inputDirectory = resolve(runRoot, 'raw-inputs');
    await mkdir(inputDirectory, { recursive: true });
    samplePm25File = resolve(inputDirectory, `${wrapper.scenario_id}.json`);
    await writeFile(
      samplePm25File,
      `${JSON.stringify(scenario.capture, null, 2)}\n`,
    );
  }
  await mkdir(directory, { recursive: true });
  let child;
  let origin;
  let task;
  let taskId;
  let submittedRequest = wrapper.request;
  let failure;
  let interrupted = false;
  const artifacts = [];
  const events = [];
  const transportRetries = [];
  const read = createReductionVerificationReader({
    fetchImpl: (url, options) =>
      fetch(url, { ...options, signal: AbortSignal.timeout(30_000) }),
    onRetry: (entry) => transportRetries.push(entry),
  });

  async function request(path, body) {
    if (interrupted) throw new Error('Sample execution was interrupted.');
    if (body === undefined) return read(origin, path);
    // Send admissions/imports once. The idempotency key identifies this exact
    // request if a receipt is lost; no automatic spending replay is attempted.
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        'Content-Type': 'application/json',
        Origin: origin,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json();
    if (!response.ok)
      throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`);
    return value;
  }

  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const active = child;
    child = undefined;
    await new Promise((done) => {
      const timeout = setTimeout(() => active.kill('SIGKILL'), 10_000);
      active.once('exit', () => {
        clearTimeout(timeout);
        done();
      });
      active.kill('SIGTERM');
    });
  }
  const onInterrupt = () => {
    interrupted = true;
    void stop();
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);

  async function importContent(filename, mediaType, content) {
    const value = await request('/api/artifacts', {
      schema_version: 'haze.artifact.import.v3',
      filename,
      media_type: mediaType,
      declared_origin: `${scenario.manifest.provenance.description} SAMPLE_MODE supplies synthetic evidence; configured agents still perform model inference.`,
      content_base64: Buffer.from(content).toString('base64'),
    });
    const artifact = value.artifact ?? value;
    artifacts.push(artifact);
    return exactRef(artifact);
  }

  async function capture() {
    if (!taskId) return;
    task = await request(`/api/tasks/${taskId}`);
    for (const { artifact: ref } of task.artifacts) {
      const artifact = await request(`/api/artifacts/${ref.id}`);
      if (!sameRef(ref, artifact))
        throw new Error('An exact retained artifact reference changed.');
      if (!artifacts.some((item) => sameRef(item, artifact)))
        artifacts.push(artifact);
    }
    let cursor = 0;
    const retained = new Map(events.map((event) => [event.cursor, event]));
    for (;;) {
      const page = await request(`/api/tasks/${taskId}/events?after=${cursor}`);
      for (const event of page.events) retained.set(event.cursor, event);
      if (page.next_cursor === cursor || !page.events.length) break;
      cursor = page.next_cursor;
    }
    events.splice(0, events.length, ...retained.values());
  }

  console.log(`\n${scenario.manifest.title}`);
  console.log(
    'Synthetic evidence; using the existing configured model routes.',
  );
  try {
    child = fork(new URL('./serve-tasks.mjs', import.meta.url), [], {
      env: {
        ...process.env,
        SAMPLE_MODE: 'true',
        HAZE_EXECUTION_MODE: 'live',
        HAZE_SAMPLE_SCENARIO_ID: wrapper.scenario_id,
        ...(samplePm25File ? { HAZE_SAMPLE_PM25_FILE: samplePm25File } : {}),
        HAZE_TASK_STATE_DIR: directory,
        STATE_DIR: directory,
        HAZE_TASK_PORT: '0',
        HAZE_TRACE_FILES: 'on',
        HAZE_TRACE_DIR: logsDirectory,
        HAZE_TRACE_STDOUT: process.env.HAZE_TRACE_STDOUT ?? 'key',
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    origin = await new Promise((ready, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Sample API startup exceeded 45 seconds.')),
        45_000,
      );
      const finish = (callback, value) => {
        clearTimeout(timer);
        callback(value);
      };
      child.once('message', (message) => {
        if (!Number.isInteger(message?.port))
          finish(reject, new Error('Sample API returned an invalid port.'));
        else finish(ready, `http://127.0.0.1:${message.port}`);
      });
      child.once('error', (error) => finish(reject, error));
      child.once('exit', (code) =>
        finish(reject, new Error(`Sample API exited (${code}).`)),
      );
    });

    const refs = [...wrapper.request.context_refs];
    if (scenario.manifest.kind === 'pm25') {
      refs.push(
        await importContent(
          'sample-pm25-capture.json',
          'application/json',
          JSON.stringify(scenario.capture),
        ),
        await importContent(
          'sample-source-notes.md',
          'text/markdown',
          scenario.notes,
        ),
      );
    } else {
      const source = await importContent(
        scenario.manifest.kind === 'damage-account'
          ? 'sample-damage-input.json'
          : 'sample-residual-input.json',
        'application/json',
        JSON.stringify(scenario.input),
      );
      refs.push(source);
      if (scenario.manifest.kind === 'damage-reduction')
        submittedRequest = {
          ...submittedRequest,
          scope: {
            schema_version: 'haze.reduction.preview-request.v1',
            selection: createReductionSelection(scenario.target, [
              {
                artifact: source,
                row_ids: scenario.input.records.map(({ row_id }) => row_id),
              },
            ]),
            candidate: scenario.candidate,
          },
        };
    }
    submittedRequest = taskRequestSchema.parse({
      ...submittedRequest,
      context_refs: refs,
    });
    const admission = await request('/api/tasks', submittedRequest);
    taskId = admission.task_id;
    console.log(`Task ${taskId}: awaiting fresh agent execution...`);
    for (;;) {
      task = await request(`/api/tasks/${taskId}`);
      if (!['queued', 'running'].includes(task.status)) break;
      if (Date.now() > Date.parse(task.limits.deadline) + 30_000)
        throw new Error(
          'Sample task exceeded its admitted deadline and capture grace period.',
        );
      await new Promise((done) => setTimeout(done, 500));
    }
    await capture();
    if (task.status !== 'completed')
      throw new Error(`Task ended with status ${task.status}.`);
    if (task.mode !== 'live' || task.usage.model_calls === 0)
      throw new Error(
        'The sample did not execute the configured model agents.',
      );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    if (!interrupted)
      try {
        await capture();
      } catch {
        // Preserve the last obtained state when the server itself is unavailable.
      }
  } finally {
    await stop();
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
  }

  let attempts = [];
  let attemptReadError;
  if (taskId) {
    let database;
    try {
      database = new DatabaseSync(resolve(directory, 'tasks.sqlite'), {
        readOnly: true,
      });
      attempts = database
        .prepare('SELECT body FROM attempts ORDER BY rowid')
        .all()
        .map(({ body }) => JSON.parse(body))
        .filter((attempt) => attempt.task_id === taskId);
    } catch {
      attemptReadError =
        'The retained execution-attempt ledger could not be read.';
    } finally {
      database?.close();
    }
  }
  const modelAttempts = attempts.filter((attempt) => attempt.kind === 'model');
  const output = {
    schema_version: 'haze.sample.output.v1',
    sample_mode: true,
    synthetic_evidence: true,
    scenario_id: wrapper.scenario_id,
    recorded_at: new Date().toISOString(),
    request: submittedRequest,
    task: task ?? null,
    result: task?.result ?? null,
    events,
    artifacts,
    execution: {
      mode: task?.mode ?? 'live',
      passed: !failure,
      state_directory: relative(root, directory).replaceAll('\\', '/'),
      logs_directory: relative(root, logsDirectory).replaceAll('\\', '/'),
      model_calls: task?.usage.model_calls ?? 0,
      model_cache_hits: modelAttempts.filter(
        (attempt) =>
          attempt.accepted === true &&
          attempt.receipt?.response_status === 'cache_hit',
      ).length,
      fresh_model_responses: modelAttempts.filter(
        (attempt) =>
          attempt.accepted === true &&
          attempt.receipt?.response_id &&
          attempt.receipt?.response_status !== 'cache_hit',
      ).length,
      tool_calls: task?.usage.tool_calls ?? 0,
      model_attempts: modelAttempts,
      roles: (task?.assignments ?? []).map((assignment) => ({
        role: assignment.role,
        definition_id: assignment.definition_id,
        status: assignment.status,
        model_calls: assignment.usage.model_calls,
        tool_calls: assignment.usage.tool_calls,
      })),
      transport_retries: transportRetries,
      ...(attemptReadError ? { attempt_read_error: attemptReadError } : {}),
      ...(failure ? { error: failure } : {}),
    },
  };
  const validation = validateSampleOutput(output);
  output.execution.validation = validation;
  if (!validation.valid) {
    failure = [failure, ...validation.errors].filter(Boolean).join('; ');
    output.execution.passed = false;
    output.execution.error = failure;
  }
  await mkdir(resolve(root, 'output_examples'), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`${failure ? 'Failed' : 'Completed'}: ${outputPath}`);
  if (failure) console.error(failure);
  if (interrupted) throw new Error('Sample execution was interrupted.');
  return !failure;
}

async function main() {
  const [argument, ...extra] = process.argv.slice(2);
  if (
    !argument ||
    extra.length ||
    (argument.startsWith('--') && !['--list', '--all'].includes(argument))
  )
    throw new Error(
      'Usage: node scripts/run-samples.mjs --list | --all | INPUT.json',
    );
  const { listSampleScenarios, loadSampleScenario } =
    await import('../dist/sample-data/index.js');
  if (argument === '--list') {
    for (const manifest of await listSampleScenarios())
      console.log(
        `${manifest.id}\tinput_examples/example_${examples[manifest.id]}.json\t${manifest.title}`,
      );
    return;
  }
  const wrappers =
    argument === '--all'
      ? await Promise.all(
          Object.values(examples).map((number) =>
            loadRequest(resolve(root, `input_examples/example_${number}.json`)),
          ),
        )
      : [await loadRequest(resolve(argument))];
  const runRoot = resolve(root, '.state/sample-runs', randomUUID());
  let passed = true;
  for (const wrapper of wrappers) {
    const scenario = await resolveSampleInputs(
      wrapper,
      await loadSampleScenario(wrapper.scenario_id),
    );
    if (!(await runScenario(wrapper, scenario, runRoot))) passed = false;
  }
  if (!passed) process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
