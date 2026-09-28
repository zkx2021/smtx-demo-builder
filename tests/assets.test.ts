import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { collectAssetReferences, redactAssetUrl, rewriteRecordedEvents } from '../src/asset-refs.ts';
import * as assetRefs from '../src/asset-refs.ts';
import { summarizeAssetIndex, validateAssetResponse } from '../src/asset-store.ts';
import { createDemo, finishDemo, loadAssetFile, loadDemo, recordAssetCandidate, recordAssetFailure, saveCapturedAsset, writeBatch } from '../src/storage.ts';
import * as storage from '../src/storage.ts';
import type { AssetIndex, RecordedEvent } from '../src/model.ts';
import { receiveAssetPort } from '../src/asset-protocol.ts';
import { prepareReplayAssets } from '../src/asset-replay.ts';
import type { AssetAck } from '../src/asset-protocol.ts';

const pageUrl = 'https://demo.example/app/view';

test('rrweb stylesheet directory fragments are not fetched as assets', () => {
  const event: RecordedEvent = { type: 2, timestamp: 10, data: { node: {
    type: 2, tagName: 'style', attributes: { _cssText: '.paint { fill: url("https://demo.example/static/css/#linearGradient-1") } .icon { fill: url("https://demo.example/static/css/icons.svg#check") }' }, childNodes: []
  } } };
  const before = structuredClone(event);
  assert.deepEqual(collectAssetReferences(event, pageUrl), [
    { url: 'https://demo.example/static/css/icons.svg#check', context: 'css', firstSeenAt: 10 }
  ]);
  assert.deepEqual(event, before);
});

test('replay restores rrweb stylesheet directory fragments to local SVG paint references', () => {
  const events: RecordedEvent[] = [{ type: 2, timestamp: 10, data: { node: {
    type: 2, tagName: 'style', attributes: { _cssText: '.paint { fill: url("https://demo.example/static/css/#linearGradient-1") } .icon { fill: url("https://demo.example/static/css/icons.svg#check") }' }, childNodes: []
  } } }];
  const before = structuredClone(events);
  const rewritten = rewriteRecordedEvents(events, new Map([
    ['https://demo.example/static/css/icons.svg#check', 'blob:local-icons']
  ]), pageUrl);
  assert.equal((rewritten[0].data as any).node.attributes._cssText,
    '.paint { fill: url("#linearGradient-1") } .icon { fill: url("blob:local-icons") }');
  assert.deepEqual(events, before);
});

test('legacy failed CSS paint fragments can be distinguished from genuine missing resources', () => {
  const classify = (assetRefs as Record<string, any>).isInlineCssFragmentReference;
  assert.equal(typeof classify, 'function');
  assert.equal(classify('https://demo.example/static/css/#egressGradient', 'css'), true);
  assert.equal(classify('https://demo.example/static/css/icons.svg#check', 'css'), false);
  assert.equal(classify('https://demo.example/static/css/#egressGradient', 'svg'), false);
  assert.equal(classify('https://demo.example/static/css/?download=1#egressGradient', 'css'), false);
});

for (const [shape, data, expected] of [
  ['style diff string', { source: 0, attributes: [{ id: 2, attributes: { style: { 'background-image': 'url("./dynamic.png?token=x#icon")', color: false, content: '"url(./prose.png)"' }, title: 'url(./prose.png)' } }] },
    { source: 0, attributes: [{ id: 2, attributes: { style: { 'background-image': 'url("blob:dynamic")', color: false, content: '"url(./prose.png)"' }, title: 'url(./prose.png)' } }] }],
  ['style diff priority tuple', { source: 0, attributes: [{ id: 2, attributes: { style: { 'background-image': ['url("./dynamic.png?token=x#icon")', 'important'], color: false } } }] },
    { source: 0, attributes: [{ id: 2, attributes: { style: { 'background-image': ['url("blob:dynamic")', 'important'], color: false } } }] }],
  ['stylesheet declaration', { source: 13, id: 5, index: [0], set: { property: 'background-image', value: 'url("./dynamic.png?token=x#icon")', priority: 'important' } },
    { source: 13, id: 5, index: [0], set: { property: 'background-image', value: 'url("blob:dynamic")', priority: 'important' } }],
  ...['replace', 'replaceSync'].map(field => [field,
    { source: 8, styleId: 1, [field]: '.icon { background: url("./dynamic.png?token=x#icon"); content: "url(./prose.png)" } /* url(./comment.png) */' },
    { source: 8, styleId: 1, [field]: '.icon { background: url("blob:dynamic"); content: "url(./prose.png)" } /* url(./comment.png) */' }])
] as const) {
  test(`discovers resources in rrweb ${shape} without collecting prose`, () => {
    const event = { type: 3, timestamp: 42, data } as RecordedEvent;
    const before = structuredClone(event);
    assert.deepEqual(collectAssetReferences(event, pageUrl), [
      { url: 'https://demo.example/app/dynamic.png?token=x#icon', context: 'css', firstSeenAt: 42 }
    ]);
    assert.deepEqual(event, before);
  });
  test(`rewrites resources in rrweb ${shape} without editing input`, () => {
    const event = { type: 3, timestamp: 42, data } as RecordedEvent;
    const before = structuredClone(event);
    const rewritten = rewriteRecordedEvents([event], new Map([
      ['https://demo.example/app/dynamic.png?token=x#icon', 'blob:dynamic'],
      ['https://demo.example/app/prose.png', 'blob:prose'],
      ['https://demo.example/app/comment.png', 'blob:comment']
    ]), pageUrl);
    assert.deepEqual(rewritten[0].data, expected);
    assert.deepEqual(event, before);
  });
}

test('replay uses each Meta URL across navigation and snapshot boundaries for exact relative image and CSS matching', () => {
  const snapshot = (timestamp: number, tagName = 'img'): RecordedEvent => ({ type: 2, timestamp, data: { node: {
    type: 2, id: 2, tagName, attributes: { src: './image.png?q=1#part', style: 'background: url(./image.png?q=1#part)' }, childNodes: []
  } } });
  const events: RecordedEvent[] = [
    { type: 4, timestamp: 0, data: { href: 'https://demo.example/first/view' } }, snapshot(1),
    { type: 4, timestamp: 2, data: { href: 'https://demo.example/second/view' } }, snapshot(3),
    { type: 3, timestamp: 4, data: { source: 0, attributes: [{ id: 2, attributes: { src: './image.png?q=1#part', style: 'background: url(./image.png?q=1#part)' } }] } },
    snapshot(5, 'a'),
    { type: 3, timestamp: 6, data: { source: 0, attributes: [{ id: 2, attributes: { src: './image.png?q=1#part' } }] } },
    { type: 3, timestamp: 7, data: { source: 0, adds: [{ node: { type: 2, tagName: 'img', attributes: { src: './image.png?q=2#part' } } }] } }
  ];
  const before = structuredClone(events);
  const result = rewriteRecordedEvents(events, new Map([
    ['https://demo.example/first/image.png?q=1#part', 'blob:first'],
    ['https://demo.example/second/image.png?q=1#part', 'blob:second']
  ]), pageUrl);
  assert.equal((result[1].data as any).node.attributes.src, 'blob:first');
  assert.equal((result[3].data as any).node.attributes.src, 'blob:second');
  assert.equal((result[3].data as any).node.attributes.style, 'background: url(blob:second)');
  assert.deepEqual((result[4].data as any).attributes[0].attributes, { src: 'blob:second', style: 'background: url(blob:second)' });
  assert.equal((result[5].data as any).node.attributes.style, 'background: url(blob:second)');
  assert.equal((result[6].data as any).attributes[0].attributes.src, './image.png?q=1#part', 'Full snapshot must reset reused node IDs');
  assert.equal((result[7].data as any).adds[0].node.attributes.src, './image.png?q=2#part', 'Query must match exactly');
  assert.deepEqual(events, before);
});

test('preload reference collection follows navigation Meta URLs at the correct replay time', async context => {
  const { root, demo } = await replayFixture();
  const url = 'https://demo.example/second/image.svg?q=1#part';
  const bytes = svgBytes();
  await recordAssetCandidate(root, demo.manifest.id, { url, context: 'img', firstSeenAt: 200 });
  await saveCapturedAsset(root, demo.manifest.id, { url, mime: 'image/svg+xml', bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
  demo.assets = (await loadDemo(root, demo.manifest.id)).assets;
  demo.events = [
    { type: 4, timestamp: 100, data: { href: pageUrl } },
    { type: 2, timestamp: 101, data: { node: { type: 2, id: 1, tagName: 'body', childNodes: [] } } },
    { type: 4, timestamp: 199, data: { href: 'https://demo.example/second/view' } },
    { type: 2, timestamp: 200, data: { node: { type: 2, id: 2, tagName: 'img', attributes: { src: './image.svg?q=1#part' } } } }
  ];
  const decoded: string[] = [];
  class Decoder {
    src = '';
    async decode() { decoded.push(this.src); }
    removeAttribute() { this.src = ''; }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: Decoder });
  context.after(() => { if (previous) Object.defineProperty(globalThis, 'Image', previous); else Reflect.deleteProperty(globalThis, 'Image'); });
  const prepared = await prepareReplayAssets(root, demo);
  context.after(() => prepared.release());
  await prepared.preloadThrough(99);
  assert.equal(decoded.length, 0);
  await prepared.preloadThrough(100);
  assert.equal(decoded.length, 1, 'Navigated snapshot image must preload at its replay boundary');
  assert.equal(decoded[0], (prepared.events[3].data as any).node.attributes.src);
  assert.match(decoded[0], /^blob:.*#part$/);
});

test('coverage summaries distinguish no candidates, saved candidates, and failures', () => {
  assert.deepEqual(summarizeAssetIndex({ version: 1, entries: [] }),
    { discovered: 0, saved: 0, failed: 0, uniqueBytes: 0, status: 'no-candidates' });
  assert.deepEqual(summarizeAssetIndex({ version: 1, entries: [
    { url: 'https://demo.example/a.png', context: 'img', status: 'saved', filename: 'a.png', bytes: 42 }
  ] }), { discovered: 1, saved: 1, failed: 0, uniqueBytes: 42, status: 'complete' });
  assert.deepEqual(summarizeAssetIndex({ version: 1, entries: [
    { url: 'https://demo.example/a.png', context: 'img', status: 'saved', filename: 'a.png', bytes: 42 },
    { url: 'https://demo.example/b.png', context: 'img', status: 'failed', reason: 'HTTP 404' }
  ] }), { discovered: 2, saved: 1, failed: 1, uniqueBytes: 42, status: 'partial' });
});

test('failure display URLs remove credentials, query tokens, and fragments', () => {
  assert.equal(redactAssetUrl('https://operator:password@demo.example/photo.png?token=secret#fragment'),
    'https://demo.example/photo.png');
  assert.equal(redactAssetUrl('blob:https://user:pass@example.com/123?token=secret#frag'),
    'blob:https://example.com/123');
  assert.equal(redactAssetUrl('blob:null/123?token=secret#frag'), 'blob:null/123');
});

test('discovers and rewrites rrweb inlined stylesheet attributes without treating the source sheet as missing', () => {
  const events: RecordedEvent[] = [
    { type: 2, timestamp: 1, data: { node: {
      type: 2, id: 10, tagName: 'link', attributes: { rel: 'stylesheet', href: '/theme.css', _cssText: '.offscreen { background: url("/offscreen.png") }' }, childNodes: []
    } } },
    { type: 3, timestamp: 2, data: { source: 0, attributes: [
      { id: 10, attributes: { _cssText: '@font-face { src: url("/extra.woff2") }' } }
    ] } }
  ];
  const before = structuredClone(events);
  const tags = new Map<number, string>();
  assert.deepEqual(events.flatMap(event => collectAssetReferences(event, pageUrl, tags)), [
    { url: 'https://demo.example/offscreen.png', context: 'css', firstSeenAt: 1 },
    { url: 'https://demo.example/extra.woff2', context: 'css', firstSeenAt: 2 }
  ]);
  const copies = rewriteRecordedEvents(events, new Map([
    ['https://demo.example/offscreen.png', 'blob:local-image'], ['https://demo.example/extra.woff2', 'blob:local-font']
  ]), pageUrl);
  assert.equal((copies[0].data as any).node.attributes._cssText, '.offscreen { background: url("blob:local-image") }');
  assert.equal((copies[1].data as any).attributes[0].attributes._cssText, '@font-face { src: url("blob:local-font") }');
  assert.deepEqual(events, before);
});

test('collects only recognized resource references from a snapshot and mutation', () => {
  const snapshot: RecordedEvent = {
    type: 2, timestamp: 100, data: { node: {
      type: 0, childNodes: [{ type: 1, childNodes: [{
        type: 2, tagName: 'html', attributes: {}, childNodes: [{
          type: 2, tagName: 'body', attributes: {}, childNodes: [
            { type: 2, tagName: 'img', attributes: { src: '/photo.png?token=secret#icon', srcset: '/small.png 1x, /large.png 2x' }, childNodes: [] },
            { type: 2, tagName: 'svg', attributes: {}, childNodes: [
              { type: 2, tagName: 'image', attributes: { href: '/icons.svg#photo' }, childNodes: [] },
              { type: 2, tagName: 'use', attributes: { 'xlink:href': '/icons.svg#check' }, childNodes: [] }
            ] },
            { type: 2, tagName: 'div', attributes: { style: "background-image: url('/background.png')" }, childNodes: [] },
            { type: 2, tagName: 'style', attributes: {}, childNodes: [
              { type: 3, textContent: '@font-face { src: url("/icons.woff2") format("woff2"); }' }
            ] },
            { type: 2, tagName: 'a', attributes: { href: '/navigate.png' }, childNodes: [] },
            { type: 2, tagName: 'script', attributes: { src: '/script.js' }, childNodes: [] },
            { type: 2, tagName: 'img', attributes: { src: 'data:image/png;base64,AA==', srcset: 'data:image/png;base64,AA== 1x, /small.png 2x' }, childNodes: [] }
          ]
        }]
      }]}]
    } }
  };
  const mutation: RecordedEvent = {
    type: 3, timestamp: 200, data: { source: 0, adds: [{ parentId: 1, nextId: null,
      node: { type: 2, tagName: 'picture', attributes: {}, childNodes: [
        { type: 2, tagName: 'source', attributes: { srcset: './next.webp 1x' }, childNodes: [] }
      ] }
    }], attributes: [{ id: 5, attributes: { style: 'mask-image: url(/mask.svg#shape)' } }] }
  };
  const references = [
    ...collectAssetReferences(snapshot, pageUrl),
    ...collectAssetReferences(mutation, pageUrl)
  ];
  assert.deepEqual(references, [
    { url: 'https://demo.example/photo.png?token=secret#icon', context: 'img', firstSeenAt: 100 },
    { url: 'https://demo.example/small.png', context: 'srcset', firstSeenAt: 100 },
    { url: 'https://demo.example/large.png', context: 'srcset', firstSeenAt: 100 },
    { url: 'https://demo.example/icons.svg#photo', context: 'svg', firstSeenAt: 100 },
    { url: 'https://demo.example/icons.svg#check', context: 'svg', firstSeenAt: 100 },
    { url: 'https://demo.example/background.png', context: 'css', firstSeenAt: 100 },
    { url: 'https://demo.example/icons.woff2', context: 'css', firstSeenAt: 100 },
    { url: 'https://demo.example/app/next.webp', context: 'srcset', firstSeenAt: 200 },
    { url: 'https://demo.example/mask.svg#shape', context: 'css', firstSeenAt: 200 }
  ]);
  assert.equal(redactAssetUrl('https://demo.example/photo.png?token=secret#icon'), 'https://demo.example/photo.png');
});

test('rewrites recognized references in a copy while preserving input events', () => {
  const events: RecordedEvent[] = [{ type: 2, timestamp: 100, data: { node: {
    type: 2, tagName: 'body', attributes: {}, childNodes: [
      { type: 2, tagName: 'img', attributes: { src: 'https://demo.example/photo.png?token=secret#icon', srcset: 'https://demo.example/small.png 1x, https://demo.example/large.png 2x' }, childNodes: [] },
      { type: 2, tagName: 'div', attributes: { style: "background: url('https://demo.example/background.png')" }, childNodes: [] },
      { type: 2, tagName: 'style', attributes: {}, childNodes: [{ type: 3, textContent: '@font-face { src: url("https://demo.example/icons.woff2") }' }] },
      { type: 2, tagName: 'svg', attributes: {}, childNodes: [{ type: 2, tagName: 'use', attributes: { href: '/icons.svg#check' }, childNodes: [] }] },
      { type: 2, tagName: 'a', attributes: { href: 'https://demo.example/photo.png?token=secret#icon' }, childNodes: [] }
    ]
  } } }];
  const before = structuredClone(events);
  const replacements = new Map([
    ['https://demo.example/photo.png?token=secret#icon', 'blob:https://demo.example/photo'],
    ['https://demo.example/small.png', 'blob:https://demo.example/small'],
    ['https://demo.example/large.png', 'blob:https://demo.example/large'],
    ['https://demo.example/background.png', 'blob:https://demo.example/background'],
    ['https://demo.example/icons.woff2', 'blob:https://demo.example/icons'],
    ['https://demo.example/icons.svg#check', 'blob:https://demo.example/svg-check']
  ]);
  const rewritten = rewriteRecordedEvents(events, replacements, pageUrl);
  const body = (rewritten[0].data as any).node;
  assert.equal(body.childNodes[0].attributes.src, 'blob:https://demo.example/photo');
  assert.equal(body.childNodes[0].attributes.srcset, 'blob:https://demo.example/small 1x, blob:https://demo.example/large 2x');
  assert.equal(body.childNodes[1].attributes.style, "background: url('blob:https://demo.example/background')");
  assert.equal(body.childNodes[2].childNodes[0].textContent, '@font-face { src: url("blob:https://demo.example/icons") }');
  assert.equal(body.childNodes[3].childNodes[0].attributes.href, 'blob:https://demo.example/svg-check#check');
  assert.equal(body.childNodes[4].attributes.href, 'https://demo.example/photo.png?token=secret#icon');
  assert.deepEqual(events, before);
});

test('rewrites path-relative candidates against the recording page URL', () => {
  const events: RecordedEvent[] = [{ type: 2, timestamp: 1, data: { node: {
    type: 2, tagName: 'body', attributes: {}, childNodes: [
      { type: 2, tagName: 'img', attributes: { src: './images/photo.png?token=secret' }, childNodes: [] },
      { type: 2, tagName: 'div', attributes: { style: "background: url('../fonts/icon.woff2')" }, childNodes: [] }
    ]
  } } }];
  const replacements = new Map([
    ['https://demo.example/app/images/photo.png?token=secret', 'blob:https://demo.example/photo'],
    ['https://demo.example/fonts/icon.woff2', 'blob:https://demo.example/font']
  ]);
  const result = rewriteRecordedEvents(events, replacements, pageUrl);
  const children = (result[0].data as any).node.childNodes;
  assert.equal(children[0].attributes.src, 'blob:https://demo.example/photo');
  assert.equal(children[1].attributes.style, "background: url('blob:https://demo.example/font')");
});

test('uses snapshot node tags to classify later attribute and style text mutations', () => {
  const nodeTags = new Map<number, string>();
  const snapshot: RecordedEvent = { type: 2, timestamp: 1, data: { node: {
    type: 2, id: 1, tagName: 'body', attributes: {}, childNodes: [
      { type: 2, id: 2, tagName: 'img', attributes: {}, childNodes: [] },
      { type: 2, id: 3, tagName: 'use', attributes: {}, childNodes: [] },
      { type: 2, id: 4, tagName: 'script', attributes: {}, childNodes: [] },
      { type: 2, id: 5, tagName: 'style', attributes: {}, childNodes: [
        { type: 3, id: 6, textContent: '' }
      ] }
    ]
  } } };
  collectAssetReferences(snapshot, pageUrl, nodeTags);
  const mutation: RecordedEvent = { type: 3, timestamp: 2, data: { source: 0,
    adds: [],
    attributes: [
      { id: 2, attributes: { src: './updated.png' } },
      { id: 3, attributes: { href: '../icons.svg#saved' } },
      { id: 4, attributes: { src: './execute.js' } }
    ],
    texts: [{ id: 6, value: '@font-face { src: url("../icons.woff2") }' }]
  } };
  assert.deepEqual(collectAssetReferences(mutation, pageUrl, nodeTags), [
    { url: 'https://demo.example/app/updated.png', context: 'img', firstSeenAt: 2 },
    { url: 'https://demo.example/icons.svg#saved', context: 'svg', firstSeenAt: 2 },
    { url: 'https://demo.example/icons.woff2', context: 'css', firstSeenAt: 2 }
  ]);
});

test('ignores fragment-only SVG and CSS references', () => {
  const event: RecordedEvent = { type: 2, timestamp: 10, data: { node: {
    type: 2, tagName: 'svg', attributes: {}, childNodes: [
      { type: 2, tagName: 'use', attributes: { href: '#icon' }, childNodes: [] },
      { type: 2, tagName: 'image', attributes: { href: '/icons.svg#external' }, childNodes: [] },
      { type: 2, tagName: 'rect', attributes: { style: 'fill: url(#gradient)' }, childNodes: [] }
    ]
  } } };
  assert.deepEqual(collectAssetReferences(event, pageUrl), [
    { url: 'https://demo.example/icons.svg#external', context: 'svg', firstSeenAt: 10 }
  ]);
});

test('keeps a candidate after descriptorless data URL in srcset', () => {
  const event: RecordedEvent = { type: 2, timestamp: 11, data: { node: {
    type: 2, tagName: 'img', attributes: { srcset: 'data:image/png;base64,AA==, /next.png 2x' }, childNodes: []
  } } };
  assert.deepEqual(collectAssetReferences(event, pageUrl), [
    { url: 'https://demo.example/next.png', context: 'srcset', firstSeenAt: 11 }
  ]);
  const rewritten = rewriteRecordedEvents([event], new Map([
    ['https://demo.example/next.png', 'blob:https://demo.example/next']
  ]), pageUrl);
  assert.equal((rewritten[0].data as any).node.attributes.srcset,
    'data:image/png;base64,AA==, blob:https://demo.example/next 2x');
});

test('preserves external SVG fragment on the local Blob URL', () => {
  const event: RecordedEvent = { type: 2, timestamp: 12, data: { node: {
    type: 2, tagName: 'use', attributes: { href: '/icons.svg#check' }, childNodes: []
  } } };
  const rewritten = rewriteRecordedEvents([event], new Map([
    ['https://demo.example/icons.svg#check', 'blob:https://demo.example/icons']
  ]), pageUrl);
  assert.equal((rewritten[0].data as any).node.attributes.href, 'blob:https://demo.example/icons#check');
});

test('collects CSS URLs from a newly added style text node', () => {
  const nodeTags = new Map<number, string>([[5, 'style']]);
  const event: RecordedEvent = { type: 3, timestamp: 13, data: { source: 0,
    adds: [{ parentId: 5, nextId: null, node: { type: 3, id: 6, textContent: '.icon { background: url("/new.svg") }' } }]
  } };
  assert.deepEqual(collectAssetReferences(event, pageUrl, nodeTags), [
    { url: 'https://demo.example/new.svg', context: 'css', firstSeenAt: 13 }
  ]);
});

class MemoryFile {
  kind = 'file';
  bytes = new Uint8Array();
  reportedSize: number | null = null;
  writes = 0;
  name: string;
  constructor(name: string) { this.name = name; }
  async getFile(): Promise<File> {
    const file = new File([this.bytes], this.name);
    if (this.reportedSize !== null) Object.defineProperty(file, 'size', { value: this.reportedSize });
    return file;
  }
  async createWritable() {
    return {
      write: async (value: string | Uint8Array | Blob) => {
        this.writes++;
        this.bytes = typeof value === 'string' ? new TextEncoder().encode(value)
          : value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : new Uint8Array(value);
      },
      close: async () => {}
    };
  }
}

class MemoryDirectory {
  kind = 'directory';
  files = new Map<string, MemoryFile>();
  directories = new Map<string, MemoryDirectory>();
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFile> {
    let file = this.files.get(name);
    if (!file && options?.create) { file = new MemoryFile(name); this.files.set(name, file); }
    if (!file) throw new DOMException('Not found', 'NotFoundError');
    return file;
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectory> {
    let directory = this.directories.get(name);
    if (!directory && options?.create) { directory = new MemoryDirectory(); this.directories.set(name, directory); }
    if (!directory) throw new DOMException('Not found', 'NotFoundError');
    return directory;
  }
  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    if (this.files.delete(name)) return;
    const directory = this.directories.get(name);
    if (!directory) throw new DOMException('Not found', 'NotFoundError');
    if (!options?.recursive && (directory.files.size || directory.directories.size)) throw new DOMException('Directory is not empty', 'InvalidModificationError');
    this.directories.delete(name);
  }
  async *entries(): AsyncIterableIterator<[string, MemoryFile | MemoryDirectory]> {
    for (const entry of this.files) yield entry;
    for (const entry of this.directories) yield entry;
  }
}

function rootHandle(): { root: FileSystemDirectoryHandle; memory: MemoryDirectory } {
  const memory = new MemoryDirectory();
  return { root: memory as unknown as FileSystemDirectoryHandle, memory };
}

test('deleting one demo removes its nested recording and assets without touching another demo', async () => {
  const { root, memory } = rootHandle();
  const first = await createDemo(root, 'Delete me', pageUrl);
  const second = await createDemo(root, 'Keep me', pageUrl);
  const demos = memory.directories.get('demos')!;
  const firstFolder = demos.directories.get(first.id)!;
  await (await firstFolder.getDirectoryHandle('events')).getFileHandle('batch.json', { create: true });
  await (await firstFolder.getDirectoryHandle('assets')).getFileHandle('image.png', { create: true });
  await storage.deleteDemo(root, first.id);
  assert.equal(demos.directories.has(first.id), false);
  assert.equal(demos.directories.has(second.id), true);
  assert.equal((await loadDemo(root, second.id)).manifest.title, 'Keep me');
});

test('deletion refuses a demo folder whose manifest names another demo', async () => {
  const { root, memory } = rootHandle();
  const first = await createDemo(root, 'First', pageUrl);
  const second = await createDemo(root, 'Second', pageUrl);
  const demos = memory.directories.get('demos')!;
  const firstFolder = demos.directories.get(first.id)!;
  const manifest = await firstFolder.getFileHandle('manifest.json');
  const writer = await manifest.createWritable();
  await writer.write(JSON.stringify({ ...first, id: second.id }));
  await writer.close();
  await assert.rejects(storage.deleteDemo(root, first.id), /编号不一致/);
  assert.equal(demos.directories.has(first.id), true);
  assert.equal(demos.directories.has(second.id), true);
});

function svgBytes(): Uint8Array {
  return new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>');
}

async function replayFixture() {
  const { root, memory } = rootHandle();
  const manifest = await createDemo(root, 'Replay', pageUrl);
  const bytes = svgBytes();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  for (const url of ['https://demo.example/a.svg?token=one', 'https://demo.example/b.svg#check']) {
    await recordAssetCandidate(root, manifest.id, { url, context: 'img', firstSeenAt: 100 });
    await saveCapturedAsset(root, manifest.id, { url, mime: 'image/svg+xml', sha256, bytes });
  }
  const demo = await loadDemo(root, manifest.id);
  demo.events = [{ type: 2, timestamp: 100, data: { node: { type: 2, tagName: 'body', attributes: {}, childNodes: [
    { type: 2, tagName: 'img', attributes: { src: '/a.svg?token=one', srcset: '/a.svg?token=one 1x, /b.svg#check 2x' }, childNodes: [] },
    { type: 2, tagName: 'div', attributes: { style: 'background: url("/b.svg#check")' }, childNodes: [] },
    { type: 2, tagName: 'use', attributes: { href: '/b.svg#check' }, childNodes: [] },
    { type: 2, tagName: 'img', attributes: { src: '/a.svg?token=other' }, childNodes: [] }
  ] } } }];
  return { root, memory, demo };
}

for (const status of ['failed', 'pending'] as const) {
test(`a ${status} opaque-origin Blob candidate keeps saved entries in the asset index`, async () => {
  const { root, demo } = await replayFixture();
  const url = `blob:null/${status}-candidate`;
  await recordAssetCandidate(root, demo.manifest.id, { url, context: 'img', firstSeenAt: 101 });
  if (status === 'failed') await recordAssetFailure(root, demo.manifest.id, { url, context: 'img', reason: 'Cross-origin resource is not captured' });
  const loaded = await loadDemo(root, demo.manifest.id);
  assert.equal(loaded.assets?.entries.length, 3);
  assert.equal(loaded.assets?.entries.find(entry => entry.url === url)?.status, status);
  loaded.events = demo.events;
  const prepared = await prepareReplayAssets(root, loaded);
  assert.match((prepared.events[0].data as any).node.childNodes[0].attributes.src, /^blob:/);
  assert.deepEqual(prepared.issues, []);
  prepared.release();
});
}

test('offline replay maps exact URLs, srcset, quoted CSS and SVG fragments using one local file without editing recorded events', async () => {
  const { root, demo } = await replayFixture();
  const before = structuredClone(demo);
  const prepared = await prepareReplayAssets(root, demo);
  const nodes = (prepared.events[0].data as any).node.childNodes;
  const local = nodes[0].attributes.src;
  assert.match(local, /^blob:/);
  assert.equal(nodes[0].attributes.srcset, `${local} 1x, ${local}#check 2x`);
  assert.equal(nodes[1].attributes.style, `background: url("${local}#check")`);
  assert.equal(nodes[2].attributes.href, `${local}#check`);
  assert.equal(nodes[3].attributes.src, '/a.svg?token=other');
  const response = await fetch(local);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  assert.equal(await response.text(), new TextDecoder().decode(svgBytes()));
  assert.deepEqual(demo, before);
  assert.deepEqual(prepared.issues, []);
  prepared.release();
  prepared.release();
  await assert.rejects(fetch(local), /fetch failed/);
});

test('missing indexed files report each affected URL and preserve source fallback without reading orphan files', async () => {
  const { root, memory, demo } = await replayFixture();
  const assets = memory.directories.get('demos')!.directories.get(demo.manifest.id)!.directories.get('assets')!;
  assets.files.delete(demo.assets!.entries[0].filename!);
  const orphan = await assets.getFileHandle(`${'f'.repeat(64)}.svg`, { create: true });
  orphan.bytes = new Uint8Array(svgBytes());
  const before = structuredClone(demo);
  const prepared = await prepareReplayAssets(root, demo);
  assert.deepEqual(prepared.events, demo.events);
  assert.deepEqual(prepared.issues.map(issue => issue.url), demo.assets!.entries.map(entry => entry.url));
  assert.ok(prepared.issues.every(issue => /missing|read|unavailable/i.test(issue.reason)));
  assert.deepEqual(demo, before);
  prepared.release();
});

for (const damagedIndex of ['missing', 'unreadable'] as const) {
test(`version-2 replay keeps recorded events usable when the asset index is ${damagedIndex}`, async () => {
  const { root, memory, demo } = await replayFixture();
  const batch = { type: 'EVENT_BATCH' as const, sessionId: demo.manifest.id, batchId: 'batch-1',
    events: demo.events, clicks: [], viewport: { width: 1280, height: 720 } };
  await writeBatch(root, demo.manifest, batch);
  const assets = memory.directories.get('demos')!.directories.get(demo.manifest.id)!.directories.get('assets')!;
  if (damagedIndex === 'missing') assets.files.delete('index.json');
  else assets.files.get('index.json')!.bytes = new TextEncoder().encode('{invalid json');
  const loaded = await loadDemo(root, demo.manifest.id);
  assert.equal(loaded.manifest.formatVersion, 2);
  assert.equal(loaded.assets, null);
  assert.deepEqual(loaded.events, demo.events);
  const prepared = await prepareReplayAssets(root, loaded);
  assert.deepEqual(prepared.events, demo.events);
  assert.equal(prepared.issues.length, 1);
  assert.match(prepared.issues[0].reason, /index.*missing|unreadable/i);
  prepared.release();
});
}

for (const [field, invalid] of [
  ['mime', 17], ['filename', '../outside.svg'], ['bytes', -1],
  ['context', 'script'], ['status', 'available'], ['url', 'not a URL']
] as const) {
test(`version-2 replay treats a saved index entry with invalid ${field} as unavailable`, async () => {
  const { root, memory, demo } = await replayFixture();
  const assets = memory.directories.get('demos')!.directories.get(demo.manifest.id)!.directories.get('assets')!;
  const file = assets.files.get('index.json')!;
  const index = JSON.parse(new TextDecoder().decode(file.bytes));
  index.entries[0][field] = invalid;
  file.bytes = new TextEncoder().encode(JSON.stringify(index));
  const loaded = await loadDemo(root, demo.manifest.id);
  assert.equal(loaded.assets, null);
  const prepared = await prepareReplayAssets(root, loaded);
  assert.deepEqual(prepared.events, loaded.events);
  assert.match(prepared.issues[0].reason, /index.*missing|unreadable/i);
  prepared.release();
});
}

test('legacy replay preserves event identity and performs no filesystem access', async () => {
  const { demo } = await replayFixture();
  demo.manifest.formatVersion = 1;
  demo.assets = null;
  const prepared = await prepareReplayAssets({} as FileSystemDirectoryHandle, demo);
  assert.equal(prepared.events, demo.events);
  assert.deepEqual(prepared.issues, []);
  await prepared.preloadThrough(10000);
  prepared.release();
});

test('preloading includes the initial snapshot, caps concurrent decodes, respects later timestamps and cancels on release', async context => {
  const { root, demo } = await replayFixture();
  const nodes: any[] = [];
  for (let i = 0; i < 6; i++) {
    const url = `https://demo.example/preload-${i}.svg`;
    const bytes = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><circle r="${i + 2}"/></svg>`);
    await recordAssetCandidate(root, demo.manifest.id, { url, context: 'img', firstSeenAt: 100 });
    await saveCapturedAsset(root, demo.manifest.id, { url, mime: 'image/svg+xml', bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
    nodes.push({ type: 2, tagName: 'img', id: i, attributes: { src: url }, childNodes: [] });
  }
  demo.assets = (await loadDemo(root, demo.manifest.id)).assets;
  demo.events = [
    { type: 4, timestamp: 90, data: {} },
    { type: 2, timestamp: 100, data: { node: { type: 2, tagName: 'body', childNodes: nodes.slice(0, 5) } } },
    { type: 3, timestamp: 190, data: { source: 0, adds: [{ node: nodes[5] }] } }
  ];
  const decodes: Array<{ image: any; finish(): void }> = [];
  class Decoder {
    src = '';
    decode() { return new Promise<void>(resolve => decodes.push({ image: this, finish: resolve })); }
    removeAttribute() { this.src = ''; }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: Decoder });
  context.after(() => { if (previous) Object.defineProperty(globalThis, 'Image', previous); else Reflect.deleteProperty(globalThis, 'Image'); });
  const prepared = await prepareReplayAssets(root, demo);
  const initial = prepared.preloadThrough(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(decodes.length, 4, 'Only four image decodes may run together');
  decodes[0].finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(decodes.length, 5, 'Initial snapshot must load even when its timestamp follows the meta event');
  decodes.forEach(item => item.finish());
  await initial;
  await prepared.preloadThrough(99);
  assert.equal(decodes.length, 5, 'Future mutation must not preload before the requested gate');
  const later = prepared.preloadThrough(100);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(decodes.length, 6);
  prepared.release();
  await later;
  assert.equal(decodes[5].image.src, '', 'Release must cancel the pending decode');
  await prepared.preloadThrough(1000);
  assert.equal(decodes.length, 6, 'Released preparations cannot restart preloads');
});

test('a timed-out image decode is cancelled and reported without blocking replay forever', async context => {
  const { root, demo } = await replayFixture();
  const started: Array<{ src: string }> = [];
  class Decoder {
    src = '';
    decode() { started.push(this); return new Promise<void>(() => {}); }
    removeAttribute() { this.src = ''; }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: Decoder });
  context.after(() => { if (previous) Object.defineProperty(globalThis, 'Image', previous); else Reflect.deleteProperty(globalThis, 'Image'); });
  const prepared = await prepareReplayAssets(root, demo);
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = prepared.preloadThrough(0);
  context.mock.timers.tick(5000);
  await pending;
  assert.ok(started.length > 0);
  assert.ok(started.every(image => image.src === ''), 'Timed-out images must stop decoding before freeing a concurrency slot');
  assert.ok(prepared.issues.some(issue => /timed out/i.test(issue.reason)));
  prepared.release();
});

for (const delayedWrite of ['asset', 'index'] as const) {
test(`receiver cannot mark a late ${delayedWrite} write saved after the sender resource deadline`, async context => {
  context.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { root, memory } = rootHandle();
  const manifest = await createDemo(root, 'Late receiver', pageUrl);
  const bytes = svgBytes();
  let releaseWrite!: () => void;
  let writeStarted!: () => void;
  const blockedWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
  const started = new Promise<void>(resolve => { writeStarted = resolve; });
  const originalCreateWritable = MemoryFile.prototype.createWritable;
  context.mock.method(MemoryFile.prototype, 'createWritable', async function(this: MemoryFile) {
    const writer = await originalCreateWritable.call(this);
    let delayClose = delayedWrite === 'asset' && this.name.endsWith('.svg');
    return { write: async (value: string | Uint8Array | Blob) => {
      if (delayedWrite === 'index' && this.name === 'index.json' && typeof value === 'string' && value.includes('"status":"saved"')) delayClose = true;
      await writer.write(value);
    }, close: async () => {
      if (delayClose) { writeStarted(); await blockedWrite; }
      await writer.close();
    } };
  });
  let receive!: (message: unknown) => void;
  const acknowledgements: AssetAck[] = [];
  let queue = Promise.resolve();
  receiveAssetPort({
    onMessage: { addListener(listener: typeof receive) { receive = listener; } },
    onDisconnect: { addListener() {} },
    postMessage(message: AssetAck) { acknowledgements.push(message); },
    disconnect() {}
  } as unknown as chrome.runtime.Port, {
    sessionId: manifest.id, demoId: manifest.id, tabId: 1, origin: 'https://demo.example'
  }, root, operation => { queue = queue.then(operation); });
  const envelope = { sessionId: manifest.id, assetId: '1' };
  receive({ ...envelope, type: 'ASSET_DISCOVERED', reference: { url: 'https://demo.example/late.svg', context: 'svg', firstSeenAt: 0 } });
  await queue;
  receive({ ...envelope, type: 'ASSET_BEGIN', mime: 'image/svg+xml', bytes: bytes.length, deadline: 10000 });
  await queue;
  receive({ ...envelope, type: 'ASSET_CHUNK', sequence: 0, base64: Buffer.from(bytes).toString('base64') });
  await queue;
  context.mock.timers.tick(9000);
  receive({ ...envelope, type: 'ASSET_END' });
  await started;
  context.mock.timers.tick(2000);
  // The index case deliberately omits FAILED: the receiver must enforce the
  // transmitted deadline even if the sender's cancellation message never arrives.
  if (delayedWrite === 'asset') receive({ ...envelope, type: 'ASSET_FAILED', reason: 'Asset capture timed out after 10 seconds' });
  releaseWrite();
  await queue;
  const loaded = await loadDemo(root, manifest.id);
  assert.equal(loaded.assets?.entries[0].status, 'failed', 'A write finishing at 11s must not make the expired resource saved');
  assert.match(loaded.assets?.entries[0].reason ?? '', /timed out/);
  assert.equal(acknowledgements.find(ack => ack.stage === 'ASSET_END')?.ok, false);
  const assets = memory.directories.get('demos')!.directories.get(manifest.id)!.directories.get('assets')!;
  assert.equal([...assets.files.keys()].filter(name => name.endsWith('.svg')).length, 1, 'Late generated files must be preserved');
  assert.equal((await finishDemo(root, manifest, 'interrupted')).offlineAssets?.status, 'partial');
});
}

test('rejects HTML disguised as an image and resources above 10 MB', () => {
  assert.deepEqual(validateAssetResponse('https://demo.example/logo.png', 'image/png', new TextEncoder().encode('<html>login</html>')),
    { reason: 'Unsupported or mismatched asset bytes' });
  assert.deepEqual(validateAssetResponse('https://demo.example/large.svg', 'image/svg+xml', new Uint8Array(10 * 1024 * 1024 + 1)),
    { reason: 'Resource exceeds 10 MB' });
});

test('accepts SVG and icon font bytes with matching MIME types', () => {
  assert.deepEqual(validateAssetResponse('https://demo.example/icon.svg', 'image/svg+xml', svgBytes()),
    { mime: 'image/svg+xml', extension: 'svg' });
  assert.deepEqual(validateAssetResponse('https://demo.example/icon.woff2', 'font/woff2', new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0])),
    { mime: 'font/woff2', extension: 'woff2' });
});

test('accepts SVG with static class-based painting styles and internal gradients', () => {
  const source = `<?xml version="1.0" encoding="utf-8"?>
    <svg xmlns="http://www.w3.org/2000/svg">
      <style type="text/css">
        .st0 { fill: none; stroke: url(#gradient-1); stroke-width: 6.9504; stroke-linecap: round; stroke-linejoin: round; stroke-miterlimit: 10; }
        .st1 { fill: #06101F; stroke: #000000; }
      </style>
      <linearGradient id="gradient-1" style="enable-background:new 0 0 288 288"><stop offset="0" style="stop-color:#fff;stop-opacity:0.1" /></linearGradient>
      <line class="st0" x1="0" y1="0" x2="10" y2="10" />
    </svg>`;
  assert.deepEqual(validateAssetResponse('https://demo.example/logo.svg', 'image/svg+xml', new TextEncoder().encode(source)),
    { mime: 'image/svg+xml', extension: 'svg' });
});

test('rejects active, external, or non-painting SVG styles', () => {
  for (const css of [
    '.st0 { fill: url(https://other.example/gradient.svg#g); }',
    '@import url(https://other.example/style.css); .st0 { fill: red; }',
    '.st0 { background-image: url(#gradient); }',
    '.st0:hover { fill: #fff; }',
    '.st0 { fill: #fff; } .st1 { stroke: url(\\23 gradient); }'
  ]) {
    const source = `<svg xmlns="http://www.w3.org/2000/svg"><style type="text/css">${css}</style><path class="st0" /></svg>`;
    assert.deepEqual(validateAssetResponse('https://demo.example/logo.svg', 'image/svg+xml', new TextEncoder().encode(source)),
      { reason: 'Unsupported or mismatched asset bytes' }, css);
  }
});

test('rejects SVG styles with attributes other than CSS type', () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg"><style media="all">.st0 { fill: #fff; }</style></svg>';
  assert.deepEqual(validateAssetResponse('https://demo.example/logo.svg', 'image/svg+xml', new TextEncoder().encode(source)),
    { reason: 'Unsupported or mismatched asset bytes' });
});

test('rejects SVG references outside the current image even with safe CSS', () => {
  for (const content of [
    '<image href="https://other.example/picture.png" />',
    '<path style="fill:url(https://other.example/gradient.svg#g)" />'
  ]) {
    for (const css of ['', '<style>.st0 { fill: #fff; }</style>']) {
      const source = `<svg xmlns="http://www.w3.org/2000/svg">${css}${content}</svg>`;
      assert.deepEqual(validateAssetResponse('https://demo.example/logo.svg', 'image/svg+xml', new TextEncoder().encode(source)),
        { reason: 'Unsupported or mismatched asset bytes' }, `${css} ${content}`);
    }
  }
});

test('rejects active SVG elements with Unicode namespace prefixes and SMIL animation', () => {
  for (const content of [
    '<é:script xmlns:é="http://www.w3.org/2000/svg">alert(1)</é:script>',
    '<é:style xmlns:é="http://www.w3.org/2000/svg">@import "https://other.example/x.css";</é:style>',
    '<image href="#local"><animate attributeName="href" to="https://other.example/x.png" begin="0s" /></image>'
  ]) {
    const source = `<svg xmlns="http://www.w3.org/2000/svg">${content}</svg>`;
    assert.deepEqual(validateAssetResponse('https://demo.example/logo.svg', 'image/svg+xml', new TextEncoder().encode(source)),
      { reason: 'Unsupported or mismatched asset bytes' }, content);
  }
});

test('rejects XML character references and unsupported inline SVG CSS', () => {
  for (const content of [
    '<path style="fill:u&#114;l(https://other.example/x.svg)" />',
    '<path style="filter:blur(4px)" />',
    '<path style="fill:u\\72l(https://other.example/x.svg)" />',
    '<path fill="u\\72l(https://other.example/x.svg)" />',
    '<g xml:base="https://other.example/"><image href="#local" /></g>'
  ]) {
    const source = `<svg xmlns="http://www.w3.org/2000/svg">${content}</svg>`;
    assert.deepEqual(validateAssetResponse('https://demo.example/logo.svg', 'image/svg+xml', new TextEncoder().encode(source)),
      { reason: 'Unsupported or mismatched asset bytes' }, content);
  }
});

test('rejects more than one embedded SVG style block', () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg"><style>.st0{fill:#fff}</style><style>.st1{stroke:#000}</style></svg>';
  assert.deepEqual(validateAssetResponse('https://demo.example/logo.svg', 'image/svg+xml', new TextEncoder().encode(source)),
    { reason: 'Unsupported or mismatched asset bytes' });
});

test('rejects namespace-qualified active SVG elements', () => {
  for (const element of ['script', 'foreignObject']) {
    const bytes = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:${element}>alert(1)</s:${element}></svg>`);
    assert.deepEqual(validateAssetResponse('https://demo.example/icon.svg', 'image/svg+xml', bytes),
      { reason: 'Unsupported or mismatched asset bytes' });
  }
});

test('finishing converts pending candidates to failures and a partial summary', async () => {
  const { root } = rootHandle();
  const manifest = await createDemo(root, 'Pending', pageUrl);
  await recordAssetCandidate(root, manifest.id, { url: 'https://demo.example/a.png?secret=1', context: 'img', firstSeenAt: 1 });
  const finished = await finishDemo(root, manifest);
  const loaded = await loadDemo(root, manifest.id);
  assert.equal(finished.formatVersion, 2);
  assert.deepEqual(finished.offlineAssets, { discovered: 1, saved: 0, failed: 1, uniqueBytes: 0, status: 'partial' });
  assert.equal(loaded.assets?.entries[0].status, 'failed');
  assert.equal(loaded.assets?.entries[0].url, 'https://demo.example/a.png?secret=1');
});

test('two URLs with identical bytes share one stored file and count its bytes once', async () => {
  const { root, memory } = rootHandle();
  const manifest = await createDemo(root, 'Dedup', pageUrl);
  const bytes = svgBytes();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const urls = ['https://demo.example/a.svg', 'https://demo.example/b.svg'];
  await Promise.all(urls.map((url, index) => recordAssetCandidate(root, manifest.id, { url, context: 'svg', firstSeenAt: index })));
  await Promise.all(urls.map(url => saveCapturedAsset(root, manifest.id, { url, mime: 'image/svg+xml', sha256, bytes })));
  const loaded = await loadDemo(root, manifest.id);
  const filename = `${sha256}.svg`;
  assert.equal((await loadAssetFile(root, manifest.id, filename)).size, bytes.length);
  assert.deepEqual(loaded.assets?.entries.map(entry => [entry.url, entry.filename, entry.status]), [
    [urls[0], filename, 'saved'], [urls[1], filename, 'saved']
  ]);
  assert.equal(memory.directories.get('demos')?.directories.get(manifest.id)?.directories.get('assets')?.files.size, 2);
  assert.deepEqual(summarizeAssetIndex(loaded.assets as AssetIndex),
    { discovered: 2, saved: 2, failed: 0, uniqueBytes: bytes.length, status: 'complete' });
});

test('rejects mismatched SHA-256 without saving a file', async () => {
  const { root, memory } = rootHandle();
  const manifest = await createDemo(root, 'Hash', pageUrl);
  const url = 'https://demo.example/a.svg';
  await recordAssetCandidate(root, manifest.id, { url, context: 'svg', firstSeenAt: 1 });
  await assert.rejects(saveCapturedAsset(root, manifest.id, { url, mime: 'image/svg+xml', sha256: '0'.repeat(64), bytes: svgBytes() }), /SHA-256/);
  const assets = memory.directories.get('demos')?.directories.get(manifest.id)?.directories.get('assets');
  assert.equal(assets?.files.size, 1);
  assert.equal((await loadDemo(root, manifest.id)).assets?.entries[0].status, 'failed');
});

test('keeps exact URL internally and records a failure without duplicate candidates', async () => {
  const { root } = rootHandle();
  const manifest = await createDemo(root, 'Failure', pageUrl);
  const url = 'https://demo.example/missing.png?credential=secret#part';
  await recordAssetCandidate(root, manifest.id, { url, context: 'img', firstSeenAt: 1 });
  await recordAssetFailure(root, manifest.id, { url, context: 'img', reason: 'HTTP 404' });
  const loaded = await loadDemo(root, manifest.id);
  assert.deepEqual(loaded.assets?.entries.map(entry => [entry.url, entry.status, entry.reason]), [[url, 'failed', 'HTTP 404']]);
  assert.equal(redactAssetUrl(loaded.assets!.entries[0].url), 'https://demo.example/missing.png');
});

test('loads a version-1 demo without creating or rewriting asset files', async () => {
  const { root, memory } = rootHandle();
  const id = 'demo-1e6ac9';
  const demos = await memory.getDirectoryHandle('demos', { create: true });
  const folder = await demos.getDirectoryHandle(id, { create: true });
  await folder.getDirectoryHandle('events', { create: true });
  const manifest = {
    formatVersion: 1, id, title: 'Legacy', sourceUrl: pageUrl, createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', status: 'ready', firstEventAt: null, viewport: null, chunks: 0, clicks: []
  };
  const manifestFile = await folder.getFileHandle('manifest.json', { create: true });
  const writer = await manifestFile.createWritable();
  await writer.write(JSON.stringify(manifest));
  await writer.close();
  const stepsFile = await folder.getFileHandle('steps.json', { create: true });
  const stepsWriter = await stepsFile.createWritable();
  await stepsWriter.write('[]');
  await stepsWriter.close();
  const before = new Uint8Array(manifestFile.bytes);
  const loaded = await loadDemo(root, id);
  assert.equal(loaded.assets, null);
  assert.deepEqual(manifestFile.bytes, before);
  assert.equal(folder.directories.has('assets'), false);
});

test('a late capture cannot change a finalized failure or its manifest summary', async () => {
  const { root } = rootHandle();
  const manifest = await createDemo(root, 'Finished', pageUrl);
  const url = 'https://demo.example/late.svg';
  await recordAssetCandidate(root, manifest.id, { url, context: 'svg', firstSeenAt: 1 });
  await finishDemo(root, manifest);
  const bytes = svgBytes();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await assert.rejects(saveCapturedAsset(root, manifest.id, { url, mime: 'image/svg+xml', sha256, bytes }), /finished/);
  const loaded = await loadDemo(root, manifest.id);
  assert.equal(loaded.assets?.entries[0].status, 'failed');
  assert.deepEqual(loaded.manifest.offlineAssets, { discovered: 1, saved: 0, failed: 1, uniqueBytes: 0, status: 'partial' });
});

test('an orphan asset file consumes the 200 MB physical storage budget', async () => {
  const { root, memory } = rootHandle();
  const manifest = await createDemo(root, 'Bounded', pageUrl);
  const assets = memory.directories.get('demos')!.directories.get(manifest.id)!.directories.get('assets')!;
  const orphan = await assets.getFileHandle(`${'a'.repeat(64)}.png`, { create: true });
  orphan.reportedSize = 200 * 1024 * 1024;
  const url = 'https://demo.example/new.svg';
  await recordAssetCandidate(root, manifest.id, { url, context: 'svg', firstSeenAt: 1 });
  const bytes = svgBytes();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const index = await saveCapturedAsset(root, manifest.id, { url, mime: 'image/svg+xml', sha256, bytes });
  assert.equal(index.entries[0].status, 'failed');
  assert.match(index.entries[0].reason ?? '', /200 MB/);
  assert.equal(assets.files.size, 2);
  assert.equal(orphan.reportedSize, 200 * 1024 * 1024);
});

test('a valid orphan with the target hash is reused without rewriting its file', async () => {
  const { root, memory } = rootHandle();
  const manifest = await createDemo(root, 'Reuse', pageUrl);
  const assets = memory.directories.get('demos')!.directories.get(manifest.id)!.directories.get('assets')!;
  const bytes = svgBytes();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = await assets.getFileHandle(`${sha256}.svg`, { create: true });
  const writer = await file.createWritable();
  await writer.write(bytes);
  await writer.close();
  const url = 'https://demo.example/reused.svg';
  await recordAssetCandidate(root, manifest.id, { url, context: 'svg', firstSeenAt: 1 });
  const index = await saveCapturedAsset(root, manifest.id, { url, mime: 'image/svg+xml', sha256, bytes });
  assert.equal(index.entries[0].status, 'saved');
  assert.equal(file.writes, 1);
  assert.equal(assets.files.size, 2);
});

test('a corrupt existing hash-named file is preserved and cannot become a saved asset', async () => {
  const { root, memory } = rootHandle();
  const manifest = await createDemo(root, 'Corrupt', pageUrl);
  const assets = memory.directories.get('demos')!.directories.get(manifest.id)!.directories.get('assets')!;
  const bytes = svgBytes();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = await assets.getFileHandle(`${sha256}.svg`, { create: true });
  const writer = await file.createWritable();
  await writer.write(new TextEncoder().encode('not the claimed content'));
  await writer.close();
  const url = 'https://demo.example/corrupt.svg';
  await recordAssetCandidate(root, manifest.id, { url, context: 'svg', firstSeenAt: 1 });
  const index = await saveCapturedAsset(root, manifest.id, { url, mime: 'image/svg+xml', sha256, bytes });
  assert.equal(index.entries[0].status, 'failed');
  assert.match(index.entries[0].reason ?? '', /Existing asset file/);
  assert.equal(await (await file.getFile()).text(), 'not the claimed content');
  assert.equal(file.writes, 1);
});
