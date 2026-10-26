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
  private realSnapshot: DataSnapshot | null = null;
  private demoSnapshot: DataSnapshot | null = null;

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
    this.realSnapshot = real;
    this.demoSnapshot = null;
    return this.combine(signal);
  }

  private async combine(signal?: AbortSignal): Promise<DataSnapshot> {
    if (
      !this.demoSnapshot &&
      (!this.realSnapshot?.items.length ||
        demoPreference.get().showDemoWithReal)
    ) {
      const demo = await this.demo.loadSnapshot(signal);
      this.demoSnapshot ??= demo;
    }
    // Read the latest real snapshot after the demo load: stream updates may have
    // arrived while the local demo data was loading.
    const real = this.realSnapshot;
    const hasReal = (real?.items.length ?? 0) > 0;
    const includeDemo = !hasReal || demoPreference.get().showDemoWithReal;
    if (real && hasReal && !includeDemo) {
      this.mode = 'real';
      return real;
    }
    const demo = this.demoSnapshot as DataSnapshot;
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
    let active = true;
    let revision = 0;
    let resetting = false;
    let realStatus: ConnectionStatus = 'connecting';
    let demoStatus: ConnectionStatus = 'connecting';
    const reportStatus = () => {
      if (active) onStatus(this.mode === 'demo' ? demoStatus : realStatus);
    };
    const reset = () => {
      const current = ++revision;
      resetting = true;
      void this.combine()
        .then((snapshot) => {
          if (!active || current !== revision) return;
          resetting = false;
          onUpdate({ kind: 'reset', snapshot });
          reportStatus();
        })
        .catch(() => {
          if (active && current === revision) {
            resetting = false;
            onStatus('error');
          }
        });
    };
    const apply = (snapshot: DataSnapshot | null, update: LiveUpdate) => {
      if (update.kind === 'reset') return update.snapshot;
      if (!snapshot) return null;
      return {
        ...snapshot,
        items: unionById(update.items, snapshot.items),
        asOf: update.asOf,
      };
    };

    // Both streams stay open; updates are routed by the current mode so that switching
    // modes needs no resubscription.
    const stopReal = this.real.subscribe(
      (update) => {
        if (!active) return;
        this.realSnapshot = apply(this.realSnapshot, update);
        if (update.kind === 'reset' || this.mode === 'demo' || resetting)
          reset();
        else onUpdate(update);
      },
      (status) => {
        realStatus = status;
        reportStatus();
      },
    );
    const stopDemo = this.demo.subscribe(
      (update) => {
        if (!active) return;
        this.demoSnapshot = apply(this.demoSnapshot, update);
        if (this.mode === 'real') return;
        // A regenerated demo dataset must not wipe real items in mixed mode.
        if (resetting || (update.kind === 'reset' && this.mode === 'real+demo'))
          reset();
        else onUpdate(update);
      },
      (status) => {
        demoStatus = status;
        reportStatus();
      },
    );
    // Turning demo data on or off reloads everything.
    let seen = demoPreference.get().showDemoWithReal;
    const stopPreference = demoPreference.subscribe(() => {
      const now = demoPreference.get().showDemoWithReal;
      if (now === seen) return;
      seen = now;
      reset();
    });
    return () => {
      active = false;
      revision += 1;
      stopReal();
      stopDemo();
      stopPreference();
    };
  }
}
