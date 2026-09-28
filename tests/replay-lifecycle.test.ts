import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

// The real React components and rrweb renderer run in Edge. Only asynchronous
// asset/storage boundaries are controlled, to reproduce lifecycle orderings.
async function browserFixture(editor: boolean) {
  const source = editor ? "import './src/main.tsx';" : `
    import { createRoot } from 'react-dom/client';
    import { ReplayCanvas } from './src/replay.tsx';
    const root = createRoot(document.getElementById('root'));
    const replayerRef = { current: null };
    const directory = {};
    window.renderReplay = (name, at) => root.render(<ReplayCanvas
      root={directory} demo={window.demos[name]} replayerRef={replayerRef}
      preloadThroughAt={at} onReady={() => window.ready.push(name)}
      onAssetIssues={issues => {
        window.issueEvents.push({ owner: name, issues });
        document.getElementById('issues').textContent = issues.map(issue => issue.url).join(',');
      }} />);
  `;
  const bundle = await build({
    stdin: { contents: source, loader: 'tsx', resolveDir: process.cwd() },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
    plugins: [{ name: 'controlled-replay-boundaries', setup(builder) {
      builder.onResolve({ filter: /^\.\/asset-replay\.ts$/ }, () => ({ path: 'assets', namespace: 'controlled' }));
      if (editor) builder.onResolve({ filter: /^\.\/storage\.ts$/ }, () => ({ path: 'storage', namespace: 'controlled' }));
      builder.onLoad({ filter: /.*/, namespace: 'controlled' }, args => ({
        loader: 'js', resolveDir: process.cwd(), contents: args.path === 'assets'
          ? 'export const prepareReplayAssets = (...args) => window.prepareAssets(...args);'
          : `export * from ${JSON.stringify(`${process.cwd().replaceAll('\\', '/')}/src/storage.ts`)};
             export const loadRootHandle = async () => ({});
             export const hasWritePermission = async () => true;
             export const loadDemo = async () => window.demos.a;`
      }));
    } }]
  });
  const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const page = await browser.newPage();
  await page.route('http://replay.test/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><output id="issues"></output>' }));
  await page.goto(`http://replay.test/?view=editor&id=demo-a`);
  await page.evaluate(() => {
    const state = window as any;
    const snapshot = { type: 2, timestamp: 1010, data: { initialOffset: { top: 0, left: 0 }, node: {
      type: 0, id: 1, childNodes: [{ type: 2, id: 2, tagName: 'html', attributes: {}, childNodes: [
        { type: 2, id: 3, tagName: 'head', attributes: {}, childNodes: [] },
        { type: 2, id: 4, tagName: 'body', attributes: {}, childNodes: [
          { type: 2, id: 5, tagName: 'h1', attributes: {}, childNodes: [{ type: 3, id: 6, textContent: 'Initial screen' }] }
        ] }
      ] }]
    } } };
    const events = [
      { type: 4, timestamp: 1000, data: { href: 'http://fixture.test', width: 1280, height: 720 } }, snapshot,
      { type: 3, timestamp: 2000, data: { source: 0, adds: [], removes: [], attributes: [], texts: [{ id: 6, value: 'Selected screen' }] } },
      { type: 3, timestamp: 2300, data: { source: 0, adds: [], removes: [], attributes: [], texts: [] } }
    ];
    const demo = { manifest: { formatVersion: 2, id: 'demo-a', title: 'Lifecycle', sourceUrl: 'http://fixture.test', viewport: { width: 1280, height: 720 }, clicks: [
      { id: 'click-1', time: 2200, label: 'Inspect selected screen', rect: { x: 0, y: 0, width: 1, height: 1 } }
    ] }, events, assets: { version: 1, entries: [] }, steps: [] };
    state.demos = { a: demo, b: structuredClone(demo) };
    state.demos.b.manifest.id = 'demo-b';
    state.ready = [];
    state.issueEvents = [];
  });
  return { browser, page, script: bundle.outputFiles[0].text };
}

test('editor applies a click selected while initial asset decoding delays replay readiness', async context => {
  const { browser, page, script } = await browserFixture(true);
  context.after(() => browser.close());
  await page.evaluate(() => {
    const state = window as any;
    const initial = new Promise<void>(resolve => { state.finishInitial = resolve; });
    state.prepareAssets = async (_root: unknown, demo: any) => ({ events: demo.events, issues: [], release() {}, preloadThrough: () => initial });
  });
  await page.addScriptTag({ content: script });
  await page.getByRole('button', { name: /Inspect selected screen/ }).click();
  assert.equal(await page.locator('.rrweb-mount iframe').count(), 0, 'Selection must precede Replayer construction');
  await page.evaluate(() => (window as any).finishInitial());
  await page.locator('.rrweb-mount iframe').waitFor();
  const text = await page.frameLocator('.rrweb-mount iframe').locator('h1').innerText();
  assert.equal(text, 'Selected screen', 'Replay readiness must honor the selection already shown in the editor');
});

test('replacing a demo at the same preload target cannot publish prior-demo asset issues', async context => {
  const { browser, page, script } = await browserFixture(false);
  context.after(() => browser.close());
  await page.evaluate(() => {
    const state = window as any;
    const outstanding = new Promise<void>(resolve => { state.finishOld = resolve; });
    state.prepareAssets = async (_root: unknown, demo: any) => {
      const old = demo.manifest.id === 'demo-a';
      if (!old) state.replacementPrepared = true;
      return { events: demo.events, issues: old ? [{ url: 'https://old.example/missing.png', reason: 'Missing' }] : [],
        preloadThrough: (at: number) => {
          if (!old) return new Promise(() => {});
          if (at === 500) { state.oldPreloadStarted = true; return outstanding; }
          return Promise.resolve();
        },
        release() { if (old) { state.oldReleased = true; state.finishOld(); } }
      };
    };
  });
  await page.addScriptTag({ content: script });
  await page.evaluate(() => (window as any).renderReplay('a', 0));
  await page.waitForFunction(() => (window as any).ready.includes('a'));
  await page.evaluate(() => (window as any).renderReplay('a', 500));
  await page.waitForFunction(() => (window as any).oldPreloadStarted);
  await page.evaluate(() => (window as any).renderReplay('b', 500));
  await page.waitForFunction(() => (window as any).oldReleased && (window as any).replacementPrepared);
  const stale = await page.evaluate(() => (window as any).issueEvents.filter((event: any) => event.owner === 'b' && event.issues.some((issue: any) => issue.url.includes('old.example'))));
  assert.deepEqual(stale, [], 'A released preparation must not send old issues to the replacement demo callback');
});
