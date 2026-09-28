import { collectAssetReferences } from './asset-refs.ts';
import type { AssetReference } from './asset-refs.ts';
import { MAX_ASSET_BYTES, validateAssetResponse } from './asset-store.ts';
import { ASSET_PORT, ASSET_CHUNK_BYTES, CAPTURE_CONCURRENCY } from './asset-protocol.ts';
import type { AssetAck, AssetMessage } from './asset-protocol.ts';
import type { RecordedEvent } from './model.ts';

export function startAssetCapture(sessionId: string, pageUrl: string): { observeEvent(event: RecordedEvent): void; stop(): Promise<void> } {
  const origin = new URL(pageUrl).origin;
  const port = chrome.runtime.connect({ name: ASSET_PORT });
  const nodeTags = new Map<number, string>();
  const seen = new Set<string>();
  const queue: { assetId: string; reference: AssetReference; discovered: Promise<void> }[] = [];
  const pending = new Map<string, { stage: AssetMessage['type']; resolve(): void; reject(error: Error): void }>();
  const controllers = new Set<AbortController>();
  let active = 0;
  let stopped = false;
  let disconnected = false;
  let stopPromise: Promise<void> | undefined;
  let sequence = 0;

  function request(message: AssetMessage): Promise<void> {
    if (disconnected) return Promise.reject(new Error('Asset capture disconnected'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(message.assetId); reject(new Error('Asset transfer acknowledgement timed out')); }, 10000);
      pending.set(message.assetId, { stage: message.type, resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } });
      try { port.postMessage(message); } catch { pending.get(message.assetId)?.reject(new Error('Asset capture disconnected')); pending.delete(message.assetId); }
    });
  }
  port.onMessage.addListener((ack: AssetAck) => {
    if (ack.type !== 'ASSET_ACK' || ack.sessionId !== sessionId) return;
    const waiting = pending.get(ack.assetId);
    if (!waiting || waiting.stage !== ack.stage) return;
    pending.delete(ack.assetId);
    if (ack.ok) waiting.resolve(); else waiting.reject(new Error(ack.reason ?? 'Asset capture failed'));
  });
  function onDisconnect() {
    disconnected = true;
    observer?.disconnect();
    for (const controller of controllers) controller.abort();
    for (const waiting of pending.values()) waiting.reject(new Error('Asset capture disconnected'));
    pending.clear();
    queue.length = 0;
  }
  port.onDisconnect.addListener(onDisconnect);

  async function capture(item: typeof queue[number]) {
    const { assetId, reference } = item;
    const envelope = { sessionId, assetId };
    const controller = new AbortController();
    controllers.add(controller);
    const deadline = Date.now() + 10000;
    const timeoutError = new Error('Asset capture timed out after 10 seconds');
    const timer = setTimeout(() => {
      controller.abort();
      const waiting = pending.get(assetId);
      pending.delete(assetId);
      waiting?.reject(timeoutError);
    }, 10000);
    function checkDeadline() {
      if (Date.now() >= deadline) throw timeoutError;
    }
    async function transfer(message: AssetMessage) {
      // Also check elapsed time after synchronous validation/encoding and after
      // acknowledgements: those can finish before the timer callback is serviced.
      checkDeadline();
      await request(message);
      checkDeadline();
    }
    try {
      await item.discovered;
      checkDeadline();
      if (new URL(reference.url).origin !== origin) throw new Error('Cross-origin resource is not captured');
      if (reference.context === 'stylesheet') throw new Error('External stylesheet was not safely inlined');
      // Reject redirects rather than following one into a different origin.
      const response = await fetch(reference.url, { credentials: 'include', mode: 'same-origin', redirect: 'error', signal: controller.signal });
      checkDeadline();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (Number(response.headers.get('content-length')) > MAX_ASSET_BYTES) throw new Error('Resource exceeds 10 MB');
      if (!response.body) throw new Error('Empty asset response');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const chunk = await reader.read();
        checkDeadline();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_ASSET_BYTES) { await reader.cancel(); throw new Error('Resource exceeds 10 MB'); }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const validated = validateAssetResponse(reference.url, response.headers.get('content-type') ?? '', bytes);
      if ('reason' in validated) throw new Error(validated.reason);
      await transfer({ ...envelope, type: 'ASSET_BEGIN', mime: validated.mime, bytes: length, deadline });
      for (let offset = 0, sequence = 0; offset < length; offset += ASSET_CHUNK_BYTES, sequence++) {
        const base64 = btoa(String.fromCharCode(...bytes.subarray(offset, offset + ASSET_CHUNK_BYTES)));
        await transfer({ ...envelope, type: 'ASSET_CHUNK', sequence, base64 });
      }
      await transfer({ ...envelope, type: 'ASSET_END' });
    } catch (error) {
      controller.abort();
      const reason = Date.now() >= deadline ? timeoutError.message : error instanceof Error ? error.message : 'Asset capture failed';
      // A terminal failure must not extend the resource's lifetime by waiting for
      // another ACK. The panel queues this write; finishDemo settles its index.
      if (!disconnected) {
        try { port.postMessage({ ...envelope, type: 'ASSET_FAILED', reason } satisfies AssetMessage); }
        catch { /* A disconnected receiver retains the discovered pending entry. */ }
      }
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }
  function pump() {
    while (!disconnected && active < CAPTURE_CONCURRENCY && queue.length) {
      const item = queue.shift()!;
      active++;
      void capture(item).finally(() => { active--; pump(); });
    }
  }
  function discover(reference: AssetReference) {
    if (stopped || disconnected || seen.has(reference.url)) return;
    seen.add(reference.url);
    const assetId = String(++sequence);
    const discovered = request({ type: 'ASSET_DISCOVERED', sessionId, assetId, reference });
    // Queued discoveries can reject on navigation before a worker takes them.
    void discovered.catch(() => {});
    queue.push({ assetId, reference, discovered });
    pump();
  }
  function observeResources(entries: PerformanceEntry[]) {
    for (const entry of entries) {
      const resource = entry as PerformanceResourceTiming;
      if (!['img', 'image', 'css', 'font', 'link'].includes(resource.initiatorType)) continue;
      let url: URL;
      try { url = new URL(resource.name, pageUrl); } catch { continue; }
      if (!['http:', 'https:', 'blob:'].includes(url.protocol)) continue;
      const stylesheet = /\.css$/i.test(url.pathname);
      if (resource.initiatorType === 'link') {
        // Only actual stylesheets/fonts/images, never preload scripts or fetches.
        const link = [...document.querySelectorAll<HTMLLinkElement>('link[href]')].find(link => link.href === url.href);
        if (!link) continue;
        if (link.relList.contains('stylesheet')) {
          try { if (link.sheet?.cssRules) continue; } catch { /* Cross-origin CSS cannot be inlined. */ }
        } else if (!['image', 'font'].includes(link.as)) continue;
      }
      discover({ url: url.href, context: stylesheet ? 'stylesheet' : resource.initiatorType === 'img' || resource.initiatorType === 'image' ? 'img' : 'css', firstSeenAt: Date.now() });
    }
  }
  const observer = typeof PerformanceObserver === 'undefined' ? null : new PerformanceObserver(list => observeResources(list.getEntries()));
  observer?.observe({ type: 'resource', buffered: true });

  return {
    observeEvent(event) {
      if (stopped || disconnected) return;
      for (const reference of collectAssetReferences(event, pageUrl, nodeTags)) discover(reference);
    },
    stop() {
      stopPromise ??= (async () => {
        observeResources(observer?.takeRecords() ?? []);
        stopped = true;
        observer?.disconnect();
        const deadline = Date.now() + 30000;
        while (!disconnected && (active || queue.length || pending.size) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        // The receiver retains discovered pending entries even if the deadline wins.
        onDisconnect();
        port.disconnect();
      })();
      return stopPromise;
    }
  };
}
