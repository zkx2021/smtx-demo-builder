import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { extractPackage, inspectExtractedPackage } from '../server/package.mjs';

const demoId = 'demo-11111111-1111-4111-8111-111111111111';
const assetName = `${'a'.repeat(64)}.png`;
const encode = value => strToU8(JSON.stringify(value));
const base = () => ({
  'package-manifest.json': encode({ packageFormatVersion: 1, demoId, exportedAt: new Date().toISOString() }),
  'manifest.json': encode({ formatVersion: 2, id: demoId, title: '测试演示', status: 'ready', offlineAssets: { discovered: 0 } }),
  'steps.json': encode([{ id: 'step-1', at: 0, title: '下一步', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }]),
  'events/': new Uint8Array(),
  'events/batch-1.json': encode({ type: 'EVENT_BATCH', events: [{ type: 2, timestamp: 1000, data: {} }], clicks: [] }),
  'assets/index.json': encode({ version: 1, entries: [] }),
});

async function withArchive(entries, action) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'democenter-package-'));
  const archive = path.join(temp, 'demo.smtxdemo');
  const extracted = path.join(temp, 'extracted');
  try {
    await writeFile(archive, zipSync(entries));
    await action({ archive, extracted });
  } finally { await rm(temp, { recursive: true, force: true }); }
}

test('extracts and validates a playable package', async () => {
  await withArchive(base(), async ({ archive, extracted }) => {
    await extractPackage(archive, extracted);
    const result = await inspectExtractedPackage(extracted);
    assert.equal(result.manifest.id, demoId);
    assert.equal(result.steps.length, 1);
    assert.equal(result.events.length, 1);
    assert.equal(result.assetStatus, 'no-candidates');
  });
});

test('rejects incomplete recordings and recordings without hotspots', async () => {
  for (const patch of [
    { 'manifest.json': encode({ formatVersion: 2, id: demoId, title: '测试', status: 'recording' }) },
    { 'steps.json': encode([]) },
  ]) {
    await withArchive({ ...base(), ...patch }, async ({ archive, extracted }) => {
      await extractPackage(archive, extracted);
      await assert.rejects(inspectExtractedPackage(extracted), /已完成|热点/);
    });
  }
});

test('reports missing saved resources as partial', async () => {
  const entries = { ...base(), 'assets/index.json': encode({ version: 1, entries: [
    { url: 'https://example.test/logo.png', context: 'img', status: 'saved', filename: assetName, mime: 'image/png', bytes: 8 },
  ] }) };
  await withArchive(entries, async ({ archive, extracted }) => {
    await extractPackage(archive, extracted);
    const result = await inspectExtractedPackage(extracted);
    assert.equal(result.assetStatus, 'partial');
    assert.equal(result.resourceIssueCount, 1);
  });
});

test('imports a missing or damaged resource index with a warning', async () => {
  for (const entries of [
    Object.fromEntries(Object.entries(base()).filter(([name]) => name !== 'assets/index.json')),
    { ...base(), 'assets/index.json': strToU8('{broken') },
  ]) {
    await withArchive(entries, async ({ archive, extracted }) => {
      await extractPackage(archive, extracted);
      const result = await inspectExtractedPackage(extracted);
      assert.equal(result.assetStatus, 'partial');
      assert.ok(result.resourceIssueCount >= 1);
      assert.equal(result.assets, null);
    });
  }
});

test('rejects unsafe ZIP paths and unknown package versions', async () => {
  await withArchive({ ...base(), '../escape.txt': strToU8('escape') }, async ({ archive, extracted }) => {
    await assert.rejects(extractPackage(archive, extracted), /路径|损坏/);
  });
  await withArchive({ ...base(), 'package-manifest.json': encode({ packageFormatVersion: 3, demoId, exportedAt: new Date().toISOString() }) }, async ({ archive, extracted }) => {
    await extractPackage(archive, extracted);
    await assert.rejects(inspectExtractedPackage(extracted), /版本/);
  });
});

test('rejects a truncated archive', async () => {
  await withArchive(base(), async ({ archive, extracted }) => {
    const bytes = await readFile(archive);
    await writeFile(archive, bytes.subarray(0, bytes.length - 10));
    await assert.rejects(extractPackage(archive, extracted), /损坏/);
  });
});
