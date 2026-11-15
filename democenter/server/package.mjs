import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import yauzl from 'yauzl';

export const MAX_UPLOAD_BYTES = 512_000_000;
export const MAX_ZIP_ENTRIES = 2_000;
export const MAX_UNCOMPRESSED_BYTES = 1_000_000_000;
export const MAX_ENTRY_BYTES = 512_000_000;
const MAX_JSON_BYTES = 128_000_000;
const ASSET_NAME = /^[a-f0-9]{64}\.(?:png|jpg|gif|webp|avif|bmp|ico|svg|woff|woff2|ttf|otf)$/;
const mimeByExtension = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
};

export class PackageError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

function allowedPath(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  const pieces = name.split('/');
  if (pieces.some(part => !part || part === '.' || part === '..')) return false;
  if (['package-manifest.json', 'manifest.json', 'steps.json'].includes(name)) return true;
  if (pieces.length === 2 && pieces[0] === 'events' && /^[A-Za-z0-9_-]{1,120}\.json$/.test(pieces[1])) return true;
  if (name === 'assets/index.json') return true;
  if (pieces.length === 2 && pieces[0] === 'assets' && ASSET_NAME.test(pieces[1])) return true;
  return false;
}

function crc32Update(crc, chunk) {
  for (const byte of chunk) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return crc >>> 0;
}

async function openZip(filename) {
  return new Promise((resolve, reject) => yauzl.open(filename, {
    lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true,
  }, (error, zip) => error ? reject(error) : resolve(zip)));
}

async function openEntry(zip, entry) {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
}

export async function extractPackage(zipPath, targetDir) {
  const zipStat = await stat(zipPath);
  if (zipStat.size > MAX_UPLOAD_BYTES) throw new PackageError('演示文件超过 512 MB 上传上限');
  await mkdir(targetDir, { recursive: true });
  let zip;
  try {
    zip = await openZip(zipPath);
    let entries = 0;
    let total = 0;
    const seen = new Set();
    await new Promise((resolve, reject) => {
      let finished = false;
      const fail = error => {
        if (finished) return;
        finished = true;
        zip.close();
        reject(error instanceof PackageError ? error : new PackageError(`演示包损坏：${error.message}`));
      };
      zip.on('error', fail);
      zip.on('end', () => { if (!finished) { finished = true; resolve(); } });
      zip.on('entry', entry => {
        (async () => {
          const name = entry.fileName;
          const directory = name === 'events/' || name === 'assets/';
          if (!directory && !allowedPath(name)) throw new PackageError(`演示包包含不允许的路径：${name}`);
          if (seen.has(name)) throw new PackageError(`演示包包含重复文件：${name}`);
          seen.add(name);
          if (++entries > MAX_ZIP_ENTRIES) throw new PackageError('演示包文件数量过多');
          if (entry.uncompressedSize > MAX_ENTRY_BYTES || (total += entry.uncompressedSize) > MAX_UNCOMPRESSED_BYTES) throw new PackageError('演示包解压后过大');
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (mode && mode !== (directory ? 0x4000 : 0x8000)) throw new PackageError('演示包不能包含链接或特殊文件');
          if (directory) {
            await mkdir(path.join(targetDir, name), { recursive: true });
            zip.readEntry();
            return;
          }
          const output = path.join(targetDir, ...name.split('/'));
          await mkdir(path.dirname(output), { recursive: true });
          const stream = await openEntry(zip, entry);
          let bytes = 0;
          let crc = 0xffffffff;
          const verify = new Transform({ transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > MAX_ENTRY_BYTES || bytes > entry.uncompressedSize) return callback(new PackageError('演示包文件解压后过大'));
            crc = crc32Update(crc, chunk);
            callback(null, chunk);
          } });
          await pipeline(stream, verify, createWriteStream(output, { flags: 'wx' }));
          if (bytes !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) throw new PackageError(`演示包文件校验失败：${name}`);
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  } catch (error) {
    if (error instanceof PackageError) throw error;
    throw new PackageError(`演示包损坏：${error.message}`);
  } finally { zip?.close(); }
}

async function readJson(dir, relative) {
  const filename = path.join(dir, relative);
  let bytes;
  try {
    const info = await stat(filename);
    if (!info.isFile() || info.size > MAX_JSON_BYTES) throw new PackageError(`${relative} 过大或无效`);
    bytes = await readFile(filename, 'utf8');
    return JSON.parse(bytes);
  } catch (error) {
    if (error instanceof PackageError) throw error;
    throw new PackageError(`无法读取演示包中的 ${relative}`);
  }
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function finiteNonnegative(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function validRect(value) {
  return isObject(value) && ['x', 'y', 'width', 'height'].every(key => finiteNonnegative(value[key]) && value[key] <= 1)
    && value.x + value.width <= 1.000001 && value.y + value.height <= 1.000001;
}

export async function inspectExtractedPackage(dir) {
  const packageManifest = await readJson(dir, 'package-manifest.json');
  if (!isObject(packageManifest) || packageManifest.packageFormatVersion !== 1) throw new PackageError('不支持的演示包版本');
  if (typeof packageManifest.demoId !== 'string' || !packageManifest.demoId || typeof packageManifest.exportedAt !== 'string' || !Number.isFinite(Date.parse(packageManifest.exportedAt))) throw new PackageError('演示包清单无效');
  const manifest = await readJson(dir, 'manifest.json');
  if (!isObject(manifest) || ![1, 2].includes(manifest.formatVersion) || manifest.id !== packageManifest.demoId || manifest.status !== 'ready') throw new PackageError('只可上传已完成的演示录制');
  if (typeof manifest.title !== 'string' || !manifest.title.trim()) throw new PackageError('演示标题无效');
  const steps = await readJson(dir, 'steps.json');
  if (!Array.isArray(steps) || steps.length === 0 || steps.some(step => !isObject(step) || typeof step.id !== 'string' || typeof step.title !== 'string' || !finiteNonnegative(step.at) || !validRect(step.rect))) throw new PackageError('演示至少需要一个有效热点');
  let files;
  try { files = (await readdir(path.join(dir, 'events'))).filter(name => name.endsWith('.json')); }
  catch { files = []; }
  if (!files.length) throw new PackageError('演示缺少有效录制事件');
  const events = [];
  for (const file of files.sort()) {
    const batch = await readJson(dir, `events/${file}`);
    if (!isObject(batch) || !Array.isArray(batch.events) || batch.events.some(event => !isObject(event) || !Number.isInteger(event.type) || !finiteNonnegative(event.timestamp) || !isObject(event.data))) throw new PackageError('演示录制事件无效');
    events.push(...batch.events);
  }
  if (!events.length || !events.some(event => event.type === 2)) throw new PackageError('演示缺少有效录制事件');
  let assets = null;
  let assetStatus = manifest.formatVersion === 1 ? 'legacy' : 'no-candidates';
  let resourceIssueCount = 0;
  if (manifest.formatVersion === 2) {
    const indexPath = path.join(dir, 'assets', 'index.json');
    try { await stat(indexPath); assets = await readJson(dir, 'assets/index.json'); }
    catch { assets = null; }
    if (assets !== null) {
      if (!isObject(assets) || assets.version !== 1 || !Array.isArray(assets.entries) || assets.entries.some(entry => !isObject(entry) || typeof entry.url !== 'string' || !['pending', 'failed', 'saved'].includes(entry.status))) {
        assets = null;
      }
    }
    if (assets !== null) {
      for (const entry of assets.entries) {
        if (entry.status !== 'saved') { resourceIssueCount++; continue; }
        if (typeof entry.filename !== 'string' || !ASSET_NAME.test(entry.filename) || entry.mime !== mimeByExtension[entry.filename.split('.').at(-1)] || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1) {
          assets = null;
          break;
        }
        try {
          const info = await stat(path.join(dir, 'assets', entry.filename));
          if (!info.isFile() || info.size !== entry.bytes) resourceIssueCount++;
        } catch { resourceIssueCount++; }
      }
    }
    if (assets === null) {
      resourceIssueCount = Math.max(resourceIssueCount, Number.isSafeInteger(manifest.offlineAssets?.discovered) ? manifest.offlineAssets.discovered : 0, 1);
      assetStatus = 'partial';
    } else {
      assetStatus = assets.entries.length === 0 ? 'no-candidates' : resourceIssueCount ? 'partial' : 'complete';
    }
  }
  return { packageManifest, manifest, steps, events: events.sort((a, b) => a.timestamp - b.timestamp), assets, assetStatus, resourceIssueCount };
}
