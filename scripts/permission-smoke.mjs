import { chromium } from 'playwright-core';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const profile = await mkdtemp(join(tmpdir(), 'hci-demo-permission-smoke-'));
const extensionPath = join(profile, 'extension');
await cp(resolve('dist'), extensionPath, { recursive: true });
const manifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'));
if (manifest.host_permissions?.length) throw new Error('Permission regression test must not pre-grant site access');

const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end('<!doctype html><title>Recording target</title>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}/`;
const context = await chromium.launchPersistentContext(profile, {
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
});

try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  const targetPagePromise = context.waitForEvent('page');
  const result = await panel.evaluate(async url => {
    const before = await chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] });
    const opened = await chrome.tabs.create({ url });
    if (!opened.id) throw new Error('Target tab was not created');
    return { before, tabId: opened.id };
  }, address);
  const target = await targetPagePromise;
  await target.waitForLoadState('domcontentloaded');
  const { actualUrl, activeUrl } = await panel.evaluate(async tabId => ({
    actualUrl: (await chrome.tabs.get(tabId)).url,
    activeUrl: (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.url
  }), result.tabId);
  if (result.before) throw new Error('Site access was already granted before recording');
  if (actualUrl !== address) throw new Error(`Target URL unavailable without site access: ${String(actualUrl)}`);
  if (activeUrl !== address) throw new Error(`Active target URL unavailable without site access: ${String(activeUrl)}`);
  console.log('Edge exposes opened and active target URLs before site access is granted.');
} finally {
  await context.close();
  await new Promise(resolve => server.close(resolve));
  if (!profile.startsWith(join(tmpdir(), 'hci-demo-permission-smoke-'))) throw new Error('Refusing to remove an unexpected test profile path');
  await rm(profile, { recursive: true, force: true });
}
