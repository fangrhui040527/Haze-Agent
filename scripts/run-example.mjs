import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const root = fileURLToPath(new URL('../', import.meta.url));
const inputSchema = z.strictObject({
  runId: z.string().trim().min(1),
  artifactIds: z.array(z.string().min(1)).optional(),
  graphVersion: z.number().int().optional(),
  schemaVersion: z.number().int().optional(),
});

/** Run the existing infrastructure graph; this example never calls a provider. */
export async function runExample({ inputPath, outputPath, logsDirectory }) {
  const input = inputSchema.parse(
    JSON.parse(await readFile(inputPath, 'utf8')),
  );
  let createCheckpointGraph;
  try {
    ({ createCheckpointGraph } = await import('../dist/graph.js'));
  } catch (error) {
    throw new Error('Build the project first: npm ci && npm run build', {
      cause: error,
    });
  }
  await mkdir(logsDirectory, { recursive: true });
  const tracePath = resolve(logsDirectory, `run-${randomUUID()}.jsonl`);
  const trace = (event) =>
    appendFile(
      tracePath,
      `${JSON.stringify({ recordedAt: new Date().toISOString(), event, runId: input.runId, node: 'checkpoint' })}\n`,
    );
  await trace('started');
  try {
    const graph = createCheckpointGraph(new MemorySaver());
    const state = await graph.invoke(input, {
      configurable: { thread_id: input.runId },
    });
    // Keep stdout and the checked-in output fixtures stable across executions.
    const result = {
      runId: state.runId,
      artifactIds: state.artifactIds,
      graphVersion: state.graphVersion,
      schemaVersion: state.schemaVersion,
    };
    if (outputPath) {
      await mkdir(dirname(resolve(outputPath)), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    }
    await trace('completed');
    return result;
  } catch (error) {
    await trace('failed');
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        output: { type: 'string' },
        'logs-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      console.log(
        'Usage: node scripts/run-example.mjs [input.json] [--output result.json] [--logs-dir logs]',
      );
    } else {
      if (positionals.length > 1) throw new Error('Expected one input file');
      const result = await runExample({
        inputPath:
          positionals[0] ?? resolve(root, 'input_examples/01-minimal.json'),
        outputPath: values.output,
        logsDirectory: values['logs-dir'] ?? resolve(root, 'logs'),
      });
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    // Avoid echoing arbitrary input, provider configuration, or library errors.
    console.error(
      error?.message === 'Build the project first: npm ci && npm run build'
        ? error.message
        : 'Example failed. Check the JSON input, workflow versions, CLI options, and writable output/trace paths.',
    );
    process.exitCode = 1;
  }
}
