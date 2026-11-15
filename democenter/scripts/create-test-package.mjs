// Generates a disposable, self-contained rrweb demo for local integration QA.
// It is never loaded into DemoCenter unless explicitly uploaded.
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { strToU8, zipSync } from 'fflate';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const output = resolve(process.argv[2] ?? 'tmp/fixture.smtxdemo');
const root = resolve(import.meta.dirname, '../..');
const bundle = await build({
  stdin: {
    contents: `import { record } from '@rrweb/record';
      window.demoEvents = [];
      window.startDemoRecording = () => { window.stopDemoRecording = record({ emit: event => window.demoEvents.push(event), mousemoveWait: 100 }); };`,
    resolveDir: root,
    sourcefile: 'test-recording-entry.js'
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  write: false
});
const browser = await chromium.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true
});
let events;
let rect;
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await page.route('https://fixture.example.test/demo', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html lang="zh-CN"><head><title>创建虚拟机</title>
      <style>body{font:16px Arial;margin:0;background:#f5f7fb;color:#182235}header{padding:22px 32px;background:#17213b;color:white}main{padding:42px}button{border:0;background:#2166f3;color:white;border-radius:8px;padding:16px 30px;font-size:17px;cursor:pointer}.card{background:white;padding:30px;border:1px solid #dbe1e8;border-radius:12px;max-width:700px}</style>
      </head><body><header>CloudTower · 演示环境</header><main><h1>虚拟机</h1><div class="card"><p>在集群中创建一台新的虚拟机。</p><button id="create">新建虚拟机</button><p id="result"></p></div></main>
      <script>document.getElementById('create').onclick=()=>{document.getElementById('result').textContent='已打开创建向导';}</script></body></html>`
  }));
  await page.goto('https://fixture.example.test/demo');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => window.startDemoRecording());
  rect = await page.locator('#create').boundingBox();
  await page.waitForTimeout(350);
  await page.locator('#create').click();
  await page.waitForTimeout(450);
  events = await page.evaluate(() => { window.stopDemoRecording(); return window.demoEvents; });
} finally {
  await browser.close();
}
if (!Array.isArray(events) || events.length < 2 || !rect) throw new Error('rrweb fixture recording failed');
const now = new Date().toISOString();
const id = 'demo-00000000-0000-4000-8000-000000000001';
const click = events.find(event => event.type === 3 && event.data?.source === 2 && event.data?.type === 2);
const clickTime = click?.timestamp ?? events[Math.floor(events.length / 2)].timestamp;
const viewport = { width: 1200, height: 700 };
const clicks = [{ id: 'click-fixture', time: clickTime, label: '新建虚拟机', rect, viewport }];
const manifest = {
  formatVersion: 2, id, title: '创建虚拟机（测试）', sourceUrl: 'https://fixture.example.test/demo',
  createdAt: now, updatedAt: now, status: 'ready', firstEventAt: events[0].timestamp,
  viewport, chunks: 1, clicks,
  offlineAssets: { discovered: 0, saved: 0, failed: 0, uniqueBytes: 0, status: 'no-candidates' }
};
const steps = [{ id: 'step-fixture', sourceClickId: clicks[0].id, at: Math.max(0, clickTime - events[0].timestamp - 80), title: '新建虚拟机', rect: {
  x: rect.x / viewport.width, y: rect.y / viewport.height,
  width: rect.width / viewport.width, height: rect.height / viewport.height
} }];
const batch = { type: 'EVENT_BATCH', sessionId: id, batchId: 'batch-fixture', events, clicks, viewport };
const json = value => strToU8(JSON.stringify(value));
const archive = zipSync({
  'package-manifest.json': json({ packageFormatVersion: 1, demoId: id, exportedAt: now }),
  'manifest.json': json(manifest),
  'steps.json': json(steps),
  'events/batch-fixture.json': json(batch),
  'assets/index.json': json({ version: 1, entries: [] })
});
await mkdir(dirname(output), { recursive: true });
await writeFile(output, archive);
console.log(`${output} (${archive.length} bytes, ${events.length} events)`);
