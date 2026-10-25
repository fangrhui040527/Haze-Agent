import { createStore, readLocal, writeLocal } from '../../shared/lib/store.ts';

/**
 * Whether fictional demo data is shown next to real data.
 * Default: hidden whenever the server has real data. Demo data is always shown when
 * there is no real data (server unreachable, or no records yet), with the DEMO banner.
 */
export interface DemoPreference {
  showDemoWithReal: boolean;
}

const KEY = 'haze.demo.preference.v1';

export const demoPreference = createStore<DemoPreference>({
  showDemoWithReal: false,
  ...readLocal<Partial<DemoPreference>>(KEY, {}),
});

demoPreference.subscribe(() => writeLocal(KEY, demoPreference.get()));

export function setShowDemoWithReal(show: boolean): void {
  demoPreference.set((p) => ({ ...p, showDemoWithReal: show }));
}
