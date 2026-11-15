import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { prepareDemoPackage, suggestedDemoPackageName, writeDemoPackage } from '../src/demo-package.ts';

type Entry = File | { [name: string]: Entry };
const demoId = 'demo-22222222-2222-4222-8222-222222222222';
const assetBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const filename = `${createHash('sha256').update(assetBytes).digest('hex')}.png`;
const file = (name: string, value: unknown) => new File([JSON.stringify(value)], name, { type: 'application/json' });

function directory(entries: { [name: string]: Entry }): FileSystemDirectoryHandle {
  const missing = () => new DOMException('Not found', 'NotFoundError');
  return {
    kind: 'directory', name: 'fixture',
    async getDirectoryHandle(name: string) {
      const entry = entries[name];
      if (!entry || entry instanceof File) throw missing();
      return directory(entry);
    },
    async getFileHandle(name: string) {
      const entry = entries[name];
      if (!(entry instanceof File)) throw missing();
      return { kind: 'file', name, getFile: async () => entry };
    },
    async *entries() {
      for (const [name, entry] of Object.entries(entries)) yield [name, { kind: entry instanceof File ? 'file' : 'directory' }];
    },
  } as unknown as FileSystemDirectoryHandle;
}

function fixture(options: { formatVersion?: 1 | 2; status?: string; steps?: unknown[]; events?: unknown[]; missingAsset?: boolean; eventName?: string } = {}) {
  const manifest = { formatVersion: options.formatVersion ?? 2, id: demoId, title: '创建虚拟机', sourceUrl: 'https://demo.test/', status: options.status ?? 'ready',
    offlineAssets: { discovered: 3, saved: 2, failed: 1, uniqueBytes: assetBytes.length, status: 'partial' } };
  const steps = options.steps ?? [{ id: 'step-1', at: 100, title: '新建虚拟机', rect: { x: .1, y: .2, width: .2, height: .1 } }];
  const events = options.events ?? [
    { type: 4, timestamp: 990, data: { href: 'https://demo.test/', width: 1280, height: 720 } },
    { type: 2, timestamp: 1000, data: { initialOffset: { top: 0, left: 0 }, node: {
      type: 0, id: 1, childNodes: [{ type: 2, id: 2, tagName: 'html', attributes: {}, childNodes: [
        { type: 2, id: 3, tagName: 'head', attributes: {}, childNodes: [] },
        { type: 2, id: 4, tagName: 'body', attributes: {}, childNodes: [] },
      ] }],
    } } },
  ];
  const assets = { 'index.json': file('index.json', { version: 1, entries: [
    { url: 'https://demo.test/a.png', context: 'img', status: 'saved', filename, bytes: assetBytes.length, mime: 'image/png' },
    { url: 'https://demo.test/b.png', context: 'css', status: 'saved', filename, bytes: assetBytes.length, mime: 'image/png' },
    { url: 'https://demo.test/missing.png', context: 'img', status: 'failed', reason: 'HTTP 404' },
  ] }), ...options.missingAsset ? {} : { [filename]: new File([assetBytes], filename) } };
  const demo = { 'manifest.json': file('manifest.json', manifest), 'steps.json': file('steps.json', steps),
    events: { [options.eventName ?? 'batch-1.json']: file('batch-1.json', { events, clicks: [] }) },
    ...manifest.formatVersion === 2 ? { assets } : {} };
  return { root: directory({ demos: { [demoId]: demo } }), manifest, steps, events };
}

test('prepares a portable package and includes a shared asset file only once', async () => {
  const { root, manifest } = fixture();
  const prepared = await prepareDemoPackage(root, demoId, '2026-11-15T00:00:00.000Z');
  assert.deepEqual(prepared.entries.map(entry => entry.path), ['assets/' + filename, 'assets/index.json', 'events/batch-1.json', 'manifest.json', 'package-manifest.json', 'steps.json']);
  assert.equal(prepared.resourceIssueCount, 1);
  assert.deepEqual(JSON.parse(await prepared.entries.find(entry => entry.path === 'manifest.json')!.file.text()), manifest);
  assert.deepEqual(new Uint8Array(await prepared.entries[0].file.arrayBuffer()), assetBytes);
  assert.deepEqual(prepared.packageManifest, { packageFormatVersion: 1, demoId, exportedAt: '2026-11-15T00:00:00.000Z' });
});

test('allows v1 and missing saved assets with an explicit issue count', async () => {
  const v1 = await prepareDemoPackage(fixture({ formatVersion: 1 }).root, demoId);
  assert.equal(v1.entries.some(entry => entry.path.startsWith('assets/')), false);
  const missing = await prepareDemoPackage(fixture({ missingAsset: true }).root, demoId);
  assert.equal(missing.resourceIssueCount, 3);
  assert.equal(missing.entries.some(entry => entry.path === 'assets/' + filename), false);
});

test('rejects unfinished recordings, missing hotspots, invalid events and unsafe batch names', async () => {
  await assert.rejects(prepareDemoPackage(fixture({ status: 'recording' }).root, demoId), /已完成/);
  await assert.rejects(prepareDemoPackage(fixture({ steps: [] }).root, demoId), /热点/);
  await assert.rejects(prepareDemoPackage(fixture({ events: [] }).root, demoId), /事件/);
  await assert.rejects(prepareDemoPackage(fixture({ events: [{ type: 2, timestamp: 1000, data: {} }] }).root, demoId), /事件/);
  await assert.rejects(prepareDemoPackage(fixture({ events: [{ type: 2, timestamp: 1000, data: [] }] }).root, demoId), /事件/);
  await assert.rejects(prepareDemoPackage(fixture({ eventName: '../escape.json' }).root, demoId), /文件名/);
});

test('cleans Windows reserved characters from the suggested filename', () => {
  assert.equal(suggestedDemoPackageName('创建:虚拟机?/测试*'), '创建_虚拟机_测试.smtxdemo');
  assert.equal(suggestedDemoPackageName('CON'), 'CON_.smtxdemo');
  assert.equal(suggestedDemoPackageName('CON.notes'), 'CON_.notes.smtxdemo');
  assert.equal(suggestedDemoPackageName(`${'a'.repeat(99)}.`), `${'a'.repeat(99)}.smtxdemo`);
});

test('rejects packages over DemoCenter entry and uncompressed size limits before opening output', async () => {
  const base = await prepareDemoPackage(fixture().root, demoId);
  const tooMany = { ...base, entries: [...base.entries] };
  for (let i = 0; tooMany.entries.length <= 2000; i++) {
    tooMany.entries.push({ path: `events/extra-${i}.json`, file: new Blob(['{}']) });
  }
  const countTarget = destination();
  await assert.rejects(writeDemoPackage(tooMany, countTarget.handle), /文件数量/);
  assert.equal(countTarget.started, false);

  const oversized = (size: number) => {
    const blob = new Blob(['{}']);
    Object.defineProperty(blob, 'size', { value: size });
    return blob;
  };
  const oneLarge = { ...base, entries: base.entries.map(entry => entry.path.startsWith('assets/') && entry.path !== 'assets/index.json'
    ? { ...entry, file: oversized(512_000_001) } : entry) };
  const largeTarget = destination();
  await assert.rejects(writeDemoPackage(oneLarge, largeTarget.handle), /单个文件/);
  assert.equal(largeTarget.started, false);

  const totalLarge = { ...base, entries: [...base.entries,
    { path: 'assets/' + 'a'.repeat(64) + '.png', file: oversized(500_000_000) },
    { path: 'assets/' + 'b'.repeat(64) + '.png', file: oversized(500_000_000) }] };
  const totalTarget = destination();
  await assert.rejects(writeDemoPackage(totalLarge, totalTarget.handle), /解压后/);
  assert.equal(totalTarget.started, false);

  const largeJson = { ...base, entries: base.entries.map(entry => entry.path === 'steps.json'
    ? { ...entry, file: oversized(128_000_001) } : entry) };
  const jsonTarget = destination();
  await assert.rejects(writeDemoPackage(largeJson, jsonTarget.handle), /JSON/);
  assert.equal(jsonTarget.started, false);
});

function destination(failAt = Infinity) {
  const chunks: Uint8Array[] = [];
  let closed = false;
  let aborted = false;
  let started = false;
  const handle = { createWritable: async () => { started = true; return ({
    async write(value: BufferSource) {
      if (chunks.length >= failAt) throw new Error('Disk full');
      chunks.push(new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
    },
    async close() { closed = true; },
    async abort() { aborted = true; },
  }); } } as unknown as FileSystemFileHandle;
  return { handle, chunks, get started() { return started; }, get closed() { return closed; }, get aborted() { return aborted; } };
}

test('writes a streamable ZIP accepted by the DemoCenter package contract', async () => {
  const prepared = await prepareDemoPackage(fixture().root, demoId);
  const target = destination();
  const result = await writeDemoPackage(prepared, target.handle);
  assert.equal(target.closed, true);
  assert.equal(target.aborted, false);
  assert.ok(target.chunks.length > 1);
  const bytes = Buffer.concat(target.chunks);
  assert.equal(result.bytesWritten, bytes.length);
  const zipped = unzipSync(bytes);
  assert.equal(JSON.parse(strFromU8(zipped['package-manifest.json'])).packageFormatVersion, 1);
  assert.equal(JSON.parse(strFromU8(zipped['manifest.json'])).id, demoId);
  assert.equal(JSON.parse(strFromU8(zipped['steps.json'])).length, 1);
  assert.deepEqual(zipped[`assets/${filename}`], assetBytes);
  assert.equal(Object.keys(zipped).filter(path => path === `assets/${filename}`).length, 1);
});

test('aborts a partial output when writing fails', async () => {
  const prepared = await prepareDemoPackage(fixture().root, demoId);
  const target = destination(1);
  await assert.rejects(writeDemoPackage(prepared, target.handle), /Disk full/);
  assert.equal(target.closed, false);
  assert.equal(target.aborted, true);
});
