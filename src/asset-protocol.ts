import type { AssetReference } from './asset-refs.ts';
import { MAX_ASSET_BYTES } from './asset-store.ts';
import { recordAssetCandidate, recordAssetFailure, saveCapturedAsset } from './storage.ts';
import type { ActiveSession } from './model.ts';

export const ASSET_PORT = 'ASSET_CAPTURE';
export const ASSET_CHUNK_BYTES = 48 * 1024;
export const CAPTURE_CONCURRENCY = 4;
type Envelope = { sessionId: string; assetId: string };
export type AssetMessage = Envelope & (
  | { type: 'ASSET_DISCOVERED'; reference: AssetReference }
  | { type: 'ASSET_BEGIN'; mime: string; bytes: number; deadline: number }
  | { type: 'ASSET_CHUNK'; sequence: number; base64: string }
  | { type: 'ASSET_END' }
  | { type: 'ASSET_FAILED'; reason: string }
);
export type AssetAck = Envelope & { type: 'ASSET_ACK'; stage: AssetMessage['type']; ok: boolean; reason?: string };

type IncomingAsset = { reference: AssetReference; mime?: string; bytes?: Uint8Array; offset: number; sequence: number; finished: boolean; deadline?: number; cancellation: AbortController };

// All messages, including disconnect cleanup, join the panel's event-write queue.
export function receiveAssetPort(
  port: chrome.runtime.Port, session: ActiveSession, root: FileSystemDirectoryHandle,
  enqueue: (operation: () => Promise<void>) => void
): void {
  const assets = new Map<string, IncomingAsset>();
  let connected = true;
  let receiving = 0;
  function ack(message: AssetMessage, ok: boolean, reason?: string) {
    if (!connected) return;
    const response: AssetAck = { type: 'ASSET_ACK', sessionId: session.sessionId, assetId: message.assetId, stage: message.type, ok, reason };
    try { port.postMessage(response); } catch { /* Disconnect cleanup retains pending entries. */ }
  }
  function release(asset: IncomingAsset) {
    if (asset.bytes) receiving--;
    asset.bytes = undefined;
    asset.finished = true;
  }
  port.onMessage.addListener((value: unknown) => {
    if (!value || typeof value !== 'object') { port.disconnect(); return; }
    const message = value as AssetMessage;
    if (message.sessionId !== session.sessionId || typeof message.assetId !== 'string' || message.assetId.length > 128 || !message.assetId) {
      port.disconnect(); return;
    }
    // Do not queue cancellation behind an END that is waiting on the filesystem.
    if (message.type === 'ASSET_FAILED') assets.get(message.assetId)?.cancellation.abort(new Error(
      typeof message.reason === 'string' ? message.reason.slice(0, 256) : 'Asset capture failed'
    ));
    enqueue(async () => {
      let asset = assets.get(message.assetId);
      try {
        if (message.type === 'ASSET_DISCOVERED') {
          const ref = message.reference;
          if (asset || !ref || typeof ref.url !== 'string' || ref.url.length > 32768 || !['img', 'srcset', 'svg', 'css', 'stylesheet'].includes(ref.context) || !Number.isFinite(ref.firstSeenAt)) throw new Error('Invalid asset discovery');
          const url = new URL(ref.url);
          if (!['http:', 'https:', 'blob:'].includes(url.protocol)) throw new Error('Unsupported asset URL');
          asset = { reference: ref, offset: 0, sequence: 0, finished: false, cancellation: new AbortController() };
          assets.set(message.assetId, asset);
          await recordAssetCandidate(root, session.demoId, ref);
        } else {
          if (!asset || asset.finished) throw new Error('Asset transfer is not pending');
          if (message.type === 'ASSET_FAILED') {
            await recordAssetFailure(root, session.demoId, { ...asset.reference, reason: typeof message.reason === 'string' ? message.reason.slice(0, 256) : 'Asset capture failed' });
            release(asset);
          } else {
            if (new URL(asset.reference.url).origin !== session.origin) throw new Error('Cross-origin resource is not captured');
            if (asset.reference.context === 'stylesheet') throw new Error('External stylesheet was not safely inlined');
            if (message.type === 'ASSET_BEGIN') {
              if (!Number.isFinite(message.deadline) || message.deadline > Date.now() + 10000) throw new Error('Invalid asset deadline');
              if (message.deadline <= Date.now()) throw new Error('Asset capture timed out after 10 seconds');
              if (asset.bytes || receiving >= CAPTURE_CONCURRENCY || !Number.isInteger(message.bytes) || message.bytes <= 0 || message.bytes > MAX_ASSET_BYTES || typeof message.mime !== 'string' || message.mime.length > 128) throw new Error('Invalid or oversized asset transfer');
              asset.bytes = new Uint8Array(message.bytes);
              asset.mime = message.mime;
              asset.deadline = message.deadline;
              receiving++;
            } else if (message.type === 'ASSET_CHUNK') {
              if (!asset.bytes || message.sequence !== asset.sequence || typeof message.base64 !== 'string' || message.base64.length > ASSET_CHUNK_BYTES / 3 * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.base64)) throw new Error('Invalid asset chunk');
              const decoded = atob(message.base64);
              if (!decoded.length || asset.offset + decoded.length > asset.bytes.length) throw new Error('Asset chunk exceeds declared bytes');
              for (let index = 0; index < decoded.length; index++) asset.bytes[asset.offset + index] = decoded.charCodeAt(index);
              asset.offset += decoded.length;
              asset.sequence++;
            } else if (message.type === 'ASSET_END') {
              if (!asset.bytes || asset.offset !== asset.bytes.length || !asset.mime) throw new Error('Incomplete asset transfer');
              // Extension pages always have SubtleCrypto, including captures of HTTP intranets.
              const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', asset.bytes as BufferSource)), byte => byte.toString(16).padStart(2, '0')).join('');
              const index = await saveCapturedAsset(root, session.demoId, { url: asset.reference.url, mime: asset.mime, sha256, bytes: asset.bytes,
                deadline: asset.deadline, signal: asset.cancellation.signal });
              const entry = index.entries.find(entry => entry.url === asset!.reference.url);
              if (entry?.status !== 'saved') throw new Error(entry?.reason ?? 'Asset file was not saved');
              release(asset);
            } else throw new Error('Unknown asset message');
          }
        }
        ack(message, true);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Asset storage failed';
        if (asset && !asset.finished) {
          release(asset);
          try { await recordAssetFailure(root, session.demoId, { ...asset.reference, reason }); } catch { /* Pending index survives for finishDemo. */ }
        }
        ack(message, false, reason);
      }
    });
  });
  port.onDisconnect.addListener(() => {
    connected = false;
    for (const asset of assets.values()) if (!asset.finished) asset.cancellation.abort(new Error('Asset capture disconnected before completion'));
    enqueue(async () => {
      for (const asset of assets.values()) {
        if (!asset.finished) {
          release(asset);
          await recordAssetFailure(root, session.demoId, { ...asset.reference, reason: 'Asset capture disconnected before completion' });
        }
      }
      assets.clear();
    });
  });
}
