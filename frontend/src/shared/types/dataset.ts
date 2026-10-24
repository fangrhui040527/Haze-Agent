import type { HazeItem, Location, Source } from './domain.ts';

export const DATASET_SCHEMA_VERSION = 'hazewatch.demo.v1';

export type ChatIntent =
  | 'overview'
  | 'compare'
  | 'forecast'
  | 'cause'
  | 'health'
  | 'sources'
  | 'changes';

/** Answer templates used by the mock agents. Placeholders look like {location}. */
export interface ChatScript {
  intent: ChatIntent;
  keywords: string[];
  templates: string[];
  examplePrompts: string[];
}

/** The whole demo dataset. Saved as public/demo-data/demo-data.seed.json. */
export interface DemoDataset {
  schemaVersion: typeof DATASET_SCHEMA_VERSION;
  /** Always true. Everything in the dataset is invented. */
  fictional: true;
  notice: string;
  seed: number;
  generatedAt: string;
  locations: Location[];
  sources: Source[];
  items: HazeItem[];
  chatScripts: ChatScript[];
}
