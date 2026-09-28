import { sortRecordedEvents } from './core.ts';
import type { DemoStep } from './core.ts';
import { isAssetIndex, MAX_DEMO_ASSET_BYTES, summarizeAssetIndex, validateAssetResponse } from './asset-store.ts';
import type { AssetReference } from './asset-refs.ts';
import type { AssetEntry, AssetIndex, DemoManifest, EventBatch, LoadedDemo, RecordedEvent } from './model.ts';

const DB_NAME = 'hci-local-demo';
const ROOT_KEY = 'library-root';
const assetQueues = new Map<string, Promise<void>>();

async function serializeAssetWrite<T>(id: string, action: () => Promise<T>): Promise<T> {
  const preceding = assetQueues.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  assetQueues.set(id, current);
  await preceding;
  try { return await action(); }
  finally {
    release();
    if (assetQueues.get(id) === current) assetQueues.delete(id);
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('handles');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveRootHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('handles', 'readwrite');
      transaction.objectStore('handles').put(handle, ROOT_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

export async function loadRootHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('handles', 'readonly');
      const request = transaction.objectStore('handles').get(ROOT_KEY);
      request.onsuccess = () => resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

export async function hasWritePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
}

export async function requestWritePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

async function readJson<T>(folder: FileSystemDirectoryHandle, name: string): Promise<T> {
  const file = await folder.getFileHandle(name);
  return JSON.parse(await (await file.getFile()).text()) as T;
}

async function writeJson(folder: FileSystemDirectoryHandle, name: string, value: unknown): Promise<void> {
  const file = await folder.getFileHandle(name, { create: true });
  const writer = await file.createWritable();
  await writer.write(JSON.stringify(value));
  await writer.close();
}

async function getDemoDir(root: FileSystemDirectoryHandle, id: string, create = false): Promise<FileSystemDirectoryHandle> {
  if (!/^demo-[a-f0-9-]+$/.test(id)) throw new Error('Demo 编号无效');
  const demos = await root.getDirectoryHandle('demos', { create });
  return demos.getDirectoryHandle(id, { create });
}

export async function createDemo(root: FileSystemDirectoryHandle, title: string, sourceUrl: string): Promise<DemoManifest> {
  const id = `demo-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const manifest: DemoManifest = {
    formatVersion: 2, id, title, sourceUrl, createdAt: now, updatedAt: now,
    status: 'recording', firstEventAt: null, viewport: null, chunks: 0, clicks: [],
    offlineAssets: { discovered: 0, saved: 0, failed: 0, uniqueBytes: 0, status: 'no-candidates' }
  };
  const folder = await getDemoDir(root, id, true);
  await folder.getDirectoryHandle('events', { create: true });
  await writeJson(await folder.getDirectoryHandle('assets', { create: true }), 'index.json', { version: 1, entries: [] } satisfies AssetIndex);
  await writeJson(folder, 'manifest.json', manifest);
  await writeJson(folder, 'steps.json', []);
  return manifest;
}

export async function writeBatch(root: FileSystemDirectoryHandle, manifest: DemoManifest, batch: EventBatch): Promise<DemoManifest> {
  if (batch.sessionId !== manifest.id) throw new Error('录制会话与 Demo 不匹配');
  const folder = await getDemoDir(root, manifest.id);
  const eventsDir = await folder.getDirectoryHandle('events');
  const filename = `${batch.batchId}.json`;
  try {
    await eventsDir.getFileHandle(filename);
    return (await loadDemo(root, manifest.id)).manifest;
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
  }
  await writeJson(eventsDir, filename, batch);
  const next: DemoManifest = {
    ...manifest,
    updatedAt: new Date().toISOString(),
    firstEventAt: manifest.firstEventAt ?? batch.events[0]?.timestamp ?? null,
    viewport: manifest.viewport ?? batch.viewport,
    chunks: manifest.chunks + 1,
    clicks: [...manifest.clicks, ...batch.clicks]
  };
  await writeJson(folder, 'manifest.json', next);
  return next;
}

export async function finishDemo(root: FileSystemDirectoryHandle, manifest: DemoManifest, status: 'ready' | 'interrupted' = 'ready'): Promise<DemoManifest> {
  return serializeAssetWrite(manifest.id, async () => {
    const folder = await getDemoDir(root, manifest.id);
    let offlineAssets = manifest.offlineAssets;
    if (manifest.formatVersion === 2) {
      const assets = await folder.getDirectoryHandle('assets');
      const index = await readJson<AssetIndex>(assets, 'index.json');
      index.entries = index.entries.map(entry => entry.status === 'pending'
        ? { ...entry, status: 'failed', reason: 'Capture did not finish before recording stopped' } : entry);
      await writeJson(assets, 'index.json', index);
      offlineAssets = summarizeAssetIndex(index);
    }
    const next = { ...manifest, status, updatedAt: new Date().toISOString(), offlineAssets };
    await writeJson(folder, 'manifest.json', next);
    return next;
  });
}

async function assetFolder(root: FileSystemDirectoryHandle, id: string): Promise<FileSystemDirectoryHandle> {
  return (await getDemoDir(root, id)).getDirectoryHandle('assets');
}

async function updateAssetIndex(root: FileSystemDirectoryHandle, id: string, update: (index: AssetIndex, folder: FileSystemDirectoryHandle) => Promise<void> | void, invalidateLateCommit?: (index: AssetIndex) => boolean): Promise<AssetIndex> {
  return serializeAssetWrite(id, async () => {
    const demo = await getDemoDir(root, id);
    const manifest = await readJson<DemoManifest>(demo, 'manifest.json');
    if (manifest.status !== 'recording') throw new Error('Asset capture cannot update a finished demo');
    const folder = await demo.getDirectoryHandle('assets');
    const index = await readJson<AssetIndex>(folder, 'index.json');
    await update(index, folder);
    invalidateLateCommit?.(index);
    await writeJson(folder, 'index.json', index);
    // A filesystem close cannot be synchronously cancelled. If it committed
    // after expiry, correct the index before releasing the per-demo write lock.
    if (invalidateLateCommit?.(index)) await writeJson(folder, 'index.json', index);
    return index;
  });
}

function findAsset(index: AssetIndex, url: string): AssetEntry | undefined {
  return index.entries.find(entry => entry.url === url);
}

async function storedAssetFiles(folder: FileSystemDirectoryHandle): Promise<{ totalBytes: number; files: Map<string, File> }> {
  let totalBytes = 0;
  const files = new Map<string, File>();
  for await (const [name, handle] of folder.entries()) {
    if (name === 'index.json' || handle.kind !== 'file') continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    totalBytes += file.size;
    files.set(name, file);
  }
  return { totalBytes, files };
}

export async function recordAssetCandidate(root: FileSystemDirectoryHandle, demoId: string, reference: AssetReference): Promise<AssetIndex> {
  return updateAssetIndex(root, demoId, index => {
    if (!findAsset(index, reference.url)) index.entries.push({ url: reference.url, context: reference.context, status: 'pending' });
  });
}

export async function recordAssetFailure(root: FileSystemDirectoryHandle, demoId: string, input: { url: string; context: AssetReference['context']; reason: string }): Promise<AssetIndex> {
  return updateAssetIndex(root, demoId, index => {
    const entry = findAsset(index, input.url);
    if (entry?.status === 'saved') return;
    if (entry) Object.assign(entry, { status: 'failed', reason: input.reason });
    else index.entries.push({ url: input.url, context: input.context, status: 'failed', reason: input.reason });
  });
}

export async function saveCapturedAsset(root: FileSystemDirectoryHandle, demoId: string, input: { url: string; mime: string; sha256: string; bytes: Uint8Array; deadline?: number; signal?: AbortSignal }): Promise<AssetIndex> {
  let alreadySaved = false;
  function invalidateLateCommit(index: AssetIndex): boolean {
    const reason = input.deadline !== undefined && Date.now() >= input.deadline ? 'Asset capture timed out after 10 seconds'
      : input.signal?.aborted ? (input.signal.reason instanceof Error ? input.signal.reason.message : 'Asset capture cancelled') : undefined;
    const entry = findAsset(index, input.url);
    // Preserve a valid file saved by an earlier capture of this URL.
    if (!reason || !entry || alreadySaved || (entry.status === 'failed' && entry.reason === reason)) return false;
    Object.assign(entry, { status: 'failed', reason });
    delete entry.filename;
    delete entry.mime;
    delete entry.bytes;
    return true;
  }
  const index = await updateAssetIndex(root, demoId, async (index, folder) => {
    const entry = findAsset(index, input.url);
    if (!entry) throw new Error('Asset candidate was not recorded');
    if (entry.status === 'saved') { alreadySaved = true; return; }
    if (invalidateLateCommit(index)) return;
    const validated = validateAssetResponse(input.url, input.mime, input.bytes);
    if ('reason' in validated) {
      Object.assign(entry, { status: 'failed', reason: validated.reason });
      return;
    }
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', input.bytes as BufferSource)), byte => byte.toString(16).padStart(2, '0')).join('');
    if (!/^[a-f0-9]{64}$/.test(input.sha256) || hash !== input.sha256) {
      Object.assign(entry, { status: 'failed', reason: 'SHA-256 mismatch' });
      return;
    }
    const filename = `${hash}.${validated.extension}`;
    const stored = await storedAssetFiles(folder);
    const existing = stored.files.get(filename);
    if (!existing && stored.totalBytes + input.bytes.byteLength > MAX_DEMO_ASSET_BYTES) {
      Object.assign(entry, { status: 'failed', reason: 'Demo asset storage exceeds 200 MB' });
      return;
    }
    if (existing) {
      const existingHash = existing.size === input.bytes.byteLength
        ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await existing.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('')
        : '';
      if (existingHash !== hash) {
        Object.assign(entry, { status: 'failed', reason: 'Existing asset file does not match SHA-256' });
        return;
      }
    } else {
      const file = await folder.getFileHandle(filename, { create: true });
      const writer = await file.createWritable();
      await writer.write(new Blob([input.bytes as BlobPart]));
      await writer.close();
    }
    Object.assign(entry, { status: 'saved', filename, mime: validated.mime, bytes: input.bytes.byteLength });
    delete entry.reason;
  }, invalidateLateCommit);
  if (findAsset(index, input.url)?.reason === 'SHA-256 mismatch') throw new Error('SHA-256 mismatch');
  return index;
}

export async function loadAssetFile(root: FileSystemDirectoryHandle, demoId: string, filename: string): Promise<File> {
  if (!/^[a-f0-9]{64}\.(?:png|jpg|gif|webp|avif|bmp|ico|svg|woff|woff2|ttf|otf)$/.test(filename)) throw new Error('Invalid asset filename');
  const folder = await assetFolder(root, demoId);
  return (await folder.getFileHandle(filename)).getFile();
}

export async function saveSteps(root: FileSystemDirectoryHandle, id: string, steps: DemoStep[]): Promise<void> {
  await writeJson(await getDemoDir(root, id), 'steps.json', [...steps].sort((a, b) => a.at - b.at));
}

export async function listDemos(root: FileSystemDirectoryHandle): Promise<DemoManifest[]> {
  let demos: FileSystemDirectoryHandle;
  try { demos = await root.getDirectoryHandle('demos'); }
  catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return [];
    throw error;
  }
  const results: DemoManifest[] = [];
  for await (const [name, handle] of demos.entries()) {
    if (handle.kind !== 'directory' || !name.startsWith('demo-')) continue;
    try { results.push(await readJson<DemoManifest>(handle as FileSystemDirectoryHandle, 'manifest.json')); }
    catch { /* Ignore an incomplete demo folder; do not delete user data. */ }
  }
  return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteDemo(root: FileSystemDirectoryHandle, id: string): Promise<void> {
  const folder = await getDemoDir(root, id);
  const manifest = await readJson<DemoManifest>(folder, 'manifest.json');
  if (manifest.id !== id) throw new Error('演示目录与记录编号不一致，未执行删除');
  const demos = await root.getDirectoryHandle('demos');
  await demos.removeEntry(id, { recursive: true });
}

export async function loadDemo(root: FileSystemDirectoryHandle, id: string): Promise<LoadedDemo> {
  const folder = await getDemoDir(root, id);
  const manifest = await readJson<DemoManifest>(folder, 'manifest.json');
  const steps = await readJson<DemoStep[]>(folder, 'steps.json');
  const eventsDir = await folder.getDirectoryHandle('events');
  const chunks: RecordedEvent[][] = [];
  const clicks = [] as DemoManifest['clicks'];
  let firstViewport = manifest.viewport;
  for await (const [name, handle] of eventsDir.entries()) {
    if (handle.kind !== 'file' || !name.endsWith('.json')) continue;
    const batch = await readJson<EventBatch>(eventsDir, name);
    chunks.push(batch.events);
    clicks.push(...batch.clicks);
    firstViewport ??= batch.viewport;
  }
  const events = sortRecordedEvents(chunks);
  let assets: AssetIndex | null = null;
  if (manifest.formatVersion === 2) {
    try {
      const index = await readJson<unknown>(await folder.getDirectoryHandle('assets'), 'index.json');
      if (!isAssetIndex(index)) throw new Error('Invalid asset index');
      assets = index;
    } catch { /* Recorded events and steps remain usable when the optional asset pack is damaged. */ }
  }
  return {
    manifest: { ...manifest, chunks: chunks.length, clicks: clicks.sort((a, b) => a.time - b.time),
      firstEventAt: events[0]?.timestamp ?? null, viewport: firstViewport },
    steps, events, assets
  };
}
