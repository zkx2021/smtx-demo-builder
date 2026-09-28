export interface Rect { x: number; y: number; width: number; height: number }
export interface Viewport { width: number; height: number }
export interface ClickCandidate {
  id: string;
  time: number;
  label: string;
  rect: Rect;
  viewport: Viewport;
}
export interface DemoStep {
  id: string;
  sourceClickId?: string;
  at: number;
  title: string;
  description?: string;
  rect: Rect;
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function makeHotspot(click: ClickCandidate, title: string, firstEventTime = 0): DemoStep {
  if (click.viewport.width <= 0 || click.viewport.height <= 0) {
    throw new Error('录制时的页面尺寸无效');
  }
  const x = clamp(click.rect.x / click.viewport.width);
  const y = clamp(click.rect.y / click.viewport.height);
  return {
    id: crypto.randomUUID(),
    sourceClickId: click.id,
    at: Math.max(0, click.time - firstEventTime),
    title,
    rect: {
      x,
      y,
      width: Math.min(1 - x, clamp(click.rect.width / click.viewport.width)),
      height: Math.min(1 - y, clamp(click.rect.height / click.viewport.height))
    }
  };
}

export function containsHotspot(rect: Rect, x: number, y: number, width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  const nx = x / width;
  const ny = y / height;
  return nx >= rect.x && nx <= rect.x + rect.width && ny >= rect.y && ny <= rect.y + rect.height;
}

export function nextGate<T extends Pick<DemoStep, 'at'>>(steps: readonly T[], after: number): T | undefined {
  return [...steps].sort((a, b) => a.at - b.at).find(step => step.at > after);
}

export function sortRecordedEvents<T extends { timestamp: number }>(chunks: readonly (readonly T[])[]): T[] {
  return chunks.flat().sort((a, b) => a.timestamp - b.timestamp);
}

export function transitionSpeedAt(clickTimes: readonly number[], start: number, end: number, at: number, maxTransitionMs = 3000): number {
  if (end <= start || at < start || at >= end) return 1;
  const anchors = [...new Set(clickTimes.filter(time => time >= start && time <= end))].sort((a, b) => a - b);
  for (let index = 0; index < anchors.length - 1; index++) {
    if (at >= anchors[index] && at < anchors[index + 1]) {
      const duration = anchors[index + 1] - anchors[index];
      return duration > maxTransitionMs ? duration / maxTransitionMs : 1;
    }
  }
  return 1;
}
