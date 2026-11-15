export interface Account { label: string; username: string; password: string }
export type ExternalStatus = 'public' | 'internal';
export type UsageStatus = 'open' | 'maintenance' | 'occupied';
export interface Environment {
  id: string; name: string; purpose: string; url: string;
  externalStatus: ExternalStatus; usageStatus: UsageStatus;
  releaseAt: string | null; note: string; accounts: Account[]; updatedAt: string;
}
export type EnvironmentInput = Omit<Environment, 'id' | 'updatedAt'>;
export interface DemoFolder { id: string; name: string; createdAt: string }
export type AssetStatus = 'complete' | 'partial' | 'legacy' | 'no-candidates';
export interface DemoRecord {
  id: string; sourceDemoId: string; title: string; description: string;
  productVersion: string; tags: string[]; uploader: string; folderId: string | null;
  uploadedAt: string; stepCount: number; assetStatus: AssetStatus; resourceIssueCount: number;
}
export interface Inspection {
  uploadToken: string; sourceTitle: string; sourceDemoId: string; stepCount: number;
  assetStatus: AssetStatus; sizeBytes: number; resourceIssueCount: number;
}
export interface DemoInput {
  title: string; description: string; productVersion: string; tags: string[];
  uploader: string; folderId: string | null;
}
export interface Playback {
  manifest: {
    id: string; title: string; sourceUrl: string; formatVersion: 1 | 2;
    viewport: { width: number; height: number } | null;
    clicks: Array<{ time: number }>;
  };
  steps: Array<{ id: string; at: number; title: string; description?: string; rect: { x: number; y: number; width: number; height: number } }>;
  events: Array<{ type: number; timestamp: number; data: unknown }>;
  assets: { entries: Array<{ url: string; status: string; filename?: string; mime?: string }> } | null;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(path, init); }
  catch { throw new Error('无法连接 DemoCenter 服务，请检查网络后重试。'); }
  const contentType = response.headers.get('content-type') ?? '';
  let data: unknown;
  try { data = contentType.includes('application/json') ? await response.json() : await response.text(); }
  catch { data = null; }
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
      ? data.error : `操作失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return data as T;
}
export function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
