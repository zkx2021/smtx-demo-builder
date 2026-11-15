import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { isAssetIndex } from './asset-store.ts';
import type { DemoStep } from './core.ts';
import type { AssetIndex, DemoManifest, EventBatch } from './model.ts';

export interface PreparedDemoPackage {
  entries: Array<{ path: string; file: Blob }>;
  manifest: DemoManifest;
  packageManifest: { packageFormatVersion: 1; demoId: string; exportedAt: string };
  resourceIssueCount: number;
}

const assetFilename = /^[a-f0-9]{64}\.(?:png|jpg|gif|webp|avif|bmp|ico|svg|woff|woff2|ttf|otf)$/;
const batchFilename = /^[A-Za-z0-9_-]{1,120}\.json$/;
// Keep these limits aligned with democenter/server/package.mjs.
const maxPackageEntries = 2_000;
const maxUncompressedBytes = 1_000_000_000;
const maxEntryBytes = 512_000_000;
const maxJsonBytes = 128_000_000;
const maxUploadBytes = 512_000_000;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function checkPackageSize(path: string, size: number, count: number, total: number): number {
  if (count > maxPackageEntries) throw new Error('演示包文件数量超过 DemoCenter 上限（2000）');
  if (!Number.isSafeInteger(size) || size < 0 || size > maxEntryBytes) throw new Error(`演示包单个文件超过 DemoCenter 上限：${path}`);
  if (path.endsWith('.json') && size > maxJsonBytes) throw new Error(`演示包 JSON 文件超过 DemoCenter 上限：${path}`);
  if (total + size > maxUncompressedBytes) throw new Error('演示包解压后超过 DemoCenter 上限（1 GB）');
  return total + size;
}
const validRect = (rect: DemoStep['rect']) => rect && ['x', 'y', 'width', 'height'].every(key => {
  const value = rect[key as keyof typeof rect];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}) && rect.x + rect.width <= 1.000001 && rect.y + rect.height <= 1.000001;

export function suggestedDemoPackageName(title: string): string {
  const cleaned = title.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').trim().slice(0, 100).replace(/[. _]+$/g, '');
  const name = cleaned || '未命名演示';
  return `${name.replace(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?=\.|$)/i, '$1_')}.smtxdemo`;
}

async function getFile(folder: FileSystemDirectoryHandle, name: string): Promise<File> {
  return (await folder.getFileHandle(name)).getFile();
}

function checkJsonBeforeRead(path: string, file: File): void {
  if (file.size > maxJsonBytes) throw new Error(`演示包 JSON 文件超过 DemoCenter 上限：${path}`);
}

export async function prepareDemoPackage(root: FileSystemDirectoryHandle, demoId: string, exportedAt = new Date().toISOString()): Promise<PreparedDemoPackage> {
  if (!/^demo-[a-f0-9-]+$/.test(demoId)) throw new Error('演示编号无效');
  const demo = await (await root.getDirectoryHandle('demos')).getDirectoryHandle(demoId);
  const manifestFile = await getFile(demo, 'manifest.json');
  checkJsonBeforeRead('manifest.json', manifestFile);
  const manifest = JSON.parse(await manifestFile.text()) as DemoManifest;
  if (manifest.id !== demoId || manifest.status !== 'ready' || ![1, 2].includes(manifest.formatVersion) || !manifest.title?.trim()) throw new Error('只能导出已完成的演示');
  const stepsFile = await getFile(demo, 'steps.json');
  checkJsonBeforeRead('steps.json', stepsFile);
  const steps = JSON.parse(await stepsFile.text()) as DemoStep[];
  if (!Array.isArray(steps) || !steps.length || steps.some(step => !step || typeof step.id !== 'string' || typeof step.title !== 'string' || !Number.isFinite(step.at) || step.at < 0 || !validRect(step.rect))) throw new Error('演示至少需要一个有效热点，请先在热点编辑器中添加');

  const entries = new Map<string, Blob>();
  let uncompressedBytes = 0;
  function add(path: string, file: Blob) {
    if (entries.has(path)) throw new Error(`演示包含重复文件：${path}`);
    uncompressedBytes = checkPackageSize(path, file.size, entries.size + 1, uncompressedBytes);
    entries.set(path, file);
  }
  add('manifest.json', manifestFile);
  add('steps.json', stepsFile);
  const eventsDir = await demo.getDirectoryHandle('events');
  let eventCount = 0;
  let hasSnapshot = false;
  for await (const [name, handle] of eventsDir.entries()) {
    if (handle.kind !== 'file' || !batchFilename.test(name)) throw new Error(`事件文件名无效：${name}`);
    const eventFile = await getFile(eventsDir, name);
    checkJsonBeforeRead(`events/${name}`, eventFile);
    const batch = JSON.parse(await eventFile.text()) as EventBatch;
    if (!Array.isArray(batch.events) || batch.events.some(event => !isObject(event) || !Number.isInteger(event.type) || !Number.isFinite(event.timestamp) || event.timestamp < 0 || !isObject(event.data))) throw new Error(`录制事件无效：${name}`);
    eventCount += batch.events.length;
    hasSnapshot ||= batch.events.some(event => event.type === 2);
    add(`events/${name}`, eventFile);
  }
  if (eventCount < 2 || !hasSnapshot) throw new Error('演示缺少有效录制事件');

  let resourceIssueCount = 0;
  if (manifest.formatVersion === 2) {
    let assets: FileSystemDirectoryHandle | null = null;
    let indexFile: File | null = null;
    let index: AssetIndex | null = null;
    try {
      assets = await demo.getDirectoryHandle('assets');
      indexFile = await getFile(assets, 'index.json');
      checkJsonBeforeRead('assets/index.json', indexFile);
      const parsed: unknown = JSON.parse(await indexFile.text());
      if (isAssetIndex(parsed)) index = parsed;
    } catch { /* A damaged index is exported as a partial recording. */ }
    if (!assets || !indexFile || !index) {
      resourceIssueCount = Math.max(manifest.offlineAssets?.discovered ?? 0, 1);
    } else {
      add('assets/index.json', indexFile);
      const available = new Map<string, File | null>();
      for (const entry of index.entries) {
        if (entry.status !== 'saved') { resourceIssueCount++; continue; }
        const name = entry.filename ?? '';
        if (!assetFilename.test(name)) { resourceIssueCount++; continue; }
        if (!available.has(name)) {
          let file: File | null = null;
          try {
            const candidate = await getFile(assets, name);
            if (candidate.size === entry.bytes) file = candidate;
          } catch { /* Report the missing resource below. */ }
          available.set(name, file);
        }
        const file = available.get(name);
        if (!file) { resourceIssueCount++; continue; }
        if (!entries.has(`assets/${name}`)) add(`assets/${name}`, file);
      }
    }
  }
  const packageManifest = { packageFormatVersion: 1 as const, demoId, exportedAt };
  add('package-manifest.json', new Blob([JSON.stringify(packageManifest)], { type: 'application/json' }));
  return { entries: [...entries].map(([path, file]) => ({ path, file })).sort((a, b) => a.path.localeCompare(b.path, 'en')),
    manifest, packageManifest, resourceIssueCount };
}

export async function writeDemoPackage(prepared: PreparedDemoPackage, destination: FileSystemFileHandle): Promise<{ bytesWritten: number }> {
  const seen = new Set<string>();
  let uncompressedBytes = 0;
  for (const entry of prepared.entries) {
    if (!/^(?:package-manifest\.json|manifest\.json|steps\.json|events\/[A-Za-z0-9_-]{1,120}\.json|assets\/(?:index\.json|[a-f0-9]{64}\.(?:png|jpg|gif|webp|avif|bmp|ico|svg|woff|woff2|ttf|otf)))$/.test(entry.path) || seen.has(entry.path)) throw new Error('演示包含无效或重复的包内路径');
    seen.add(entry.path);
    uncompressedBytes = checkPackageSize(entry.path, entry.file.size, seen.size, uncompressedBytes);
  }
  const writable = await destination.createWritable();
  let bytesWritten = 0;
  let queue: Promise<void> = Promise.resolve();
  let resolveFinished!: () => void;
  let rejectFinished!: (error: Error) => void;
  const finished = new Promise<void>((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject; });
  const zip = new Zip((error, chunk, final) => {
    if (error) { rejectFinished(error); return; }
    if (chunk.length) queue = queue.then(async () => {
      if (bytesWritten + chunk.length > maxUploadBytes) throw new Error('演示文件超过 DemoCenter 512 MB 上传上限');
      await writable.write(chunk);
      bytesWritten += chunk.length;
    });
    if (final) void queue.then(resolveFinished, rejectFinished);
  });
  try {
    for (const entry of prepared.entries) {
      const stream = entry.path.endsWith('.json') ? new ZipDeflate(entry.path, { level: 6 }) : new ZipPassThrough(entry.path);
      zip.add(stream);
      const reader = entry.file.stream().getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stream.push(value);
          await queue;
        }
      } finally { reader.releaseLock(); }
      stream.push(new Uint8Array(), true);
      await queue;
    }
    zip.end();
    await finished;
    await writable.close();
    return { bytesWritten };
  } catch (error) {
    zip.terminate();
    try { await writable.abort(); } catch { /* Preserve the original write error. */ }
    throw error;
  }
}
