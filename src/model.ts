import type { ClickCandidate, DemoStep, Viewport } from './core.ts';

export interface RecordedEvent {
  type: number;
  timestamp: number;
  data: unknown;
}

export interface AssetEntry {
  url: string;
  context: 'img' | 'srcset' | 'svg' | 'css' | 'stylesheet';
  status: 'pending' | 'saved' | 'failed';
  filename?: string;
  mime?: string;
  bytes?: number;
  reason?: string;
}

export interface AssetIndex {
  version: 1;
  entries: AssetEntry[];
}

export interface AssetSummary {
  discovered: number;
  saved: number;
  failed: number;
  uniqueBytes: number;
  status: 'complete' | 'partial' | 'no-candidates' | 'legacy';
}

export interface EventBatch {
  type: 'EVENT_BATCH';
  sessionId: string;
  batchId: string;
  events: RecordedEvent[];
  clicks: ClickCandidate[];
  viewport: Viewport;
}

export interface DemoManifest {
  formatVersion: 1 | 2;
  id: string;
  title: string;
  sourceUrl: string;
  createdAt: string;
  updatedAt: string;
  status: 'recording' | 'ready' | 'interrupted';
  firstEventAt: number | null;
  viewport: Viewport | null;
  chunks: number;
  clicks: ClickCandidate[];
  offlineAssets?: AssetSummary;
}

export interface LoadedDemo {
  manifest: DemoManifest;
  events: RecordedEvent[];
  steps: DemoStep[];
  assets: AssetIndex | null;
}

export interface ActiveSession {
  sessionId: string;
  tabId: number;
  origin: string;
  demoId: string;
}
