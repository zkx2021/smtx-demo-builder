import assert from 'node:assert/strict';
import test from 'node:test';
import { containsHotspot, makeHotspot, nextGate, sortRecordedEvents, transitionSpeedAt } from '../src/core.ts';

test('hotspot stays aligned when recorded viewport is scaled', () => {
  const hotspot = makeHotspot({
    id: 'click-1', time: 1000, label: '新建虚拟机',
    rect: { x: 1600, y: 80, width: 200, height: 50 },
    viewport: { width: 1920, height: 1080 }
  }, '创建虚拟机');
  assert.deepEqual(hotspot.rect, { x: 5 / 6, y: 2 / 27, width: 5 / 48, height: 5 / 108 });
  assert.equal(containsHotspot(hotspot.rect, 850, 50, 960, 540), true);
  assert.equal(containsHotspot(hotspot.rect, 500, 50, 960, 540), false);
});

test('next gate skips completed steps and preserves time order', () => {
  const steps = [
    { id: 'b', at: 3000, title: '确认', rect: { x: 0, y: 0, width: 0.1, height: 0.1 } },
    { id: 'a', at: 1000, title: '新建', rect: { x: 0, y: 0, width: 0.1, height: 0.1 } }
  ];
  assert.equal(nextGate(steps, 0)?.id, 'a');
  assert.equal(nextGate(steps, 1000)?.id, 'b');
  assert.equal(nextGate(steps, 3000), undefined);
});

test('recorded events are ordered by timestamp across chunks', () => {
  const events = sortRecordedEvents([
    [{ type: 3, timestamp: 2000, data: {} }],
    [{ type: 2, timestamp: 1000, data: {} }]
  ]);
  assert.deepEqual(events.map(event => event.timestamp), [1000, 2000]);
});

test('transition speed preserves short click intervals and caps long ones at three seconds', () => {
  const clicks = [1000, 12500, 14500];
  assert.equal(transitionSpeedAt(clicks, 0, 19000, 500), 1);
  assert.equal(transitionSpeedAt(clicks, 0, 19000, 1000), 11500 / 3000);
  assert.equal(transitionSpeedAt(clicks, 0, 19000, 13000), 1);
  assert.equal(transitionSpeedAt(clicks, 0, 19000, 16000), 1);
});

test('transition speed handles no clicks and unsorted duplicate click timestamps', () => {
  assert.equal(transitionSpeedAt([], 1000, 13000, 1000), 1);
  assert.equal(transitionSpeedAt([4000, 9000], 1000, 12000, 2000), 1);
  assert.equal(transitionSpeedAt([9000, 4000, 4000], 1000, 9000, 4000), 5000 / 3000);
  assert.equal(transitionSpeedAt([9000, 4000, 4000], 1000, 9000, 9000), 1);
});

test('transition speed uses the selected one, two, or three second cap', () => {
  const clicks = [1000, 6000];
  assert.equal(transitionSpeedAt(clicks, 0, 7000, 2000, 1000), 5);
  assert.equal(transitionSpeedAt(clicks, 0, 7000, 2000, 2000), 2.5);
  assert.equal(transitionSpeedAt(clicks, 0, 7000, 2000, 3000), 5 / 3);
  assert.equal(transitionSpeedAt([1000, 2500], 0, 3000, 1200, 2000), 1);
});
