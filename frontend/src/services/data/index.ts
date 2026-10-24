import type { DataService } from './DataService.ts';
import { MockDataService } from './MockDataService.ts';
// import { ZetarisDataService } from './ZetarisDataService.ts';

/**
 * THE ONE PLACE that decides where data comes from.
 *
 * To use the real backend later, replace the export below with:
 *   export const dataService: DataService = new ZetarisDataService(import.meta.env.VITE_API_BASE_URL);
 * and set VITE_API_BASE_URL in a .env.local file (never put secrets there: it ships to the browser).
 */
export const mockDataService = new MockDataService();

export const dataService: DataService = mockDataService;

export type { DataService, DataSnapshot, LiveUpdate } from './DataService.ts';
