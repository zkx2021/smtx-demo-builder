import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { cleanupStaleUploads, createApp } from '../server/app.mjs';

const sourceDemoId = 'demo-22222222-2222-4222-8222-222222222222';
const encode = value => strToU8(JSON.stringify(value));
const archive = zipSync({
  'package-manifest.json': encode({ packageFormatVersion: 1, demoId: sourceDemoId, exportedAt: new Date().toISOString() }),
  'manifest.json': encode({ formatVersion: 2, id: sourceDemoId, title: '源录制', status: 'ready' }),
  'steps.json': encode([{ id: 'step-1', at: 0, title: '点击', rect: { x: 0.1, y: 0.2, width: 0.1, height: 0.1 } }]),
  'events/batch.json': encode({ events: [
    { type: 4, timestamp: 990, data: { href: 'https://demo.test/', width: 1280, height: 720 } },
    { type: 2, timestamp: 1000, data: {} },
  ], clicks: [] }),
  'assets/index.json': encode({ version: 1, entries: [] }),
});

class FakePool {
  demos = [];
  environments = [];
  async query(sql, values = []) {
    if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
    if (sql.startsWith('INSERT INTO environments')) {
      const [id, name, purpose, url, external_status, usage_status, release_at, note, accounts] = values;
      const row = { id, name, purpose, url, external_status, usage_status, release_at, note,
        accounts: JSON.parse(accounts), updated_at: new Date() };
      this.environments.push(row);
      return { rows: [row] };
    }
    if (sql === 'SELECT * FROM environments ORDER BY updated_at DESC, name ASC') return { rows: [...this.environments] };
    if (sql === 'SELECT * FROM environments WHERE id=$1') return { rows: this.environments.filter(row => row.id === values[0]) };
    if (sql.startsWith('UPDATE environments')) {
      const row = this.environments.find(item => item.id === values[0]);
      if (!row) return { rows: [] };
      [row.name, row.purpose, row.url, row.external_status, row.usage_status, row.release_at, row.note] = values.slice(1, 8);
      row.accounts = JSON.parse(values[8]);
      row.updated_at = new Date();
      return { rows: [row] };
    }
    if (sql.startsWith('INSERT INTO demos')) {
      const [id, source_demo_id, title, description, product_version, tags, uploader, folder_id,
        format_version, package_format_version, step_count, asset_status, resource_issue_count] = values;
      const row = { id, source_demo_id, title, description, product_version, tags: JSON.parse(tags), uploader,
        folder_id, format_version, package_format_version, step_count, asset_status, resource_issue_count,
        uploaded_at: new Date() };
      this.demos.push(row);
      return { rows: [row] };
    }
    if (sql === 'SELECT * FROM demos ORDER BY uploaded_at DESC, title ASC') return { rows: [...this.demos] };
    if (sql === 'SELECT id FROM demos WHERE id=$1') return { rows: this.demos.filter(row => row.id === values[0]).map(row => ({ id: row.id })) };
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

async function withServer(action) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'democenter-api-'));
  const pool = new FakePool();
  const server = createApp({ pool, dataDir, distDir: path.join(dataDir, 'no-dist') }).listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    await action({ base, pool });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('health checks database readiness and validation errors are JSON', async () => {
  await withServer(async ({ base }) => {
    const health = await fetch(`${base}/api/health`);
    assert.deepEqual(await health.json(), { ok: true });
    const invalid = await fetch(`${base}/api/environments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /名称/);
  });
});

test('creates and updates an environment with the requestable usage status', async () => {
  await withServer(async ({ base }) => {
    const createdResponse = await fetch(`${base}/api/environments`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '待申请演示环境', externalStatus: 'internal', usageStatus: 'requestable' }) });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.usageStatus, 'requestable');
    assert.equal(created.externalStatus, 'internal');
    const listed = await (await fetch(`${base}/api/environments`)).json();
    assert.equal(listed[0].usageStatus, 'requestable');
    const updatedResponse = await fetch(`${base}/api/environments/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ usageStatus: 'occupied', releaseAt: '2026-11-20T10:00:00.000Z' }) });
    assert.equal(updatedResponse.status, 200);
    const backToRequestable = await fetch(`${base}/api/environments/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ usageStatus: 'requestable' }) });
    assert.equal(backToRequestable.status, 200);
    assert.equal((await backToRequestable.json()).releaseAt, null);
  });
});

test('inspects, publishes, lists and plays a package without replacing source IDs', async () => {
  await withServer(async ({ base }) => {
    const form = new FormData();
    form.append('file', new Blob([archive]), 'demo.smtxdemo');
    const inspectedResponse = await fetch(`${base}/api/demos/inspect`, { method: 'POST', body: form });
    assert.equal(inspectedResponse.status, 200);
    const inspected = await inspectedResponse.json();
    assert.equal(inspected.sourceDemoId, sourceDemoId);
    assert.equal(inspected.stepCount, 1);
    const publishedResponse = await fetch(`${base}/api/demos`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadToken: inspected.uploadToken, title: '发布标题', tags: ['场景'] }) });
    assert.equal(publishedResponse.status, 201);
    const published = await publishedResponse.json();
    assert.notEqual(published.id, sourceDemoId);
    assert.equal(published.title, '发布标题');
    assert.equal((await (await fetch(`${base}/api/demos`)).json()).length, 1);
    const stepsResponse = await fetch(`${base}/api/demos/${published.id}/steps`);
    assert.equal(stepsResponse.status, 200);
    assert.equal((await stepsResponse.json())[0].title, '点击');
    const playback = await fetch(`${base}/api/demos/${published.id}/playback`);
    assert.equal(playback.status, 200);
    const loaded = await playback.json();
    assert.equal(loaded.manifest.id, sourceDemoId);
    assert.equal(loaded.events[0].timestamp, 990);
    assert.equal(loaded.assetStatus, 'no-candidates');
    assert.equal(loaded.resourceIssueCount, 0);
    const again = await fetch(`${base}/api/demos`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadToken: inspected.uploadToken, title: '重复发布' }) });
    assert.equal(again.status, 400);
  });
});

test('cleans stale temporary uploads without removing recent inspections', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'democenter-cleanup-'));
  try {
    const tmp = path.join(dataDir, 'tmp');
    const staging = path.join(dataDir, 'staging');
    await Promise.all([mkdir(tmp), mkdir(staging)]);
    const stale = path.join(tmp, 'stale');
    const recent = path.join(staging, 'recent');
    await writeFile(stale, 'old');
    await writeFile(recent, 'new');
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(stale, old, old);
    await cleanupStaleUploads(dataDir);
    await assert.rejects(stat(stale), { code: 'ENOENT' });
    assert.equal((await stat(recent)).isFile(), true);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
