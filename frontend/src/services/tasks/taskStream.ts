import type { TaskEvent } from '../../shared/types/tasks.ts';

const baseUrl = (
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''
).replace(/\/+$/, '');

/**
 * Follows one task report on the Haze server (server/src/tasks):
 *   GET /api/tasks/:id/events (SSE) -> "step" and "block" events, then "result" or "failed"
 * The server replays earlier events on connect, so reopening a report rebuilds it.
 * Returns a function that stops listening.
 */
export function followTask(
  taskId: string,
  onEvent: (event: TaskEvent) => void,
  onLost: () => void,
): () => void {
  const source = new EventSource(
    `${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/events`,
  );
  let finished = false;
  const handle = (e: Event) => {
    const event = JSON.parse((e as MessageEvent<string>).data) as TaskEvent;
    if (event.type === 'result' || event.type === 'failed') finished = true;
    onEvent(event);
  };
  for (const type of ['step', 'block', 'result', 'failed'])
    source.addEventListener(type, handle);
  source.addEventListener('end', () => {
    finished = true;
    source.close();
  });
  source.onerror = () => {
    source.close();
    if (!finished) onLost();
  };
  return () => source.close();
}
