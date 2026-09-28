import type { RecordedEvent } from './model.ts';

export interface AssetReference {
  url: string;
  context: 'img' | 'srcset' | 'svg' | 'css' | 'stylesheet';
  firstSeenAt: number;
}

type JsonObject = Record<string, unknown>;
type AssetContext = AssetReference['context'];

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function normalize(raw: string, pageUrl: string): string | null {
  if (raw.trim().startsWith('#')) return null;
  try {
    const url = new URL(raw.trim(), pageUrl);
    return ['http:', 'https:', 'blob:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function isInlineCssFragmentReference(raw: string, context: AssetContext): boolean {
  if (context !== 'css') return false;
  try {
    const url = new URL(raw);
    // rrweb absolutifies CSS url(#id) against the stylesheet URL, yielding
    // its directory plus #id. A directory is not the SVG resource itself.
    return ['http:', 'https:'].includes(url.protocol) && url.pathname !== '/' && url.pathname.endsWith('/')
      && !url.search && url.hash.length > 1;
  } catch { return false; }
}

function mapSrcset(value: string, map: (url: string) => string): string {
  let output = '';
  let copiedThrough = 0;
  let position = 0;
  while (position < value.length) {
    while (position < value.length && (value[position] === ',' || /\s/.test(value[position]))) position++;
    const start = position;
    while (position < value.length && !/\s/.test(value[position])) position++;
    let end = position;
    while (end > start && value[end - 1] === ',') end--;
    if (end > start) {
      const source = value.slice(start, end);
      if (!source.startsWith('data:')) {
        output += value.slice(copiedThrough, start) + map(source);
        copiedThrough = end;
      }
    }
    if (end === position) {
      while (position < value.length && value[position] !== ',') position++;
      if (position < value.length) position++;
    }
  }
  return output + value.slice(copiedThrough);
}

function mapCss(value: string, map: (url: string) => string): string {
  // Skip comments and standalone strings (e.g. content: "url(...)"), while
  // keeping quoted URLs inside a real url() token eligible for replacement.
  return value.replace(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\burl\(\s*(["']?)(.*?)\1\s*\)/gi, (whole, quote: string | undefined, source: string | undefined) => {
    if (source === undefined) return whole;
    const candidate = source.trim();
    const changed = isInlineCssFragmentReference(candidate, 'css') ? new URL(candidate).hash : map(candidate);
    return changed === candidate ? whole : `url(${quote}${changed}${quote})`;
  });
}

function visitAttributes(
  tag: string | null, attributes: JsonObject, visit: (raw: string, context: AssetContext) => string
): void {
  const name = tag?.toLowerCase();
  for (const [key, raw] of Object.entries(attributes)) {
    const attribute = key.toLowerCase();
    const styleDiff = attribute === 'style' ? object(raw) : null;
    if (styleDiff) {
      for (const [property, value] of Object.entries(styleDiff)) {
        if (typeof value === 'string') styleDiff[property] = mapCss(value, url => visit(url, 'css'));
        else if (Array.isArray(value) && typeof value[0] === 'string') value[0] = mapCss(value[0], url => visit(url, 'css'));
      }
    }
    if (typeof raw !== 'string') continue;
    let changed = raw;
    if (attribute === 'style' || (attribute === '_csstext' && (name === 'style' || name === 'link'))) changed = mapCss(raw, url => visit(url, 'css'));
    else if (attribute === 'srcset' && (name === 'img' || name === 'source' || name === null)) {
      changed = mapSrcset(raw, url => visit(url, 'srcset'));
    } else if (attribute === 'src' && name === 'img') changed = visit(raw, 'img');
    else if ((attribute === 'href' || attribute === 'xlink:href') && (name === 'image' || name === 'use')) {
      changed = visit(raw, 'svg');
    } else if (attribute === 'href' && name === 'link' && typeof attributes._cssText !== 'string' && /(?:^|\s)stylesheet(?:\s|$)/i.test(String(attributes.rel ?? ''))) {
      changed = visit(raw, 'stylesheet');
    }
    if (changed !== raw) attributes[key] = changed;
  }
}

function visitNode(
  nodeValue: unknown, visit: (raw: string, context: AssetContext) => string,
  nodeTags?: Map<number, string>, parentTag?: string
): void {
  const node = object(nodeValue);
  if (!node) return;
  const tag = node.type === 2 && typeof node.tagName === 'string' ? node.tagName.toLowerCase() : null;
  if (node.type === 3 && parentTag === 'style' && typeof node.textContent === 'string') {
    node.textContent = mapCss(node.textContent, url => visit(url, 'css'));
  }
  if (typeof node.id === 'number' && nodeTags) {
    if (tag) nodeTags.set(node.id, tag);
    else if (node.type === 3 && parentTag === 'style') nodeTags.set(node.id, 'style#text');
  }
  const attrs = object(node.attributes);
  if (tag && attrs) visitAttributes(tag, attrs, visit);
  if (Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) visitNode(child, visit, nodeTags, tag ?? parentTag);
  }
}

function visitEvent(
  event: RecordedEvent, visit: (raw: string, context: AssetContext) => string,
  nodeTags?: Map<number, string>
): void {
  const data = object(event.data);
  if (!data) return;
  if (event.type === 2) {
    nodeTags?.clear();
    visitNode(data.node, visit, nodeTags);
  }
  if (event.type !== 3) return;
  if (data.source === 0) {
    if (Array.isArray(data.adds)) {
      for (const item of data.adds) {
        const addition = object(item);
        const parentTag = typeof addition?.parentId === 'number' ? nodeTags?.get(addition.parentId) : undefined;
        visitNode(addition?.node, visit, nodeTags, parentTag);
      }
    }
    if (Array.isArray(data.attributes)) {
      for (const item of data.attributes) {
        const change = object(item);
        const attrs = object(change?.attributes);
        const tag = typeof change?.id === 'number' ? nodeTags?.get(change.id) ?? null : null;
        if (attrs) visitAttributes(tag, attrs, visit);
      }
    }
    if (Array.isArray(data.texts)) {
      for (const item of data.texts) {
        const change = object(item);
        if (typeof change?.id === 'number' && nodeTags?.get(change.id) === 'style#text' && typeof change.value === 'string') {
          change.value = mapCss(change.value, url => visit(url, 'css'));
        }
      }
    }
    if (Array.isArray(data.removes)) {
      for (const item of data.removes) {
        const removal = object(item);
        if (typeof removal?.id === 'number') nodeTags?.delete(removal.id);
      }
    }
  }
  if (data.source === 8) {
    if (Array.isArray(data.adds)) {
      for (const item of data.adds) {
        const addition = object(item);
        if (addition && typeof addition.rule === 'string') {
          addition.rule = mapCss(addition.rule, url => visit(url, 'css'));
        }
      }
    }
    for (const field of ['replace', 'replaceSync']) {
      if (typeof data[field] === 'string') data[field] = mapCss(data[field], url => visit(url, 'css'));
    }
  }
  if (data.source === 13) {
    const declaration = object(data.set);
    if (declaration && typeof declaration.value === 'string') {
      declaration.value = mapCss(declaration.value, url => visit(url, 'css'));
    }
  }
}

// Meta supplies the document URL for the following snapshot and mutations.
// Check-out full snapshots retain that URL; visitEvent resets their node tags.
export function* recordedEventsWithBaseUrl(events: readonly RecordedEvent[], pageUrl: string) {
  for (const event of events) {
    const data = object(event.data);
    if (event.type === 4 && typeof data?.href === 'string') {
      pageUrl = normalize(data.href, pageUrl) ?? pageUrl;
    }
    yield { event, pageUrl };
  }
}

export function collectAssetReferences(
  event: RecordedEvent, pageUrl: string, nodeTags?: Map<number, string>
): AssetReference[] {
  const references: AssetReference[] = [];
  const seen = new Set<string>();
  // The visitor edits its argument; use a copy so discovery cannot change the recording.
  visitEvent(structuredClone(event), (raw, context) => {
    const url = normalize(raw, pageUrl);
    if (url && !seen.has(url)) {
      seen.add(url);
      references.push({ url, context, firstSeenAt: event.timestamp });
    }
    return raw;
  }, nodeTags);
  return references;
}

export function rewriteRecordedEvents(
  events: readonly RecordedEvent[], replacements: ReadonlyMap<string, string>, pageUrl: string
): RecordedEvent[] {
  const copies = structuredClone(events) as RecordedEvent[];
  const nodeTags = new Map<number, string>();
  for (const { event, pageUrl: eventUrl } of recordedEventsWithBaseUrl(copies, pageUrl)) {
    visitEvent(event, (raw, context) => {
      if (raw.trim().startsWith('#')) return raw;
      const absolute = normalize(raw, eventUrl);
      const local = (absolute && replacements.get(absolute)) || replacements.get(raw);
      if (!local) return raw;
      if (context === 'svg' && absolute) {
        const hash = new URL(absolute).hash;
        if (hash) return `${local.split('#', 1)[0]}${hash}`;
      }
      return local;
    }, nodeTags);
  }
  return copies;
}

export function redactAssetUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    parsed.username = '';
    parsed.password = '';
    if (parsed.protocol === 'blob:') {
      try {
        const embedded = new URL(parsed.pathname);
        embedded.username = '';
        embedded.password = '';
        embedded.search = '';
        embedded.hash = '';
        return `blob:${embedded.href}`;
      } catch { /* Opaque-origin Blob URLs have no embedded credentials. */ }
    }
    return parsed.href;
  } catch { return url.split(/[?#]/, 1)[0]; }
}
