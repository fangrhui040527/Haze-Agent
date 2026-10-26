import { CompositeDataService } from './CompositeDataService.ts';
import type { DataService } from './DataService.ts';
import { HttpDataService } from './HttpDataService.ts';
import { MockDataService } from './MockDataService.ts';

/**
 * THE ONE PLACE that decides where data comes from.
 *
 * Source data comes from the shared application API at /api, handled by Vite
 * in development. Fictional demo data is used only when the API has no items,
 * or when turned on from the Demo Data page.
 */
export const mockDataService = new MockDataService();
export const httpDataService = new HttpDataService(
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '',
);

export const dataService: DataService = new CompositeDataService(
  httpDataService,
  mockDataService,
);

export type { DataService, DataSnapshot, LiveUpdate } from './DataService.ts';
export { demoPreference, setShowDemoWithReal } from './demoPreference.ts';
