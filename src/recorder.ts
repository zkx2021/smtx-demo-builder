import { record } from '@rrweb/record';
import type { ClickCandidate } from './core.ts';
import type { EventBatch, RecordedEvent } from './model.ts';
import { startAssetCapture } from './asset-capture.ts';

type RecorderWindow = Window & { __hciDemoRecorder?: boolean };
const page = window as RecorderWindow;

function recordingId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // getRandomValues is also available on insecure HTTP origins.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

if (!page.__hciDemoRecorder) {
  page.__hciDemoRecorder = true;
  void start();
}

async function start(): Promise<void> {
  let hello: { active: boolean; sessionId?: string };
  try { hello = await chrome.runtime.sendMessage({ type: 'RECORDER_HELLO' }); }
  catch { page.__hciDemoRecorder = false; return; }
  if (!hello.active || !hello.sessionId) { page.__hciDemoRecorder = false; return; }

  const sessionId = hello.sessionId;
  const assetCapture = startAssetCapture(sessionId, location.href);
  const events: RecordedEvent[] = [];
  const clicks: ClickCandidate[] = [];
  let flushing = false;
  let stopped = false;
  let timer: number | undefined;
  let stopRrweb: (() => void) | undefined;

  function onClick(event: MouseEvent): void {
    const element = event.target instanceof Element
      ? (event.target.closest('button, a, [role="button"], input, select') ?? event.target)
      : null;
    if (!element) return;
    const box = element.getBoundingClientRect();
    const label = element.getAttribute('aria-label') || element.getAttribute('title') ||
      (element instanceof HTMLInputElement ? element.name || element.type : element.textContent?.trim().slice(0, 60)) ||
      element.tagName.toLowerCase();
    clicks.push({
      id: recordingId(), time: Date.now(), label,
      rect: { x: box.left, y: box.top, width: box.width, height: box.height },
      viewport: { width: window.innerWidth, height: window.innerHeight }
    });
  }

  async function flush(): Promise<void> {
    if (flushing || (events.length === 0 && clicks.length === 0)) return;
    flushing = true;
    const eventCount = events.length;
    const clickCount = clicks.length;
    const batch: EventBatch = {
      type: 'EVENT_BATCH', sessionId, batchId: recordingId(),
      events: events.slice(0, eventCount), clicks: clicks.slice(0, clickCount),
      viewport: { width: window.innerWidth, height: window.innerHeight }
    };
    try {
      const response = await chrome.runtime.sendMessage(batch);
      if (!response?.ok) throw new Error(response?.error || '录制面板未响应，请保持面板打开并重试');
      events.splice(0, eventCount);
      clicks.splice(0, clickCount);
    } catch (error) {
      stopped = true;
      stopRrweb?.();
      document.removeEventListener('click', onClick, true);
      if (timer) clearInterval(timer);
      page.__hciDemoRecorder = false;
      void assetCapture.stop();
      await chrome.storage.local.set({ recordingError: `录制暂停：${String(error)}` });
    } finally { flushing = false; }
  }

  document.addEventListener('click', onClick, true);
  stopRrweb = record({
    emit(event) {
      if (!stopped) {
        events.push(event as RecordedEvent);
        assetCapture.observeEvent(event as RecordedEvent);
      }
      if (events.length >= 80) void flush();
    },
    maskAllInputs: true,
    recordCanvas: false
  }) ?? undefined;
  timer = window.setInterval(() => { if (!stopped) void flush(); }, 1000);

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'STOP_RECORDER') return;
    stopped = true;
    stopRrweb?.();
    document.removeEventListener('click', onClick, true);
    if (timer) clearInterval(timer);
    page.__hciDemoRecorder = false;
    void (async () => {
      while (flushing) await new Promise(resolve => setTimeout(resolve, 25));
      await flush();
      await assetCapture.stop();
      sendResponse({ ok: events.length === 0 && clicks.length === 0 });
    })();
    return true;
  });

  window.addEventListener('pagehide', () => { if (!stopped) void flush(); }, { once: true });
}
