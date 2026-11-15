import { chromium } from 'playwright-core';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.argv.includes('--require-democenter') && !process.env.DEMO_CENTER_URL) {
  throw new Error('Set DEMO_CENTER_URL to run the required DemoCenter import and playback checks.');
}

const profile = await mkdtemp(join(tmpdir(), 'hci-demo-smoke-'));
const extensionPath = join(profile, 'extension');
await cp(resolve('dist'), extensionPath, { recursive: true });
const manifestPath = join(extensionPath, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(manifestPath, JSON.stringify(manifest));
const fixture = await readFile(resolve('public/fixture.html'));
const fontDirectory = resolve('node_modules/playwright-core/lib/vite/traceViewer');
const font = await readFile(join(fontDirectory, (await readdir(fontDirectory)).find(name => name.endsWith('.ttf'))));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64');
const requestCounts = new Map();
const slowSvg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="3" fill="red"/></svg>';
const slowFilename = `${createHash('sha256').update(slowSvg).digest('hex')}.svg`;
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://fixture.test').pathname;
  requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
  response.setHeader('Cache-Control', 'no-store');
  if (path === '/assets/pending.png') return; // Navigation must leave this candidate incomplete.
  if (path === '/assets/missing.png') { response.writeHead(404); response.end(); return; }
  if (path === '/assets/large.png') { response.setHeader('Content-Type', 'image/png'); response.end(Buffer.alloc(10 * 1024 * 1024 + 1)); return; }
  if (path === '/assets/html.png') { response.setHeader('Content-Type', 'image/png'); response.end('<html>login required</html>'); return; }
  if (path.endsWith('.css')) { response.setHeader('Content-Type', 'text/css'); response.end('body { outline-color: blue; }'); return; }
  if (path === '/assets/icon.svg') { response.setHeader('Content-Type', 'image/svg+xml'); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>'); return; }
  if (path === '/assets/slow-write.svg') { response.setHeader('Content-Type', 'image/svg+xml'); response.end(slowSvg); return; }
  if (path === '/assets/icons.ttf') { response.setHeader('Content-Type', 'font/ttf'); response.end(font); return; }
  if (path.startsWith('/next/assets/')) { response.setHeader('Content-Type', 'image/png'); response.end(png); return; }
  if (path.startsWith('/assets/')) { response.setHeader('Content-Type', 'image/png'); response.end(png); return; }
  if (path.startsWith('/scripts/')) { response.setHeader('Content-Type', 'text/javascript'); response.end('window.fixtureScriptLoaded = true;'); return; }
  if (path.startsWith('/api/')) { response.setHeader('Content-Type', 'application/json'); response.end('{}'); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(fixture.toString().replaceAll('__FIXTURE_PORT__', String(server.address().port))
    .replace('<main>', `<main><div id="dynamic-background" style="width:16px;height:16px;display:inline-block;position:relative;border:1px solid blue;padding:1px;margin:1px;color:blue;opacity:1;background-image:url('/assets/background.png')"></div><div id="priority-background" style="width:16px;height:16px;display:inline-block;position:relative;border:1px solid blue;padding:1px;margin:1px;color:blue;opacity:1;background-image:url('/assets/background.png')"></div>${path.startsWith('/next/') ? '<img src="../assets/navigation.png?q=1#part" alt="导航后图片" width="16" height="16" />' : ''}`)
    .replace('src="/assets/pixel.png"', 'src="/assets/pixel.png?token=hidden#fragment" srcset="/assets/pixel.png?token=hidden#fragment 1x, /assets/duplicate.png 2x"'));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}/fixture.html`;

async function demoBytes(browserPage, demoId) {
  return browserPage.evaluate(async id => {
    const root = await navigator.storage.getDirectory();
    const folder = await (await root.getDirectoryHandle('demos')).getDirectoryHandle(id);
    const result = { total: 0, withoutAssets: 0, assets: 0 };
    async function visit(directory, inAssets = false) {
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind === 'directory') await visit(handle, inAssets || name === 'assets');
        else {
          const size = (await handle.getFile()).size;
          result.total += size;
          if (inAssets) result.assets += size;
          else result.withoutAssets += size;
        }
      }
    }
    await visit(folder);
    return result;
  }, demoId);
}

async function beginFrameProbe(browserPage) {
  await browserPage.evaluate(() => {
    const probe = { gaps: [], last: null, end: performance.now() + 2200 };
    window.frameProbe = probe;
    function tick(now) {
      if (probe.last !== null) probe.gaps.push(now - probe.last);
      probe.last = now;
      if (now < probe.end) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

async function endFrameProbe(browserPage) {
  await browserPage.waitForTimeout(2300);
  return browserPage.evaluate(() => ({ maxGapMs: Math.max(...window.frameProbe.gaps), frames: window.frameProbe.gaps.length }));
}

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const context = await chromium.launchPersistentContext(profile, {
  executablePath: edgePath,
  headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
});

try {
  const errors = [];
  context.on('page', openPage => openPage.on('pageerror', error => errors.push(error.message)));
  await context.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: () => navigator.storage.getDirectory() });
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => {
      const root = await navigator.storage.getDirectory();
      return root.getFileHandle('smoke-export.smtxdemo', { create: true });
    } });
    if (typeof FileSystemHandle !== 'undefined') {
      FileSystemHandle.prototype.queryPermission ??= async () => 'granted';
      FileSystemHandle.prototype.requestPermission ??= async () => 'granted';
    }
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/index.html`);
  await page.getByRole('heading', { name: 'SMTX Demo Builder' }).waitFor({ timeout: 10000 });
  await page.getByText('Record · Add Hotspots · Replay').waitFor();
  await page.getByText('选择一个本地目录，作为演示素材库').waitFor();
  const installedManifest = await page.evaluate(() => chrome.runtime.getManifest());
  if (installedManifest.name !== 'SMTX Demo Builder') throw new Error(`Unexpected extension name: ${installedManifest.name}`);
  if (installedManifest.description !== '录制网页操作、配置交互热点并回放演示。演示数据仅存储于本地。') throw new Error(`Unexpected extension description: ${installedManifest.description}`);
  if (await page.title() !== 'SMTX Demo Builder') throw new Error(`Unexpected page title: ${await page.title()}`);
  const panelBehavior = await page.evaluate(() => chrome.sidePanel.getPanelBehavior());
  if (!panelBehavior.openPanelOnActionClick) throw new Error('Toolbar action does not open the side panel');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`Extension loaded in Edge: ${id}`);
  await page.getByRole('button', { name: '选择素材库目录' }).click();
  await page.getByText('素材库：').waitFor({ timeout: 10000 });
  await page.getByLabel('目标页面地址').fill(address);
  const targetPagePromise = context.waitForEvent('page');
  await page.getByRole('button', { name: '打开目标页面' }).click();
  const target = await targetPagePromise;
  await target.getByRole('button', { name: '新建虚拟机' }).waitFor();
  // Simulate a real HTTP intranet's isolated world: getRandomValues exists but randomUUID does not.
  await page.evaluate(async address => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === address);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => {
      Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    } });
  }, address);
  await page.getByLabel('演示名称').fill('创建虚拟机');
  await page.getByRole('button', { name: '开始录制' }).click();
  await page.locator('.notice').waitFor({ timeout: 10000 });
  const recordingNotice = await page.locator('.notice').innerText();
  if (!recordingNotice.startsWith('录制进行中')) throw new Error(`Recording did not start: ${recordingNotice}`);
  async function readInitialAssetStorage() { return page.evaluate(async () => {
    const { activeSession } = await chrome.storage.local.get('activeSession');
    const root = await navigator.storage.getDirectory();
    const demo = await (await root.getDirectoryHandle('demos')).getDirectoryHandle(activeSession.demoId);
    const demoManifest = JSON.parse(await (await demo.getFileHandle('manifest.json')).getFile().then(file => file.text()));
    let assetIndex = null;
    try {
      const assets = await demo.getDirectoryHandle('assets');
      assetIndex = JSON.parse(await (await assets.getFileHandle('index.json')).getFile().then(file => file.text()));
    } catch (error) { if (error.name !== 'NotFoundError') throw error; }
    return { version: demoManifest.formatVersion, assetIndex, demoId: activeSession.demoId };
  }); }
  let assetStorage = await readInitialAssetStorage();
  for (let attempt = 0; !assetStorage.assetIndex && attempt < 30; attempt++) {
    await page.waitForTimeout(100);
    assetStorage = await readInitialAssetStorage();
  }
  if (assetStorage.version !== 2) throw new Error(`New demo must use format version 2, got ${assetStorage.version}`);
  if (assetStorage.assetIndex?.version !== 1 || !Array.isArray(assetStorage.assetIndex.entries)) {
    throw new Error(`New demo must create assets/index.json: ${JSON.stringify(assetStorage.assetIndex)}`);
  }
  const recordedDemoItem = page.locator('.demo-item').filter({ hasText: '创建虚拟机' });
  assert.equal(await recordedDemoItem.getByRole('button', { name: '删除' }).isDisabled(), true,
    'The active recording must not be deletable');
  assert.equal(await recordedDemoItem.getByRole('button', { name: '导出' }).isDisabled(), true,
    'The active recording must not be exportable');
  assert.equal(await recordedDemoItem.getByRole('button', { name: '删除' }).evaluate(button => getComputedStyle(button).color),
    'rgb(255, 255, 255)', 'Danger action text must remain readable against its red background');
  await target.getByRole('button', { name: '新建虚拟机' }).click();
  await page.waitForTimeout(1200);
  // Removing discovery, transport or persistence must fail here, before reload.
  async function readAssets() {
    return page.evaluate(async demoId => {
      const root = await navigator.storage.getDirectory();
      const demo = await (await root.getDirectoryHandle('demos')).getDirectoryHandle(demoId);
      const assets = await demo.getDirectoryHandle('assets');
      const index = JSON.parse(await (await assets.getFileHandle('index.json')).getFile().then(file => file.text()));
      const manifest = JSON.parse(await (await demo.getFileHandle('manifest.json')).getFile().then(file => file.text()));
      const files = [];
      for await (const [name, handle] of assets.entries()) if (name !== 'index.json') {
        try { files.push({ name, size: (await handle.getFile()).size }); }
        catch (error) { throw new Error(`Read asset ${name}: ${error}`); }
      }
      const events = [];
      for await (const [name, handle] of (await demo.getDirectoryHandle('events')).entries()) {
        try { events.push(JSON.parse(await (await handle.getFile()).text())); }
        catch (error) { throw new Error(`Read event ${name}: ${error}`); }
      }
      return { index, manifest, files, events };
    }, assetStorage.demoId);
  }
  async function waitForAsset(path, status) {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const saved = await readAssets();
        const entry = saved.index.entries.find(entry => new URL(entry.url).pathname === path);
        if (entry?.status === status) return entry;
      } catch (error) {
        // A File snapshot can become unreadable when OPFS atomically replaces its index.
        if (!/NotFoundError|NotReadableError/.test(String(error))) throw error;
      }
      await page.waitForTimeout(100);
    }
    assert.fail(`Expected ${path} asset to be ${status}: ${JSON.stringify((await readAssets()).index)}`);
  }
  for (const path of ['/assets/pixel.png', '/assets/duplicate.png', '/assets/background.png', '/assets/icon.svg', '/assets/icons.ttf']) await waitForAsset(path, 'saved');
  await target.evaluate(() => { const image = new Image(); image.src = '/assets/pending.png'; document.body.append(image); });
  await waitForAsset('/assets/pending.png', 'pending');
  const beforeReload = await readAssets();
  assert.ok(beforeReload.events.length > 0, 'rrweb events must persist before navigation even when crypto.randomUUID is unavailable');
  assert.ok(beforeReload.events.flatMap(batch => batch.clicks).some(click => click.label === '新建虚拟机'), 'Click IDs must also work without crypto.randomUUID');
  await target.goto(new URL('/next/area/view.html', address).href);
  await waitForAsset('/next/assets/navigation.png', 'saved');
  await target.evaluate(() => {
    document.querySelector('#dynamic-background').style.backgroundImage = 'url("../assets/dynamic.png?q=1#part")';
    document.querySelector('#priority-background').style.setProperty('background-image', 'url("../assets/dynamic.png?q=1#part")', 'important');
  });
  await waitForAsset('/next/assets/dynamic.png', 'saved');
  await target.getByRole('button', { name: '新建虚拟机' }).click();
  await target.getByRole('button', { name: '确认创建' }).click();
  await target.getByText('demo-vm 创建成功').waitFor();
  await page.waitForTimeout(1200);
  await page.evaluate(filename => {
    const original = FileSystemFileHandle.prototype.createWritable;
    const gate = new Promise(resolve => { window.releaseAssetWrite = resolve; });
    FileSystemFileHandle.prototype.createWritable = async function(...args) {
      const writer = await original.apply(this, args);
      if (this.name !== filename) return writer;
      return { write: writer.write.bind(writer), close: async () => {
        window.assetWriteStarted = true;
        await gate;
        return writer.close();
      } };
    };
  }, slowFilename);
  await target.evaluate(() => { const image = new Image(); image.src = '/assets/slow-write.svg'; document.body.append(image); });
  await page.waitForFunction(() => window.assetWriteStarted === true);
  await page.getByRole('button', { name: '结束录制并保存' }).click();
  await page.getByText(/保存已中断.*30 秒/).waitFor({ timeout: 35000 });
  assert.equal(await page.evaluate(async () => (await chrome.storage.local.get('activeSession')).activeSession?.demoId), assetStorage.demoId, 'A timed-out save must retain its recovery session');
  assert.equal(await page.getByRole('button', { name: '开始录制', exact: true }).count(), 0, 'A timed-out save must block a new recording');
  assert.ok((await readAssets()).events.length >= beforeReload.events.length, 'A timed-out save must preserve already persisted event batches');
  await page.evaluate(() => window.releaseAssetWrite());
  await waitForAsset('/assets/slow-write.svg', 'failed');
  console.log('Thirty-second interrupted save retained its recovery session and persisted events; retrying after disk recovery.');
  const editorPagePromise = context.waitForEvent('page');
  await page.getByRole('button', { name: '结束录制并保存' }).click();
  const editor = await editorPagePromise;
  const captured = await readAssets();
  const entryFor = path => captured.index.entries.find(entry => new URL(entry.url).pathname === path);
  assert.equal(entryFor('/assets/pixel.png').filename, entryFor('/assets/duplicate.png').filename, 'Identical image bytes must share one file');
  for (const entry of captured.index.entries.filter(entry => entry.status === 'saved')) assert.ok(captured.files.some(file => file.name === entry.filename && file.size === entry.bytes));
  assert.equal(captured.files.length, new Set(captured.index.entries.filter(entry => entry.status === 'saved').map(entry => entry.filename)).size + 1);
  assert.ok(captured.files.some(file => file.name === slowFilename && file.size === Buffer.byteLength(slowSvg)), 'Expired writes retain their generated orphan file');
  // Edge may reject fetch before delivering the navigation's Port disconnect.
  for (const [path, reason] of [['/assets/html.png', /Unsupported|mismatch/i], ['/assets/large.png', /10 MB/], ['/assets/missing.png', /HTTP 404/], ['/assets/cross.png', /cross.origin/i], ['/external.css', /stylesheet|cross.origin/i], ['/assets/pending.png', /disconnect|finish|navigation|fetch/i], ['/assets/slow-write.svg', /timed out/]]) {
    assert.equal(entryFor(path)?.status, 'failed', `${path} must be an explicit failure`);
    assert.match(entryFor(path)?.reason ?? '', reason, `${path} must have a named failure`);
  }
  assert.equal(captured.manifest.offlineAssets.status, 'partial');
  assert.ok(captured.events.length >= beforeReload.events.length, 'Navigation must preserve prior event files');
  assert.ok(captured.events.flatMap(batch => batch.events).filter(event => event.type === 2).length >= 2, 'Capture must reconnect after reload');
  const dynamicStyles = captured.events.flatMap(batch => batch.events).filter(event => event.type === 3 && event.data.source === 0)
    .flatMap(event => event.data.attributes).map(change => change.attributes.style?.['background-image']);
  assert.ok(dynamicStyles.some(value => typeof value === 'string' && value.includes('../assets/dynamic.png')), 'Regression must record a relative style diff string after navigation');
  assert.ok(dynamicStyles.some(value => Array.isArray(value) && value[0].includes('../assets/dynamic.png') && value[1] === 'important'), 'Regression must record the priority tuple shape');
  assert.equal(requestCounts.get('/scripts/not-an-asset.png'), 2, 'Recorder must not fetch scripts discovered in performance entries');
  assert.equal(requestCounts.get('/api/not-an-asset.png'), 2, 'Recorder must not fetch XHR/fetch resources');
  assert.ok(!captured.index.entries.some(entry => /\/(scripts|api)\//.test(entry.url)), 'Non-assets must not enter the index');
  console.log(`Static assets persisted: ${captured.manifest.offlineAssets.saved} saved, ${captured.manifest.offlineAssets.failed} named failures, ${captured.files.length} unique files; reload retained events.`);
  const panelCoverage = page.getByRole('region', { name: '离线资源覆盖' });
  await panelCoverage.getByText(`已保存 ${captured.manifest.offlineAssets.saved} / 已发现 ${captured.manifest.offlineAssets.discovered} 项离线资源`).waitFor();
  await panelCoverage.getByText('离线资源不完整').waitFor();
  assert.match(await panelCoverage.innerText(), /仅表示已发现的受支持静态资源/);
  assert.match(await panelCoverage.innerText(), /html\.png/);
  assert.doesNotMatch(await panelCoverage.innerText(), /secret=|token=|#private|#fragment/);
  await page.evaluate(async demoId => {
    const root = await navigator.storage.getDirectory();
    const folder = await (await root.getDirectoryHandle('demos')).getDirectoryHandle(demoId);
    const indexHandle = await (await folder.getDirectoryHandle('assets')).getFileHandle('index.json');
    const manifestHandle = await folder.getFileHandle('manifest.json');
    const index = JSON.parse(await (await indexHandle.getFile()).text());
    const manifest = JSON.parse(await (await manifestHandle.getFile()).text());
    index.entries.push({ url: `${new URL(manifest.sourceUrl).origin}/static/css/#linearGradient-1`, context: 'css', status: 'failed', reason: 'HTTP 404' });
    manifest.offlineAssets.discovered++;
    manifest.offlineAssets.failed++;
    for (const [handle, value] of [[indexHandle, index], [manifestHandle, manifest]]) {
      const writer = await handle.createWritable();
      await writer.write(JSON.stringify(value));
      await writer.close();
    }
  }, assetStorage.demoId);
  await page.reload();
  await panelCoverage.getByText(`已保存 ${captured.manifest.offlineAssets.saved} / 已发现 ${captured.manifest.offlineAssets.discovered} 项离线资源`).waitFor({ timeout: 10000 });
  assert.doesNotMatch(await panelCoverage.innerText(), /linearGradient-1|未保存资源（8）/, 'Historical rrweb paint fragments must not appear as missing assets');
  await page.evaluate(async demoId => {
    const root = await navigator.storage.getDirectory();
    const folder = await (await root.getDirectoryHandle('demos')).getDirectoryHandle(demoId);
    const handle = await folder.getFileHandle('manifest.json');
    const manifest = JSON.parse(await (await handle.getFile()).text());
    manifest.offlineAssets.discovered++;
    const writer = await handle.createWritable();
    await writer.write(JSON.stringify(manifest));
    await writer.close();
  }, assetStorage.demoId);
  await page.reload();
  await panelCoverage.getByText(`已保存 ${captured.manifest.offlineAssets.saved} / 已发现 ${captured.manifest.offlineAssets.discovered + 1} 项离线资源`).waitFor({ timeout: 10000 });
  await page.evaluate(async ({ demoId, index, summary }) => {
    const root = await navigator.storage.getDirectory();
    const folder = await (await root.getDirectoryHandle('demos')).getDirectoryHandle(demoId);
    const indexHandle = await (await folder.getDirectoryHandle('assets')).getFileHandle('index.json');
    const manifestHandle = await folder.getFileHandle('manifest.json');
    const manifest = JSON.parse(await (await manifestHandle.getFile()).text());
    manifest.offlineAssets = summary;
    for (const [handle, value] of [[indexHandle, index], [manifestHandle, manifest]]) {
      const writer = await handle.createWritable();
      await writer.write(JSON.stringify(value));
      await writer.close();
    }
  }, { demoId: assetStorage.demoId, index: captured.index, summary: captured.manifest.offlineAssets });
  await page.reload();
  await target.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  const originalRequests = [];
  const savedUrls = new Set(captured.index.entries.filter(entry => entry.status === 'saved').map(entry => entry.url.split('#')[0]));
  context.on('request', request => { if (savedUrls.has(request.url().split('#')[0])) originalRequests.push(request.url()); });
  await editor.reload();
  async function assertOfflineAssets(replayPage) {
    const frame = replayPage.frameLocator('.rrweb-mount iframe');
    await frame.getByAltText('栅格图片').waitFor();
    const result = await frame.getByAltText('栅格图片').evaluate(async image => {
      const document = image.ownerDocument;
      const images = ['栅格图片', '相同图片', 'SVG 图片'].map(alt => document.querySelector(`img[alt="${alt}"]`));
      const decoded = await Promise.all(images.map(image => image.decode().then(() => true, () => false)));
      const background = document.defaultView.getComputedStyle(document.querySelector('.asset-fixture')).backgroundImage;
      const backgroundUrl = background.match(/url\(["']?(.*?)["']?\)/)?.[1];
      const backgroundImage = new Image();
      backgroundImage.src = backgroundUrl ?? '';
      await backgroundImage.decode().catch(() => {});
      const faces = await document.fonts.load('16px FixtureIcons').catch(() => []);
      return { images: images.map((image, index) => ({ src: image.currentSrc, width: image.naturalWidth, decoded: decoded[index] })), srcset: image.srcset,
        background, backgroundWidth: backgroundImage.naturalWidth, fonts: faces.map(face => face.status) };
    });
    assert.ok(result.images.every(image => image.src.startsWith('blob:') && image.decoded), `Offline image/SVG decoding failed: ${JSON.stringify(result)}`);
    assert.ok(result.srcset.includes('blob:') && !result.srcset.includes('http:'), 'srcset must use local bytes');
    assert.ok(result.background.includes('blob:') && result.backgroundWidth > 0, 'CSS background must decode from local bytes');
    assert.deepEqual(result.fonts, ['loaded'], 'Icon font must load while the source server is stopped');
    assert.deepEqual(originalRequests, [], 'Successfully captured images/fonts must never request their original server');
  }
  await editor.getByRole('heading', { name: '点击操作' }).waitFor({ timeout: 10000 });
  const editorCoverage = editor.getByRole('region', { name: '离线资源覆盖' });
  await editorCoverage.getByText('离线资源不完整').waitFor();
  assert.doesNotMatch(await editorCoverage.innerText(), /secret=|token=|#private|#fragment/);
  await editor.locator('.rrweb-mount .replayer-mouse').waitFor({ state: 'attached' });
  await assertOfflineAssets(editor);
  const editorCursor = await editor.locator('.rrweb-mount .replayer-mouse').evaluate(node => ({
    display: getComputedStyle(node).display,
    background: getComputedStyle(node).backgroundImage
  }));
  if (editorCursor.display === 'none' || editorCursor.background === 'none') throw new Error('The editor must keep the recorded arrow and circle visible');
  await editor.getByRole('button', { name: /新建虚拟机/ }).first().click();
  await editor.getByRole('button', { name: '添加交互热点' }).click();
  await editor.getByText('交互热点已保存').waitFor();
  await recordedDemoItem.getByRole('button', { name: '导出' }).click();
  await page.getByText(/已导出演示“创建虚拟机”/).waitFor({ timeout: 15000 });
  const exportedBytes = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const exported = await (await root.getFileHandle('smoke-export.smtxdemo')).getFile();
    return [...new Uint8Array(await exported.arrayBuffer())];
  });
  const exportedPackage = unzipSync(new Uint8Array(exportedBytes));
  assert.equal(JSON.parse(strFromU8(exportedPackage['package-manifest.json'])).packageFormatVersion, 1);
  assert.equal(JSON.parse(strFromU8(exportedPackage['manifest.json'])).id, assetStorage.demoId);
  assert.equal(JSON.parse(strFromU8(exportedPackage['steps.json'])).length, 1);
  assert.ok(Object.keys(exportedPackage).some(name => name.startsWith('events/')));
  console.log(`Exported .smtxdemo package from Edge: ${exportedBytes.length} bytes, ${Object.keys(exportedPackage).length} entries.`);
  if (process.env.DEMO_CENTER_URL) {
    const api = process.env.DEMO_CENTER_URL.replace(/\/$/, '');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(exportedBytes)], { type: 'application/zip' }), 'smoke-export.smtxdemo');
    const inspectionResponse = await fetch(`${api}/api/demos/inspect`, { method: 'POST', body: form });
    if (inspectionResponse.status !== 200) throw new Error(`DemoCenter inspection failed: ${await inspectionResponse.text()}`);
    const inspection = await inspectionResponse.json();
    assert.equal(inspection.stepCount, 1);
    assert.ok(inspection.resourceIssueCount > 0);
    const publishResponse = await fetch(`${api}/api/demos`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadToken: inspection.uploadToken, title: 'Edge 导出联调' }) });
    if (publishResponse.status !== 201) throw new Error(`DemoCenter publish failed: ${await publishResponse.text()}`);
    const published = await publishResponse.json();
    try {
      const playbackResponse = await fetch(`${api}/api/demos/${published.id}/playback`);
      assert.equal(playbackResponse.status, 200);
      const playback = await playbackResponse.json();
      assert.equal(playback.steps.length, 1);
      assert.equal(playback.manifest.id, assetStorage.demoId);
      assert.ok(playback.events.some(event => event.type === 2));
      const centerPage = await context.newPage();
      try {
        await centerPage.goto(`${api}/demos/${published.id}/play`);
        const hotspot = centerPage.getByRole('button', { name: '点击热点：新建虚拟机' });
        await hotspot.waitFor({ timeout: 20000 });
        await hotspot.click();
        await centerPage.getByRole('heading', { name: '演示已完成' }).waitFor({ timeout: 20000 });
      } finally { await centerPage.close(); }
      console.log(`DemoCenter imported the Edge export: ${published.id}, ${playback.events.length} events.`);
    } finally {
      const deleted = await fetch(`${api}/api/demos/${published.id}`, { method: 'DELETE' });
      assert.equal(deleted.status, 200);
    }
  }
  const exportNotice = await page.locator('.notice').innerText();
  await page.evaluate(() => Object.defineProperty(window, 'showSaveFilePicker', { configurable: true,
    value: async () => { throw new DOMException('Cancelled', 'AbortError'); } }));
  await recordedDemoItem.getByRole('button', { name: '导出' }).click();
  assert.equal(await page.locator('.notice').innerText(), exportNotice, 'Cancelling Save As must not replace the last successful notice');
  await page.evaluate(() => Object.defineProperty(window, 'showSaveFilePicker', { configurable: true,
    value: async () => ({ createWritable: async () => ({ write: async () => { throw new Error('Disk full'); }, abort: async () => { window.exportAbortObserved = true; } }) }) }));
  await recordedDemoItem.getByRole('button', { name: '导出' }).click();
  await page.getByText(/导出演示失败：Disk full/).waitFor();
  assert.equal(await page.evaluate(() => window.exportAbortObserved), true, 'Failed export must abort the output file');
  const playerPagePromise = context.waitForEvent('page');
  await editor.getByRole('button', { name: '播放演示' }).click();
  const player = await playerPagePromise;
  const playbackSpeed = player.getByRole('combobox', { name: '播放加速' });
  await playbackSpeed.waitFor({ timeout: 10000 });
  const playerCoverage = player.getByRole('region', { name: '离线资源覆盖' });
  await playerCoverage.getByText('离线资源不完整').waitFor();
  const coverageHeight = (await playerCoverage.boundingBox()).height;
  assert.ok(coverageHeight <= 60, `Default player coverage must leave room for playback: ${coverageHeight}px exceeds 60px`);
  assert.equal(await playerCoverage.locator('.asset-scope').isVisible(), false, 'Scope details must be on demand');
  const stageHeight = (await player.locator('.player-stage-wrap').boundingBox()).height;
  assert.doesNotMatch(await playerCoverage.innerText(), /secret=|token=|#private|#fragment/);
  const failureDisclosure = playerCoverage.getByText('资源详情', { exact: true });
  await failureDisclosure.click();
  await playerCoverage.getByText(/html\.png/).waitFor();
  await playerCoverage.getByText(/仅表示已发现的受支持静态资源/).waitFor();
  await playerCoverage.getByText(/去重后/).waitFor();
  await playerCoverage.getByText(/当前可用/).waitFor();
  assert.equal((await player.locator('.player-stage-wrap').boundingBox()).height, stageHeight, 'Expanded details must overlay without shrinking the stage');
  assert.doesNotMatch(await playerCoverage.innerText(), /secret=|token=|#private|#fragment/);
  await failureDisclosure.click();
  console.log(`Player coverage: ${coverageHeight}px collapsed, stage ${stageHeight}px; expanded details preserve stage height.`);
  await player.evaluate(async demoId => {
    const root = await navigator.storage.getDirectory();
    const folder = await (await root.getDirectoryHandle('demos')).getDirectoryHandle(demoId);
    const handle = await folder.getFileHandle('manifest.json');
    const manifest = JSON.parse(await (await handle.getFile()).text());
    manifest.offlineAssets = { ...manifest.offlineAssets, saved: manifest.offlineAssets.discovered, failed: 0, status: 'complete' };
    const writer = await handle.createWritable();
    await writer.write(JSON.stringify(manifest));
    await writer.close();
  }, assetStorage.demoId);
  await page.reload();
  await editor.reload();
  await player.reload();
  for (const coverage of [page, editor, player].map(tab => tab.getByRole('region', { name: '离线资源覆盖' }))) {
    await coverage.getByText('离线资源不完整').waitFor();
    const disclosure = coverage.getByText('资源详情', { exact: true });
    if (await disclosure.count()) await disclosure.click();
    assert.ok((await coverage.innerText()).includes(`当前可用 ${captured.manifest.offlineAssets.saved} / 已发现 ${captured.manifest.offlineAssets.discovered}`));
  }
  await player.evaluate(async ({ demoId, summary }) => {
    const root = await navigator.storage.getDirectory();
    const folder = await (await root.getDirectoryHandle('demos')).getDirectoryHandle(demoId);
    const handle = await folder.getFileHandle('manifest.json');
    const manifest = JSON.parse(await (await handle.getFile()).text());
    manifest.offlineAssets = summary;
    const writer = await handle.createWritable();
    await writer.write(JSON.stringify(manifest));
    await writer.close();
  }, { demoId: assetStorage.demoId, summary: captured.manifest.offlineAssets });
  await page.reload();
  await editor.reload();
  await player.reload();
  if (await playbackSpeed.inputValue() !== 'off') throw new Error('Playback acceleration should be off by default');
  for (const duration of ['1000', '2000', '3000']) {
    await playbackSpeed.selectOption(duration);
    if (await playbackSpeed.inputValue() !== duration) throw new Error(`Could not select a ${duration} ms transition cap`);
  }
  await playbackSpeed.selectOption('off');
  if (await playbackSpeed.inputValue() !== 'off') throw new Error('Original-speed playback should be restorable immediately');
  await player.getByRole('button', { name: '点击热点：新建虚拟机' }).waitFor({ timeout: 10000 });
  const assetOpenStart = performance.now();
  await player.reload();
  await player.getByRole('button', { name: '点击热点：新建虚拟机' }).waitFor({ timeout: 10000 });
  const assetOpenMs = Math.round(performance.now() - assetOpenStart);
  await player.locator('.rrweb-mount .replayer-mouse').waitFor({ state: 'attached' });
  await assertOfflineAssets(player);
  const playerCursor = await player.locator('.rrweb-mount .replayer-mouse').evaluate(node => ({
    display: getComputedStyle(node).display,
    background: getComputedStyle(node).backgroundImage,
    circleContent: getComputedStyle(node, '::after').content,
    circleOpacity: getComputedStyle(node, '::after').opacity
  }));
  if (playerCursor.display === 'none' || playerCursor.background !== 'none' || playerCursor.circleContent === 'none' || Number(playerCursor.circleOpacity) <= 0) {
    throw new Error(`The player must show only the recorded circle: ${JSON.stringify(playerCursor)}`);
  }
  await mkdir(resolve('output/playwright'), { recursive: true });
  await player.screenshot({ path: resolve('output/playwright/player.png') });
  const assetSize = await demoBytes(player, assetStorage.demoId);
  await beginFrameProbe(player);
  await player.locator('.interaction-layer').click({ position: { x: 5, y: 5 } });
  await player.getByText('请点击高亮的“新建虚拟机”').waitFor();
  await player.getByRole('button', { name: '点击热点：新建虚拟机' }).click();
  await player.getByRole('button', { name: '点击热点：新建虚拟机' }).waitFor({ state: 'detached' });
  await player.frameLocator('.rrweb-mount iframe').getByText('demo-vm 创建成功').waitFor({ timeout: 10000 });
  const assetFrames = await endFrameProbe(player);
  const dynamicReplay = await player.frameLocator('.rrweb-mount iframe').locator('#dynamic-background').evaluate(async node => {
    const doc = node.ownerDocument;
    const backgrounds = await Promise.all(['dynamic-background', 'priority-background'].map(async id => {
      const style = doc.defaultView.getComputedStyle(doc.getElementById(id));
      const url = style.backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1];
      const image = new Image();
      image.src = url ?? '';
      const decoded = await image.decode().then(() => true, () => false);
      return { url, decoded };
    }));
    const image = doc.querySelector('img[alt="导航后图片"]');
    const decoded = await image.decode().then(() => true, () => false);
    return { backgrounds, image: { url: image.currentSrc, decoded }, priority: doc.getElementById('priority-background').style.getPropertyPriority('background-image') };
  });
  assert.ok(dynamicReplay.backgrounds.every(image => image.url.startsWith('blob:') && image.decoded), `Dynamic backgrounds after navigation must decode offline: ${JSON.stringify(dynamicReplay)}`);
  assert.ok(dynamicReplay.image.url.startsWith('blob:') && dynamicReplay.image.decoded, 'Navigated relative image must decode offline');
  assert.equal(dynamicReplay.priority, 'important');
  assert.deepEqual((await readAssets()).events, captured.events, 'Playback must not alter event JSON on disk');
  console.log('Relative style diff strings and priority tuples replayed after directory navigation with local image decoding and unchanged event JSON.');
  console.log('Recorded across reload, saved, selected hotspot, and played through the gate.');
  assert.deepEqual(originalRequests, [], 'Playback across reload snapshots must keep saved resources offline');
  await player.evaluate(async demoId => {
    const root = await navigator.storage.getDirectory();
    const assets = await (await (await root.getDirectoryHandle('demos')).getDirectoryHandle(demoId)).getDirectoryHandle('assets');
    const handle = await assets.getFileHandle('index.json');
    const index = JSON.parse(await (await handle.getFile()).text());
    index.entries.find(entry => entry.url.includes('/assets/icon.svg')).mime = 17;
    const writer = await handle.createWritable();
    await writer.write(JSON.stringify(index));
    await writer.close();
  }, assetStorage.demoId);
  await page.reload();
  await editor.reload();
  await player.reload();
  for (const coverage of [page, editor, player].map(tab => tab.getByRole('region', { name: '离线资源覆盖' }))) {
    await coverage.getByText('离线资源不完整').waitFor();
    const disclosure = coverage.getByText('资源详情', { exact: true });
    if (await disclosure.count()) await disclosure.click();
    assert.match(await coverage.innerText(), /当前可用 0/);
  }
  await editor.getByRole('heading', { name: '点击操作' }).waitFor({ timeout: 10000 });
  await player.getByRole('button', { name: '点击热点：新建虚拟机' }).waitFor({ timeout: 10000 });
  await player.evaluate(async ({ demoId, index }) => {
    const root = await navigator.storage.getDirectory();
    const assets = await (await (await root.getDirectoryHandle('demos')).getDirectoryHandle(demoId)).getDirectoryHandle('assets');
    const handle = await assets.getFileHandle('index.json');
    const writer = await handle.createWritable();
    await writer.write(JSON.stringify(index));
    await writer.close();
  }, { demoId: assetStorage.demoId, index: captured.index });
  await player.evaluate(async ({ demoId, filename }) => {
    const root = await navigator.storage.getDirectory();
    const assets = await (await (await root.getDirectoryHandle('demos')).getDirectoryHandle(demoId)).getDirectoryHandle('assets');
    await assets.removeEntry(filename);
  }, { demoId: assetStorage.demoId, filename: entryFor('/assets/pixel.png').filename });
  await player.reload();
  await playerCoverage.getByText('资源详情', { exact: true }).click();
  await playerCoverage.getByText(/本地文件缺失或无法读取/).first().waitFor({ timeout: 10000 });
  const missingCoverage = await playerCoverage.innerText();
  assert.match(missingCoverage, /当前可用/);
  assert.match(missingCoverage, /pixel\.png/);
  assert.doesNotMatch(missingCoverage, /secret=|token=|#private|#fragment/);
  await player.evaluate(async demoId => {
    const root = await navigator.storage.getDirectory();
    const assets = await (await (await root.getDirectoryHandle('demos')).getDirectoryHandle(demoId)).getDirectoryHandle('assets');
    const handle = await assets.getFileHandle('index.json');
    const index = JSON.parse(await (await handle.getFile()).text());
    index.entries.find(entry => entry.status === 'failed').reason = 'Could not read /assets/a.png?token=secret#frag';
    const writer = await handle.createWritable();
    await writer.write(JSON.stringify(index));
    await writer.close();
  }, assetStorage.demoId);
  await page.reload();
  await editor.reload();
  await player.reload();
  await playerCoverage.getByText('资源详情', { exact: true }).click();
  for (const coverage of [page, editor, player].map(tab => tab.getByRole('region', { name: '离线资源覆盖' }))) {
    assert.doesNotMatch(await coverage.innerText(), /token=secret|#frag/);
  }
  await playerCoverage.getByText('资源详情', { exact: true }).click();
  await player.evaluate(async demoId => {
    const root = await navigator.storage.getDirectory();
    const assets = await (await (await root.getDirectoryHandle('demos')).getDirectoryHandle(demoId)).getDirectoryHandle('assets');
    await assets.removeEntry('index.json');
  }, assetStorage.demoId);
  await page.reload();
  await editor.reload();
  await player.reload();
  await editor.getByRole('heading', { name: '点击操作' }).waitFor({ timeout: 10000 });
  await player.getByRole('combobox', { name: '播放加速' }).waitFor({ timeout: 10000 });
  for (const coverage of [page, editor, player].map(tab => tab.getByRole('region', { name: '离线资源覆盖' }))) {
    await coverage.getByText('离线资源不完整').waitFor();
    const disclosure = coverage.getByText('资源详情', { exact: true });
    if (await disclosure.count()) await disclosure.click();
    assert.match(await coverage.innerText(), /当前可用 0/);
    assert.doesNotMatch(await coverage.innerText(), /已发现资源均已保存|token=|#frag/);
  }
  await player.getByRole('button', { name: '点击热点：新建虚拟机' }).waitFor({ timeout: 10000 });
  await editor.evaluate(async demoId => {
    const root = await navigator.storage.getDirectory();
    const folder = await (await root.getDirectoryHandle('demos')).getDirectoryHandle(demoId);
    const handle = await folder.getFileHandle('manifest.json');
    const manifest = JSON.parse(await (await handle.getFile()).text());
    manifest.formatVersion = 1;
    delete manifest.offlineAssets;
    const writer = await handle.createWritable();
    await writer.write(JSON.stringify(manifest));
    await writer.close();
  }, assetStorage.demoId);
  await editor.reload();
  await editorCoverage.getByText('此旧演示未保存离线资源').waitFor({ timeout: 10000 });
  await editor.getByRole('heading', { name: '点击操作' }).waitFor();
  const baselineSize = await demoBytes(player, assetStorage.demoId);
  const baselineOpenStart = performance.now();
  await player.reload();
  await playerCoverage.getByText('此旧演示未保存离线资源').waitFor({ timeout: 10000 });
  await player.getByRole('combobox', { name: '播放加速' }).waitFor();
  await player.getByRole('button', { name: '点击热点：新建虚拟机' }).waitFor({ timeout: 10000 });
  const baselineOpenMs = Math.round(performance.now() - baselineOpenStart);
  await beginFrameProbe(player);
  await player.getByRole('button', { name: '点击热点：新建虚拟机' }).click();
  await player.frameLocator('.rrweb-mount iframe').getByText('demo-vm 创建成功').waitFor({ timeout: 10000 });
  const baselineFrames = await endFrameProbe(player);
  console.log(`Same-fixture performance: captured demo ${assetSize.total} B (${assetSize.assets} B assets), no-resource baseline ${baselineSize.withoutAssets} B; opening ${assetOpenMs} vs ${baselineOpenMs} ms; max frame gap ${assetFrames.maxGapMs.toFixed(1)} vs ${baselineFrames.maxGapMs.toFixed(1)} ms (${assetFrames.frames}/${baselineFrames.frames} frames).`);
  const deleteButton = recordedDemoItem.getByRole('button', { name: '删除' });
  const cancelDialog = page.waitForEvent('dialog');
  const cancelClick = deleteButton.click();
  const cancel = await cancelDialog;
  assert.match(cancel.message(), /创建虚拟机.*永久删除|永久删除.*创建虚拟机/);
  await cancel.dismiss();
  await cancelClick;
  assert.equal(await recordedDemoItem.count(), 1, 'Cancelling deletion must keep the demo in the list');
  assert.equal(await page.evaluate(async demoId => {
    const root = await navigator.storage.getDirectory();
    return (await (await root.getDirectoryHandle('demos')).getDirectoryHandle(demoId)).kind;
  }, assetStorage.demoId), 'directory', 'Cancelling deletion must preserve files');
  const acceptDialog = page.waitForEvent('dialog');
  const acceptClick = deleteButton.click();
  const accept = await acceptDialog;
  await accept.accept();
  await acceptClick;
  await recordedDemoItem.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(async demoId => {
    const root = await navigator.storage.getDirectory();
    try { await (await root.getDirectoryHandle('demos')).getDirectoryHandle(demoId); return false; }
    catch (error) { return error.name === 'NotFoundError'; }
  }, assetStorage.demoId), true, 'Confirmed deletion must remove the entire demo directory');
  console.log('Delete flow confirmed: active recording disabled; cancel preserved the demo; confirmation removed its local directory.');
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await context.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (!profile.startsWith(join(tmpdir(), 'hci-demo-smoke-'))) throw new Error('Refusing to remove an unexpected test profile path');
  await rm(profile, { recursive: true, force: true });
}
