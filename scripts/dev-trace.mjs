import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';

const idPattern = /^[A-Za-z0-9-]{1,128}$/u;
const safeLine = (value) =>
  stripVTControlCharacters(String(value ?? '')).replace(
    /[\x00-\x1f\x7f]/gu,
    ' ',
  );
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function parseTraceOptions(tokens) {
  const [action, taskId, ...args] = tokens;
  const usage =
    action === 'export'
      ? 'tasks export <taskId> [--run <runId>] --out "<directory>"'
      : 'tasks trace <taskId> [--run <runId>] [--follow]';
  if (!idPattern.test(taskId ?? '')) throw new Error(`Usage: ${usage}`);
  const result = {
    action,
    taskId,
    runId: undefined,
    follow: false,
    out: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    if (
      args[i] === '--run' &&
      !result.runId &&
      idPattern.test(args[i + 1] ?? '')
    )
      result.runId = args[++i];
    else if (args[i] === '--follow' && action === 'trace' && !result.follow)
      result.follow = true;
    else if (
      args[i] === '--out' &&
      action === 'export' &&
      !result.out &&
      args[i + 1] &&
      !args[i + 1].startsWith('--')
    )
      result.out = args[++i];
    else throw new Error(`Usage: ${usage}`);
  }
  if (action === 'export' && !result.out) throw new Error(`Usage: ${usage}`);
  return result;
}

/** Server-controlled names never become filesystem paths. */
export async function writeEvidenceBundle(bundle, directory, signal) {
  if (
    bundle?.schema_version !== 'haze.evidence-bundle.v1' ||
    !bundle.manifest ||
    !Array.isArray(bundle.records) ||
    !Array.isArray(bundle.artifacts) ||
    typeof bundle.summary !== 'string'
  )
    throw new Error('Invalid evidence bundle response.');
  const artifacts = bundle.artifacts.map((artifact, i) => {
    const content = `${JSON.stringify(artifact.content)}\n`;
    if (
      createHash('sha256').update(content).digest('hex') !==
      artifact.exported_sha256
    )
      throw new Error(
        'Evidence bundle artifact bytes do not match their exported hash.',
      );
    return {
      filename: `artifact-${String(i + 1).padStart(4, '0')}.json`,
      content,
    };
  });
  signal?.throwIfAborted();
  const target = resolve(directory);
  try {
    await mkdir(target);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        `Export destination already exists; refusing overwrite: ${target}`,
      );
    throw error;
  }
  const files = [
    ['manifest.json', json(bundle.manifest)],
    [
      'events.jsonl',
      bundle.records.map((record) => JSON.stringify(record)).join('\n') +
        (bundle.records.length ? '\n' : ''),
    ],
    ['summary.md', bundle.summary],
    ['input.json', json(bundle.input)],
    ['output.json', json(bundle.output)],
    ['context.json', json(bundle.context)],
    [
      'artifacts.json',
      json(
        bundle.artifacts.map((artifact, i) => ({
          original_ref: artifact.original_ref,
          filename: `artifacts/${artifacts[i].filename}`,
          exported_sha256: artifact.exported_sha256,
          provenance: artifact.provenance,
        })),
      ),
    ],
  ];
  for (const [filename, content] of files) {
    signal?.throwIfAborted();
    await writeFile(join(target, filename), content, { flag: 'wx', signal });
  }
  if (artifacts.length) {
    await mkdir(join(target, 'artifacts'));
    for (const artifact of artifacts) {
      signal?.throwIfAborted();
      await writeFile(
        join(target, 'artifacts', artifact.filename),
        artifact.content,
        { flag: 'wx', signal },
      );
    }
  }
  return target;
}

export async function executeTraceCommand(
  tokens,
  { request, readTask, signal, write, pollMs = 750 },
) {
  const options = parseTraceOptions(tokens);
  const runId =
    options.runId ?? (await readTask(options.taskId, signal)).current_run_id;
  const base = `/api/tasks/${options.taskId}/runs/${runId}`;
  if (options.action === 'export') {
    const bundle = await request(`${base}/evidence-bundle`, {
      signal,
      maxBytes: 32 * 1024 * 1024,
    });
    if (
      bundle?.manifest?.task_id !== options.taskId ||
      bundle?.manifest?.run_id !== runId
    )
      throw new Error(
        'The evidence bundle does not match the selected task and run.',
      );
    const target = await writeEvidenceBundle(bundle, options.out, signal);
    return `Exported task ${options.taskId}, run ${runId}, to ${target}`;
  }
  let after = 0;
  const output = [];
  do {
    signal?.throwIfAborted();
    const page = await request(`${base}/trace?after=${after}&limit=100`, {
      signal,
    });
    if (
      page?.schema_version !== 'haze.trace.page.v1' ||
      page.task_id !== options.taskId ||
      page.run_id !== runId ||
      !Array.isArray(page.records) ||
      !Number.isSafeInteger(page.next_cursor) ||
      page.next_cursor < after ||
      (page.has_more && page.next_cursor <= after)
    )
      throw new Error('Invalid trace page identity or cursor.');
    for (const record of page.records) {
      if (
        record.task_id !== options.taskId ||
        record.run_id !== runId ||
        !Number.isSafeInteger(record.cursor) ||
        record.cursor <= after
      )
        throw new Error(
          'Trace event does not match the selected task, run, or cursor.',
        );
      after = record.cursor;
      const text = `${safeLine(record.event_id)} ${safeLine(record.at)} ${safeLine(record.actor)} ${safeLine(record.action)} [${safeLine(record.status)}] ${safeLine(record.summary)}`;
      if (write) write(text);
      else output.push(text);
    }
    if (page.next_cursor !== after)
      throw new Error('Invalid trace page continuation cursor.');
    after = page.next_cursor;
    if (page.has_more) continue;
    if (!options.follow) break;
    if (signal?.aborted) break;
    try {
      await delay(pollMs, undefined, { signal });
    } catch (error) {
      if (signal?.aborted) break;
      throw error;
    }
  } while (true);
  return write
    ? undefined
    : output.join('\n') || 'No trace records are available for this run.';
}
