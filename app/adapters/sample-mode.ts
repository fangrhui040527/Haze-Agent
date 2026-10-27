/** Sample evidence and model execution are independent settings. */
export function sampleModeEnabled(env: NodeJS.ProcessEnv): boolean {
  return !['', '0', 'false'].includes(
    env.SAMPLE_MODE?.trim().toLowerCase() ?? '',
  );
}

/** Synthetic evidence gets a separate default store, even with a live .env. */
export function sampleStateDirectory(env: NodeJS.ProcessEnv): string {
  return (
    env.HAZE_TASK_STATE_DIR ||
    (sampleModeEnabled(env)
      ? '.state/sample-mode'
      : env.STATE_DIR || '.state/general-v2')
  );
}
