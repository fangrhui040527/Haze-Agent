import { useEffect, useState } from 'react';
import type { WorldTaskResponse } from '../../../../app/contracts/world-api.ts';
import { agentService } from '../../services/agents/index.ts';

export interface WorldModelStatusState {
  data: WorldTaskResponse | null;
  loading: boolean;
  error: string | null;
}

export function useWorldModelStatus(
  taskId: string,
  taskRevision: number | undefined,
  lifecycleCursor: number,
  enabled: boolean,
): WorldModelStatusState {
  const [state, setState] = useState<WorldModelStatusState>({
    data: null,
    loading: false,
    error: null,
  });
  useEffect(() => {
    if (!enabled) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setState({ data: null, loading: true, error: null });
    const read = agentService.readWorldTask;
    if (!read) {
      setState({
        data: null,
        loading: false,
        error: 'This task service cannot read current World Model status.',
      });
      return () => controller.abort();
    }
    read(taskId, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted)
          setState({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            data: null,
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : 'Current World Model status could not be loaded.',
          });
      });
    return () => controller.abort();
  }, [enabled, lifecycleCursor, taskId, taskRevision]);
  return state;
}
