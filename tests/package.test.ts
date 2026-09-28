import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageScript = fileURLToPath(new URL('../scripts/package.ps1', import.meta.url));

async function fixture(manifestVersion = '0.1.0') {
  const root = await mkdtemp(join(tmpdir(), 'smtx-package-test-'));
  const dist = join(root, 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  const manifest = JSON.stringify({
    manifest_version: 3, name: 'SMTX Demo Builder',
    description: '录制网页操作、配置交互热点并回放演示。演示数据仅存储于本地。',
    version: manifestVersion,
  });
  await writeFile(join(root, 'manifest.json'), manifest);
  await writeFile(join(dist, 'manifest.json'), manifest);
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>Demo</title>');
  await writeFile(join(dist, 'recorder.js'), '/* recorder */');
  await writeFile(join(dist, 'sw.js'), '/* worker */');
  await writeFile(join(dist, 'assets', 'runtime-AbCd1234.js'), '/* runtime */');
  return root;
}

function packageExtension(root: string) {
  return spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-File', packageScript,
    '-ProjectRoot', root,
    '-OutputDirectory', join(root, 'release'),
  ], { encoding: 'utf8' });
}

test('package archive contains only loadable extension files at its root and a matching SHA-256',
  { skip: process.platform !== 'win32' }, async () => {
    const root = await fixture();
    try {
      const result = packageExtension(root);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const release = join(root, 'release');
      const archiveName = 'SMTX-Demo-Builder-v0.1.0.zip';
      const checksumName = 'SMTX-Demo-Builder-v0.1.0.sha256';
      assert.deepEqual((await readdir(release)).sort(), [archiveName, checksumName].sort());
      const archive = await readFile(join(release, archiveName));
      const expectedHash = createHash('sha256').update(archive).digest('hex');
      assert.equal((await readFile(join(release, checksumName), 'utf8')).trim(),
        `${expectedHash}  ${archiveName}`);

      const unpacked = join(root, 'unpacked');
      const expand = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Expand-Archive -LiteralPath $env:SMTX_ARCHIVE_PATH -DestinationPath $env:SMTX_UNPACKED_PATH -ErrorAction Stop',
      ], {
        encoding: 'utf8',
        env: { ...process.env, SMTX_ARCHIVE_PATH: join(release, archiveName), SMTX_UNPACKED_PATH: unpacked },
      });
      assert.equal(expand.status, 0, `${expand.stdout}\n${expand.stderr}`);
      assert.deepEqual((await readdir(unpacked)).sort(),
        ['assets', 'index.html', 'manifest.json', 'recorder.js', 'sw.js'].sort());
      assert.equal(await readFile(join(unpacked, 'assets', 'runtime-AbCd1234.js'), 'utf8'), '/* runtime */');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test('package rejects a version mismatch', { skip: process.platform !== 'win32' }, async () => {
  const root = await fixture('0.2.0');
  try {
    const result = packageExtension(root);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /version/i);
    assert.deepEqual(await readdir(root), ['dist', 'manifest.json', 'package.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('package rejects unexpected files instead of distributing them',
  { skip: process.platform !== 'win32' }, async () => {
    const root = await fixture();
    try {
      await writeFile(join(root, 'dist', 'fixture.html'), 'test-only page');
      const result = packageExtension(root);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /fixture\.html/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test('package rejects a built manifest that is stale relative to source',
  { skip: process.platform !== 'win32' }, async () => {
    const root = await fixture();
    try {
      const sourceManifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
      sourceManifest.description = '新版描述';
      await writeFile(join(root, 'manifest.json'), JSON.stringify(sourceManifest));
      const result = packageExtension(root);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /source manifest/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test('package rejects nested non-runtime content in assets',
  { skip: process.platform !== 'win32' }, async () => {
    const root = await fixture();
    try {
      await mkdir(join(root, 'dist', 'assets', 'demos'));
      await writeFile(join(root, 'dist', 'assets', 'demos', 'steps.json'), '{}');
      const result = packageExtension(root);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /assets.*demos/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test('package rejects non-hashed files in assets',
  { skip: process.platform !== 'win32' }, async () => {
    const root = await fixture();
    try {
      await writeFile(join(root, 'dist', 'assets', 'fixture.html'), 'test-only page');
      const result = packageExtension(root);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /fixture\.html/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
