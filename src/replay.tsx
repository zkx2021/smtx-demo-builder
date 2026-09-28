import { useEffect, useRef, useState } from 'react';
import { Replayer } from '@rrweb/replay';
import '@rrweb/replay/dist/style.css';
import type { DemoStep } from './core.ts';
import type { LoadedDemo } from './model.ts';
import { prepareReplayAssets } from './asset-replay.ts';
import type { ReplayAssets } from './asset-replay.ts';

interface ReplayCanvasProps {
  root: FileSystemDirectoryHandle;
  demo: LoadedDemo;
  preloadThroughAt?: number;
  onAssetIssues?: (issues: ReplayAssets['issues']) => void;
  replayerRef: React.MutableRefObject<Replayer | null>;
  gate?: DemoStep | null;
  onGateClick?: () => void;
  onWrongClick?: () => void;
  onReady?: (replayer: Replayer) => void;
}

export function ReplayCanvas({ root, demo, preloadThroughAt = 0, onAssetIssues, replayerRef, gate, onGateClick, onWrongClick, onReady }: ReplayCanvasProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);
  const issuesRef = useRef(onAssetIssues);
  const assetsRef = useRef<ReplayAssets | null>(null);
  const preloadAtRef = useRef(preloadThroughAt);
  const [assetError, setAssetError] = useState('');
  const [scale, setScale] = useState(1);
  const viewport = demo.manifest.viewport ?? { width: 1280, height: 720 };
  onReadyRef.current = onReady;
  issuesRef.current = onAssetIssues;
  preloadAtRef.current = preloadThroughAt;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const resize = () => setScale(Math.min(stage.clientWidth / viewport.width, stage.clientHeight / viewport.height));
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    resize();
    return () => observer.disconnect();
  }, [viewport.width, viewport.height]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || demo.events.length < 2) return;
    mount.replaceChildren();
    setAssetError('');
    let cancelled = false;
    let prepared: ReplayAssets | null = null;
    let replayer: Replayer | null = null;
    void (async () => {
      prepared = await prepareReplayAssets(root, demo);
      if (cancelled) { prepared.release(); return; }
      assetsRef.current = prepared;
      await prepared.preloadThrough(0);
      if (cancelled) return;
      issuesRef.current?.([...prepared.issues]);
      replayer = new Replayer(prepared.events as unknown as ConstructorParameters<typeof Replayer>[0], {
        root: mount, showWarning: false, mouseTail: false, UNSAFE_replayCanvas: false
      });
      replayerRef.current = replayer;
      onReadyRef.current?.(replayer);
      await prepared.preloadThrough(preloadAtRef.current);
      if (!cancelled) issuesRef.current?.([...prepared.issues]);
    })().catch(() => {
      prepared?.release();
      if (!cancelled) setAssetError('无法准备本地回放资源，请重新打开演示。');
    });
    return () => {
      cancelled = true;
      replayer?.destroy();
      prepared?.release();
      assetsRef.current = null;
      replayerRef.current = null;
      mount.replaceChildren();
    };
  }, [root, demo.events, demo.assets, demo.manifest.id, replayerRef]);

  useEffect(() => {
    const prepared = assetsRef.current;
    if (!prepared) return;
    let cancelled = false;
    void prepared.preloadThrough(preloadThroughAt).then(() => {
      if (!cancelled && assetsRef.current === prepared) issuesRef.current?.([...prepared.issues]);
    });
    return () => { cancelled = true; };
  }, [preloadThroughAt]);

  return <div className="replay-stage" ref={stageRef}>
    {assetError && <div className="empty-replay" role="status">{assetError}</div>}
    {demo.events.length < 2 && <div className="empty-replay">该演示暂无可回放内容。</div>}
    <div className="replay-frame" style={{ width: viewport.width, height: viewport.height, transform: `translate(-50%, -50%) scale(${scale})` }}>
      <div ref={mountRef} className="rrweb-mount" />
      {gate && <div className="interaction-layer" onClick={onWrongClick}>
        <button className="hotspot" type="button" aria-label={`点击热点：${gate.title}`}
          style={{ left: `${gate.rect.x * 100}%`, top: `${gate.rect.y * 100}%`, width: `${Math.max(gate.rect.width * 100, 1.5)}%`, height: `${Math.max(gate.rect.height * 100, 1.5)}%` }}
          onClick={event => { event.stopPropagation(); onGateClick?.(); }}>
          <span>{gate.title}</span>
        </button>
      </div>}
    </div>
  </div>;
}
