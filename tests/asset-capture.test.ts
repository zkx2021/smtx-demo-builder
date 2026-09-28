import assert from 'node:assert/strict';
import test from 'node:test';
import { startAssetCapture } from '../src/asset-capture.ts';
import type { AssetAck, AssetMessage } from '../src/asset-protocol.ts';

for (const stalledStage of ['chunk', 'final persistence'] as const) {
test(`one resource deadline includes fetch time and a stalled ${stalledStage} acknowledgement`, async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const sent: AssetMessage[] = [];
  let onMessage: (ack: AssetAck) => void = () => {};
  let onDisconnect = () => {};
  let disconnected = false;
  const port = {
    onMessage: { addListener: (listener: typeof onMessage) => { onMessage = listener; } },
    onDisconnect: { addListener: (listener: typeof onDisconnect) => { onDisconnect = listener; } },
    disconnect() { disconnected = true; onDisconnect(); },
    postMessage(message: AssetMessage) {
      sent.push(message);
      const ack = () => onMessage({ type: 'ASSET_ACK', sessionId: message.sessionId, assetId: message.assetId, stage: message.type, ok: true });
      if (message.type === 'ASSET_CHUNK') {
        // First chunk completes at 9s; the next chunk must not get another 10s.
        if (message.sequence === 0) setTimeout(ack, 3000);
        else if (stalledStage === 'final persistence') ack();
      } else if (message.type === 'ASSET_END' && stalledStage === 'final persistence') {
        // File/index acknowledgement does not get a fresh resource deadline.
      } else if (message.type !== 'ASSET_FAILED') ack();
      // Failure acknowledgement also stalls: reporting must not retain the worker.
    }
  };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: { connect: () => port } } });
  const bytes = new Uint8Array(100000);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  context.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => {
    setTimeout(() => resolve(new Response(bytes, { headers: { 'content-type': 'image/png' } })), 6000);
  }));
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  const capture = startAssetCapture('session', 'http://intranet.test/app');
  try {
    capture.observeEvent({ type: 2, timestamp: 0, data: { node: {
      type: 2, id: 1, tagName: 'img', attributes: { src: '/image.png' }, childNodes: []
    } } });
    await settle();
    context.mock.timers.tick(6000);
    await settle();
    context.mock.timers.tick(3000);
    await settle();
    assert.equal(sent.filter(message => message.type === 'ASSET_CHUNK').length, stalledStage === 'chunk' ? 2 : 3, 'Fixture must reach the intended stalled stage');
    context.mock.timers.tick(1000);
    await settle();
    const failure = sent.find(message => message.type === 'ASSET_FAILED');
    assert.ok(failure, 'A stalled transfer must report failure at the resource-wide 10-second deadline');
    assert.match(failure.reason, /timed out after 10 seconds/i);
    assert.equal(sent.some(message => message.type === 'ASSET_END'), stalledStage === 'final persistence', 'Expired chunk transfers must not reach the final persistence step');
    await capture.stop();
    assert.equal(disconnected, true, 'Stop must complete without waiting another acknowledgement deadline');
    const messageCount = sent.length;
    context.mock.timers.tick(60000);
    await settle();
    assert.equal(sent.length, messageCount, 'Expired timers must not restart the completed transfer');
  } finally {
    port.disconnect();
    await settle();
    context.mock.timers.reset();
    if (previousChrome) Object.defineProperty(globalThis, 'chrome', previousChrome);
    else Reflect.deleteProperty(globalThis, 'chrome');
  }
});
}
