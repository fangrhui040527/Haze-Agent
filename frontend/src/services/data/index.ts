import { CompositeDataService } from './CompositeDataService.ts';
import type { DataService } from './DataService.ts';
import { HttpDataService } from './HttpDataService.ts';
import { MockDataService } from './MockDataService.ts';

/**
 * THE ONE PLACE that decides where data comes from.
 *
 * Real data comes from the HazeWatch server (server/, proxied at /api by Vite in
 * development; set VITE_API_BASE_URL to point elsewhere). Fictional demo data is used
 * only when the server has no real data, or when turned on from the Demo Data page.
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
