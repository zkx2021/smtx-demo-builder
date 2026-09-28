import type { AssetIndex, AssetSummary } from './model.ts';

export const MAX_ASSET_BYTES = 10 * 1024 * 1024;
export const MAX_DEMO_ASSET_BYTES = 200 * 1024 * 1024;

type ValidAsset = { mime: string; extension: string };
type InvalidAsset = { reason: string };

function hasPrefix(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function isStaticSvgDeclarations(css: string, inline: boolean): boolean {
  const declarations = css.split(';').map(part => part.trim()).filter(Boolean);
  if (!declarations.length) return false;
  for (const declaration of declarations) {
    const match = /^([a-z-]+)\s*:\s*(.+)$/i.exec(declaration);
    if (!match) return false;
    const property = match[1].toLowerCase();
    const value = match[2].trim();
    if (property === 'fill' || property === 'stroke') {
      if (!/^(?:none|#[\da-f]{3,4}(?:[\da-f]{3,4})?|url\(\s*#[A-Za-z_][\w:.-]*\s*\))$/i.test(value)) return false;
    } else if (property === 'stroke-width' || property === 'stroke-miterlimit') {
      if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return false;
    } else if (property === 'stroke-linecap') {
      if (!/^(?:butt|round|square)$/i.test(value)) return false;
    } else if (property === 'stroke-linejoin') {
      if (!/^(?:miter|round|bevel)$/i.test(value)) return false;
    } else if (inline && property === 'stop-color') {
      if (!/^#[\da-f]{3,4}(?:[\da-f]{3,4})?$/i.test(value)) return false;
    } else if (inline && property === 'stop-opacity') {
      if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) return false;
    } else if (inline && property === 'enable-background') {
      if (!/^new(?:\s+\d+(?:\.\d+)?){4}$/.test(value)) return false;
    } else return false;
  }
  return true;
}

function isStaticSvgCss(css: string): boolean {
  let remaining = css;
  let rules = 0;
  while (remaining.trim()) {
    const rule = /^\s*\.[A-Za-z_][\w-]*\s*\{([^{}]*)\}/.exec(remaining);
    if (!rule || !isStaticSvgDeclarations(rule[1], false)) return false;
    rules++;
    remaining = remaining.slice(rule[0].length);
  }
  return rules > 0;
}

function isSafeSvg(bytes: Uint8Array): boolean {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    .replace(/^\uFEFF?\s*/, '')
    .replace(/^<\?xml\s[^>]*\?>\s*/i, '')
    .replace(/^(?:<!--[\s\S]*?-->\s*)*/, '');
  if (!/^<svg(?:\s|>)/i.test(source)) return false;
  if (!/<\/svg\s*>\s*$/i.test(source) && !/^<svg\b[^>]*\/\s*>$/i.test(source)) return false;
  // XML entities and CSS escapes can conceal external URLs from the checks below.
  if (source.includes('&') || source.includes('\\') || /\bxml:base\s*=/i.test(source)) return false;
  let unsafeStyle = false;
  let styleBlocks = 0;
  const withoutStyles = source.replace(/<style(?:\s+type\s*=\s*(?:"text\/css"|'text\/css'))?\s*>([\s\S]*?)<\/style\s*>/gi, (_, css: string) => {
    styleBlocks++;
    if (!isStaticSvgCss(css)) unsafeStyle = true;
    return '';
  });
  if (unsafeStyle || styleBlocks > 1 || /<\s*\/?\s*(?:[^\s<>/:]+:)?style\b/i.test(withoutStyles)) return false;
  let unsafeInlineStyle = false;
  const withoutInlineStyles = source.replace(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi, (_, _quote: string, css: string) => {
    if (!isStaticSvgDeclarations(css, true)) unsafeInlineStyle = true;
    return '';
  });
  if (unsafeInlineStyle || /\sstyle\s*=/i.test(withoutInlineStyles)) return false;
  if (/<\s*(?:[^\s<>/:]+:)?(?:script|foreignObject|iframe|object|embed|html|animate(?:Motion|Transform)?|set|discard)\b|<!\s*(?:DOCTYPE|ENTITY)|\bon[a-z]+\s*=|javascript\s*:|<\?php\b|<\?xml-stylesheet\b/i.test(source)) return false;
  const withoutLocalHrefs = source.replace(/\b(?:xlink:)?href\s*=\s*(["'])#[A-Za-z_][\w:.-]*\1/gi, '');
  if (/\b(?:xlink:)?href\s*=/i.test(withoutLocalHrefs)) return false;
  const withoutLocalUrls = source.replace(/\burl\(\s*(["']?)#[A-Za-z_][\w:.-]*\1\s*\)/gi, '');
  return !/\burl\s*\(/i.test(withoutLocalUrls);
}

const knownExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'woff', 'woff2', 'ttf', 'otf']);
const storedExtensions: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/bmp': 'bmp', 'image/x-icon': 'ico', 'image/svg+xml': 'svg',
  'font/woff': 'woff', 'font/woff2': 'woff2', 'font/ttf': 'ttf', 'font/otf': 'otf'
};

export function isAssetIndex(value: unknown): value is AssetIndex {
  if (!value || typeof value !== 'object') return false;
  const index = value as Record<string, unknown>;
  if (index.version !== 1 || !Array.isArray(index.entries)) return false;
  return index.entries.every(raw => {
    if (!raw || typeof raw !== 'object') return false;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.url !== 'string' || typeof entry.context !== 'string' || typeof entry.status !== 'string') return false;
    if (!['img', 'srcset', 'svg', 'css', 'stylesheet'].includes(entry.context)) return false;
    if (!['pending', 'saved', 'failed'].includes(entry.status)) return false;
    try {
      const url = new URL(entry.url);
      if (!['http:', 'https:', 'blob:'].includes(url.protocol)) return false;
      if (url.protocol === 'blob:') {
        if (url.pathname.startsWith('null/')) {
          if (entry.status === 'saved' || url.pathname.length <= 'null/'.length) return false;
        } else {
          const embedded = new URL(url.pathname);
          if (!['http:', 'https:'].includes(embedded.protocol) || embedded.pathname === '/') return false;
        }
      }
    } catch { return false; }
    if (entry.reason !== undefined && typeof entry.reason !== 'string') return false;
    if (entry.mime !== undefined && (typeof entry.mime !== 'string' || !storedExtensions[entry.mime])) return false;
    if (entry.bytes !== undefined && (!Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0 || (entry.bytes as number) > MAX_ASSET_BYTES)) return false;
    if (entry.filename !== undefined && (typeof entry.filename !== 'string' || !/^[a-f0-9]{64}\.[a-z0-9]+$/.test(entry.filename))) return false;
    if (entry.status === 'saved') {
      if (typeof entry.mime !== 'string' || typeof entry.filename !== 'string' || !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) <= 0) return false;
      if (!entry.filename.endsWith(`.${storedExtensions[entry.mime]}`)) return false;
    }
    return true;
  });
}

export function validateAssetResponse(url: string, mime: string, bytes: Uint8Array): ValidAsset | InvalidAsset {
  if (bytes.byteLength > MAX_ASSET_BYTES) return { reason: 'Resource exceeds 10 MB' };
  if (bytes.byteLength === 0) return { reason: 'Empty asset response' };
  const normalized = mime.split(';', 1)[0].trim().toLowerCase();
  let result: ValidAsset | null = null;
  try {
    switch (normalized) {
      case 'image/png':
        if (hasPrefix(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) result = { mime: normalized, extension: 'png' };
        break;
      case 'image/jpeg':
        if (hasPrefix(bytes, [255, 216, 255])) result = { mime: normalized, extension: 'jpg' };
        break;
      case 'image/gif':
        if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') result = { mime: normalized, extension: 'gif' };
        break;
      case 'image/webp':
        if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') result = { mime: normalized, extension: 'webp' };
        break;
      case 'image/avif':
        if (ascii(bytes, 4, 4) === 'ftyp' && ['avif', 'avis'].includes(ascii(bytes, 8, 4))) result = { mime: normalized, extension: 'avif' };
        break;
      case 'image/bmp':
        if (ascii(bytes, 0, 2) === 'BM') result = { mime: normalized, extension: 'bmp' };
        break;
      case 'image/x-icon': case 'image/vnd.microsoft.icon':
        if (hasPrefix(bytes, [0, 0, 1, 0])) result = { mime: 'image/x-icon', extension: 'ico' };
        break;
      case 'image/svg+xml':
        if (isSafeSvg(bytes)) result = { mime: normalized, extension: 'svg' };
        break;
      case 'font/woff': case 'application/font-woff':
        if (ascii(bytes, 0, 4) === 'wOFF') result = { mime: 'font/woff', extension: 'woff' };
        break;
      case 'font/woff2':
        if (ascii(bytes, 0, 4) === 'wOF2') result = { mime: normalized, extension: 'woff2' };
        break;
      case 'font/ttf': case 'application/x-font-ttf':
        if (hasPrefix(bytes, [0, 1, 0, 0]) || ascii(bytes, 0, 4) === 'true') result = { mime: 'font/ttf', extension: 'ttf' };
        break;
      case 'font/otf': case 'application/x-font-opentype':
        if (ascii(bytes, 0, 4) === 'OTTO') result = { mime: 'font/otf', extension: 'otf' };
        break;
    }
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  if (!result) return { reason: 'Unsupported or mismatched asset bytes' };
  let extension = '';
  try { extension = new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() ?? ''; }
  catch { return { reason: 'Invalid asset URL' }; }
  if (extension && knownExtensions.has(extension) && extension !== result.extension && !(extension === 'jpeg' && result.extension === 'jpg')) {
    return { reason: 'Asset URL extension does not match response type' };
  }
  return result;
}

export function summarizeAssetIndex(index: AssetIndex): AssetSummary {
  const saved = index.entries.filter(entry => entry.status === 'saved');
  const failed = index.entries.filter(entry => entry.status === 'failed').length;
  const unique = new Map<string, number>();
  for (const entry of saved) if (entry.filename) unique.set(entry.filename, entry.bytes ?? 0);
  const discovered = index.entries.length;
  return {
    discovered, saved: saved.length, failed,
    uniqueBytes: [...unique.values()].reduce((total, size) => total + size, 0),
    status: discovered === 0 ? 'no-candidates' : saved.length === discovered ? 'complete' : 'partial'
  };
}
