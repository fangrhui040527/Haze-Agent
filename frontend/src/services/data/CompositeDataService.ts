import type {
  ConnectionStatus,
  ItemDetail,
  Location,
  Source,
} from '../../shared/types/domain.ts';
import type { DataService, DataSnapshot, LiveUpdate } from './DataService.ts';
import { demoPreference } from './demoPreference.ts';

/** Real items from the server have ids starting with "hz-"; demo items never do. */
const isRealId = (id: string) => id.startsWith('hz-');

type Mode = 'real' | 'real+demo' | 'demo';

const LABELS: Record<Mode, string> = {
  real: 'Haze server (real data)',
  'real+demo': 'Haze server + fictional demo data',
  demo: 'Mock (fictional demo data, server has no real data)',
};

function unionById<T extends { id: string }>(first: T[], second: T[]): T[] {
  const seen = new Set(first.map((x) => x.id));
  return [...first, ...second.filter((x) => !seen.has(x.id))];
}

/**
 * Shows real data when the server has it, and fictional demo data only when it does
 * not, or when the user turns demo data on from the Demo Data page.
 */
export class CompositeDataService implements DataService {
  private readonly real: DataService;
  private readonly demo: DataService;
  private mode: Mode = 'demo';

  constructor(real: DataService, demo: DataService) {
    this.real = real;
    this.demo = demo;
  }

  get label(): string {
    return LABELS[this.mode];
  }

  async loadSnapshot(signal?: AbortSignal): Promise<DataSnapshot> {
    let real: DataSnapshot | null = null;
    try {
      real = await this.real.loadSnapshot(
        signal
          ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
          : AbortSignal.timeout(8000),
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      // server unreachable: fall back to demo data
    }
    const hasReal = (real?.items.length ?? 0) > 0;
    const includeDemo = !hasReal || demoPreference.get().showDemoWithReal;
    if (real && hasReal && !includeDemo) {
      this.mode = 'real';
      return real;
    }
    const demo = await this.demo.loadSnapshot(signal);
    if (!real || !hasReal) {
      this.mode = 'demo';
      return demo;
    }
    this.mode = 'real+demo';
    return {
      items: [...real.items, ...demo.items],
      locations: unionById<Location>(real.locations, demo.locations),
      sources: unionById<Source>(real.sources, demo.sources),
      asOf: real.asOf,
      fictional: true,
    };
  }

  getItem(id: string, signal?: AbortSignal): Promise<ItemDetail | null> {
    return isRealId(id)
      ? this.real.getItem(id, signal)
      : this.demo.getItem(id, signal);
  }

  subscribe(
    onUpdate: (update: LiveUpdate) => void,
    onStatus: (status: ConnectionStatus) => void,
  ): () => void {
    const reload = () =>
      this.loadSnapshot()
        .then((snapshot) => onUpdate({ kind: 'reset', snapshot }))
        .catch(() => onStatus('error'));

    // Both streams stay open; updates are routed by the current mode so that switching
    // modes needs no resubscription.
    const stopReal = this.real.subscribe(
      (update) => {
        if (this.mode !== 'demo') onUpdate(update);
        else if (update.kind === 'upsert' && update.items.length > 0)
          void reload();
      },
      (status) => {
        if (this.mode !== 'demo') onStatus(status);
        else if (status === 'live') void reload(); // server came back: check for real data
      },
    );
    const stopDemo = this.demo.subscribe(
      (update) => {
        if (this.mode === 'real') return;
        // A regenerated demo dataset must not wipe real items in mixed mode.
        if (update.kind === 'reset' && this.mode === 'real+demo') void reload();
        else onUpdate(update);
      },
      (status) => {
        if (this.mode === 'demo') onStatus(status);
      },
    );
    // Turning demo data on or off reloads everything.
    let seen = demoPreference.get().showDemoWithReal;
    const stopPreference = demoPreference.subscribe(() => {
      const now = demoPreference.get().showDemoWithReal;
      if (now === seen) return;
      seen = now;
      void reload();
    });
    return () => {
      stopReal();
      stopDemo();
      stopPreference();
    };
  }
}
