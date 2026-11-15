import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Replayer } from '@rrweb/replay';
import '@rrweb/replay/dist/style.css';
import { collectAssetReferences, recordedEventsWithBaseUrl, rewriteRecordedEvents } from '../../src/asset-refs.ts';
import { transitionSpeedAt } from '../../src/core.ts';
import type { RecordedEvent } from '../../src/model.ts';
import { request } from './api';
import type { DemoRecord, Playback } from './api';

function prepareEvents(id: string, playback: Playback): RecordedEvent[] {
  const replacements = new Map<string, string>();
  const tags = new Map<number, string>();
  const recorded = playback.events as RecordedEvent[];
  // Missing resources receive inert data URLs so replay does not fetch the original platform.
  for (const { event, pageUrl } of recordedEventsWithBaseUrl(recorded, playback.manifest.sourceUrl)) {
    for (const ref of collectAssetReferences(event, pageUrl, tags)) {
      replacements.set(ref.url, ref.context === 'css' || ref.context === 'stylesheet' ? 'data:text/css,' : 'data:image/gif;base64,R0lGODlhAQABAAAAACw=');
    }
  }
  for (const entry of playback.assets?.entries ?? []) {
    if (entry.status === 'saved' && entry.filename) {
      const fragment = entry.mime === 'image/svg+xml' ? new URL(entry.url, playback.manifest.sourceUrl).hash : '';
      replacements.set(entry.url, `/api/demos/${encodeURIComponent(id)}/assets/${encodeURIComponent(entry.filename)}${fragment}`);
    }
  }
  return rewriteRecordedEvents(recorded, replacements, playback.manifest.sourceUrl);
}

export function Player({ id, go }: { id: string; go: (path: string) => void }) {
  const [data, setData] = useState<Playback | null>(null), [record, setRecord] = useState<DemoRecord | null>(null), [error, setError] = useState('');
  const [waiting, setWaiting] = useState(false), [gateIndex, setGateIndex] = useState(0), [hint, setHint] = useState('');
  const [limit, setLimit] = useState<number | null>(null), [scale, setScale] = useState(1), [finished, setFinished] = useState(false);
  const mountRef = useRef<HTMLDivElement>(null), stageRef = useRef<HTMLDivElement>(null), fullRef = useRef<HTMLDivElement>(null);
  const replayerRef = useRef<Replayer | null>(null), appliedSpeedRef = useRef<number | null>(null);
  useEffect(() => { let active = true; request<Playback>(`/api/demos/${encodeURIComponent(id)}/playback`).then(result => { if (active) setData(result); }, cause => { if (active) setError(cause instanceof Error ? cause.message : '无法加载演示。'); }); return () => { active = false; }; }, [id]);
  useEffect(() => { let active = true; request<DemoRecord[]>('/api/demos').then(records => { if (active) setRecord(records.find(item => item.id === id) ?? null); }, () => {}); return () => { active = false; }; }, [id]);
  const events = useMemo(() => data ? prepareEvents(id, data) : [], [id, data]);
  const steps = useMemo(() => [...(data?.steps ?? [])].sort((a, b) => a.at - b.at), [data]);
  const start = data?.events[0]?.timestamp ?? 0;
  const duration = Math.max(0, (data?.events.at(-1)?.timestamp ?? start) - start);
  const clicks = useMemo(() => data?.manifest.clicks.map(click => click.time - start) ?? [], [data, start]);
  const viewport = data?.manifest.viewport ?? { width: 1280, height: 720 };
  const gate = waiting ? steps[gateIndex] : null;
  const hasMissingResources = record?.assetStatus === 'partial' || record?.assetStatus === 'legacy' || (data?.manifest.formatVersion === 2 && data.assets === null) || (data?.assets?.entries.some(entry => entry.status !== 'saved') ?? false);

  const applySpeed = useCallback((replayer: Replayer, at: number) => {
    const speed = limit === null ? 1 : transitionSpeedAt(clicks, 0, duration, at, limit);
    if (speed !== appliedSpeedRef.current) { replayer.setConfig({ speed }); appliedSpeedRef.current = speed; }
  }, [limit, clicks, duration]);

  useEffect(() => {
    if (!data || !mountRef.current || events.length < 2) return;
    const mount = mountRef.current;
    mount.replaceChildren();
    const replayer = new Replayer(events as ConstructorParameters<typeof Replayer>[0], { root: mount, showWarning: false, mouseTail: false, UNSAFE_replayCanvas: false });
    replayerRef.current = replayer;
    appliedSpeedRef.current = null;
    applySpeed(replayer, 0);
    if (steps[0]?.at === 0) { replayer.pause(0); setWaiting(true); }
    else replayer.play(0);
    return () => { replayer.destroy(); if (replayerRef.current === replayer) replayerRef.current = null; mount.replaceChildren(); };
  }, [data, events, steps]); // Playback data only changes when opening a new demo.

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const resize = () => setScale(Math.min(stage.clientWidth / viewport.width, stage.clientHeight / viewport.height));
    const observer = new ResizeObserver(resize);
    observer.observe(stage); resize();
    return () => observer.disconnect();
  }, [viewport.width, viewport.height, data]);

  useEffect(() => {
    if (!data) return;
    let frame = 0;
    const tick = () => {
      const replayer = replayerRef.current;
      if (replayer && !waiting && !finished) {
        const at = replayer.getCurrentTime();
        const next = steps[gateIndex];
        if (next && at >= next.at) { replayer.pause(next.at); setWaiting(true); }
        else if (!next && at >= duration) { setFinished(true); }
        else applySpeed(replayer, at);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [data, steps, gateIndex, waiting, finished, duration, applySpeed]);

  function continueReplay() {
    const replayer = replayerRef.current;
    const at = (gate?.at ?? 0) + 1;
    setHint(''); setGateIndex(index => index + 1); setWaiting(false);
    if (replayer) { applySpeed(replayer, at); replayer.play(at); }
  }
  function restart() {
    const replayer = replayerRef.current;
    setGateIndex(0); setWaiting(false); setHint(''); setFinished(false);
    if (replayer) { applySpeed(replayer, 0); if (steps[0]?.at === 0) { replayer.pause(0); setWaiting(true); } else replayer.play(0); }
  }
  const currentNumber = Math.min(gateIndex + 1, steps.length);
  return <div className="player-page" ref={fullRef}><header className="player-header"><button className="player-back" onClick={() => go('/demos')}>← <span>返回素材库</span></button><div className="player-name">{data?.manifest.title ?? '互动演示'}</div><div className="player-progress">{data && <><span>{finished ? '播放完成' : `步骤 ${currentNumber} / ${steps.length}${steps[gateIndex] ? ` · ${steps[gateIndex].title}` : ''}`}</span><span className={`player-pill ${waiting ? 'waiting' : ''}`}>{waiting ? '◯ 等待点击热点' : finished ? '✓ 已完成' : '▶ 正在播放'}</span></>}</div><div className="player-controls"><label>过渡加速：<select aria-label="过渡加速" value={limit ?? 'off'} onChange={e => setLimit(e.target.value === 'off' ? null : Number(e.target.value))}><option value="off">关闭</option><option value="1000">1 秒</option><option value="2000">2 秒</option><option value="3000">3 秒</option></select></label><button onClick={restart}>⟳ 从头播放</button><button onClick={() => fullRef.current?.requestFullscreen()}>⛶ 全屏</button></div></header>
    {hasMissingResources && <div className="player-warning">该演示的部分资源可能不完整，画面显示以实际回放为准。</div>}
    <div className="player-stage" ref={stageRef}>{!data && <div className="player-loading">{error || '正在加载演示…'}{error && <button onClick={() => go('/demos')}>返回素材库</button>}</div>}{data && events.length < 2 && <div className="player-loading">该演示没有可回放的事件。</div>}{data && <div className="player-frame" style={{ width: viewport.width, height: viewport.height, transform: `translate(-50%, -50%) scale(${scale})` }}><div className="rrweb-mount" ref={mountRef} />{gate && <div className="interaction-layer" onClick={() => setHint(`请点击高亮的“${gate.title}”`)}><button type="button" className="hotspot" aria-label={`点击热点：${gate.title}`} style={{ left: `${gate.rect.x * 100}%`, top: `${gate.rect.y * 100}%`, width: `${Math.max(gate.rect.width * 100, 1.5)}%`, height: `${Math.max(gate.rect.height * 100, 1.5)}%` }} onClick={event => { event.stopPropagation(); continueReplay(); }}><span className="hotspot-circle" /></button></div>}</div>}{gate && <div className="guide-card"><span className="guide-step">步骤 {currentNumber} / {steps.length}</span><h2>{gate.title}</h2><p>{gate.description || '点击高亮区域继续'}</p><small>{hint || '点击其他位置不会进入下一步'}</small></div>}{finished && <div className="finished-card"><h2>演示已完成</h2><button onClick={restart}>从头播放</button></div>}</div>
  </div>;
}
