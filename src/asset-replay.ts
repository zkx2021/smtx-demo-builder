import { collectAssetReferences, recordedEventsWithBaseUrl, rewriteRecordedEvents } from './asset-refs.ts';
import { loadAssetFile } from './storage.ts';
import type { LoadedDemo, RecordedEvent } from './model.ts';

export interface ReplayAssets {
  events: RecordedEvent[];
  preloadThrough(at: number): Promise<void>;
  release(): void;
  issues: Array<{ url: string; reason: string }>;
}

export async function prepareReplayAssets(root: FileSystemDirectoryHandle, demo: LoadedDemo): Promise<ReplayAssets> {
  if (demo.manifest.formatVersion === 1) {
    return { events: demo.events, issues: [], preloadThrough: async () => {}, release() {} };
  }
  if (!demo.assets) {
    return { events: demo.events,
      issues: [{ url: demo.manifest.sourceUrl, reason: 'Saved asset index is missing or unreadable' }],
      preloadThrough: async () => {}, release() {} };
  }
  const issues: ReplayAssets['issues'] = [];
  const files = new Map<string, { url: string; mime: string } | null>();
  const replacements = new Map<string, string>();
  const images = new Map<string, { original: string; at: number }>();
  for (const entry of demo.assets?.entries ?? []) {
    if (entry.status !== 'saved') continue;
    const filename = entry.filename ?? '';
    if (!files.has(filename)) {
      try {
        const file = await loadAssetFile(root, demo.manifest.id, filename);
        if (!entry.mime) throw new Error('Missing MIME');
        files.set(filename, { url: URL.createObjectURL(new Blob([file], { type: entry.mime })), mime: entry.mime });
      } catch { files.set(filename, null); }
    }
    const local = files.get(filename);
    if (!local) { issues.push({ url: entry.url, reason: 'Saved asset file is missing or unreadable' }); continue; }
    const fragment = local.mime === 'image/svg+xml' ? new URL(entry.url, demo.manifest.sourceUrl).hash : '';
    replacements.set(entry.url, `${local.url}${fragment}`);
    if (local.mime.startsWith('image/')) images.set(`${local.url}${fragment}`, { original: entry.url, at: Infinity });
  }

  const tags = new Map<number, string>();
  const start = demo.events[0]?.timestamp ?? 0;
  const initialSnapshot = demo.events.find(event => event.type === 2);
  for (const { event, pageUrl } of recordedEventsWithBaseUrl(demo.events, demo.manifest.sourceUrl)) {
    for (const reference of collectAssetReferences(event, pageUrl, tags)) {
      const local = replacements.get(reference.url);
      const image = local ? images.get(local) : undefined;
      if (image) image.at = Math.min(image.at, event === initialSnapshot ? 0 : Math.max(0, event.timestamp - start));
    }
  }

  let released = false;
  let active = 0;
  const pending: Array<() => void> = [];
  const cancellations = new Set<() => void>();
  const preloads = new Map<string, Promise<void>>();
  const pump = () => {
    while (!released && active < 4 && pending.length) pending.shift()!();
  };
  function preload(url: string, original: string): Promise<void> {
    const existing = preloads.get(url);
    if (existing) return existing;
    const promise = new Promise<void>(resolve => {
      let image: HTMLImageElement | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let started = false;
      let done = false;
      const finish = (reason?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (released || reason) image?.removeAttribute('src');
        if (reason && !released) issues.push({ url: original, reason });
        cancellations.delete(cancel);
        if (started) active--;
        resolve();
        pump();
      };
      const cancel = () => finish();
      cancellations.add(cancel);
      pending.push(() => {
        started = true;
        active++;
        image = new Image();
        image.src = url;
        timer = setTimeout(() => finish('Saved image preload timed out'), 5000);
        void image.decode().then(() => finish(), () => finish('Saved image could not be decoded'));
      });
    });
    preloads.set(url, promise);
    pump();
    return promise;
  }
  return {
    events: rewriteRecordedEvents(demo.events, replacements, demo.manifest.sourceUrl),
    issues,
    async preloadThrough(at) {
      if (released || typeof Image === 'undefined') return;
      await Promise.all([...images].filter(([, image]) => image.at <= at).map(([url, image]) => preload(url, image.original)));
    },
    release() {
      if (released) return;
      released = true;
      pending.length = 0;
      for (const cancel of cancellations) cancel();
      for (const file of files.values()) if (file) URL.revokeObjectURL(file.url);
    }
  };
}
