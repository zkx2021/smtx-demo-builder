import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Replayer } from '@rrweb/replay';
import { makeHotspot, transitionSpeedAt } from './core.ts';
import type { ClickCandidate, DemoStep } from './core.ts';
import type { ActiveSession, AssetIndex, DemoManifest, EventBatch, LoadedDemo } from './model.ts';
import { createDemo, deleteDemo, finishDemo, hasWritePermission, listDemos, loadDemo, loadRootHandle, requestWritePermission, saveRootHandle, saveSteps, writeBatch } from './storage.ts';
import { ReplayCanvas } from './replay.tsx';
import { ASSET_PORT, receiveAssetPort } from './asset-protocol.ts';
import { AssetCoverage } from './asset-coverage.tsx';
import type { AssetIssue } from './asset-coverage.tsx';
import { isAssetIndex } from './asset-store.ts';
import { prepareDemoPackage, suggestedDemoPackageName, writeDemoPackage } from './demo-package.ts';
import './styles.css';

const SCRIPT_ID = 'hci-local-demo-recorder';

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function chooseFolder(): Promise<FileSystemDirectoryHandle> {
  if (!('showDirectoryPicker' in window)) throw new Error('当前浏览器不支持本地目录访问，请使用支持此功能的 Chrome 或 Edge 版本');
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await saveRootHandle(handle);
  return handle;
}

function openPage(view: 'editor' | 'player', id: string): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL(`index.html?view=${view}&id=${encodeURIComponent(id)}`) });
}

async function readCoverage(root: FileSystemDirectoryHandle, manifest: DemoManifest): Promise<{ assets: AssetIndex | null; issues: AssetIssue[] }> {
  if (manifest.formatVersion === 1) return { assets: null, issues: [] };
  try {
    const demo = await (await root.getDirectoryHandle('demos')).getDirectoryHandle(manifest.id);
    const folder = await demo.getDirectoryHandle('assets');
    const assets: unknown = JSON.parse(await (await folder.getFileHandle('index.json')).getFile().then(file => file.text()));
    if (!isAssetIndex(assets)) throw new Error('Invalid asset index');
    const issues: AssetIssue[] = [];
    const available = new Map<string, boolean>();
    for (const entry of assets.entries) {
      if (entry.status !== 'saved') continue;
      const filename = entry.filename ?? '';
      if (!available.has(filename)) {
        try { await (await folder.getFileHandle(filename)).getFile(); available.set(filename, true); }
        catch { available.set(filename, false); }
      }
      if (!available.get(filename)) issues.push({ url: entry.url, reason: 'Saved asset file is missing or unreadable' });
    }
    return { assets, issues };
  } catch {
    return { assets: null, issues: [{ url: manifest.sourceUrl, reason: 'Saved asset index is missing or unreadable' }] };
  }
}

function SidePanel() {
  const [root, setRoot] = useState<FileSystemDirectoryHandle | null>(null);
  const [demos, setDemos] = useState<DemoManifest[]>([]);
  const [coverages, setCoverages] = useState<Record<string, { assets: AssetIndex | null; issues: AssetIssue[] }>>({});
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [title, setTitle] = useState('新建演示');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [savingInterrupted, setSavingInterrupted] = useState(false);
  const [notice, setNotice] = useState('');
  const rootRef = useRef<FileSystemDirectoryHandle | null>(null);
  const targetTabRef = useRef<number | null>(null);
  const manifestRef = useRef<DemoManifest | null>(null);
  const sessionRef = useRef<ActiveSession | null>(null);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const assetPorts = useRef(new Set<chrome.runtime.Port>());
  const stopDrain = useRef<Promise<{ manifest: DemoManifest; flushed: boolean }> | null>(null);

  const refresh = useCallback(async (handle: FileSystemDirectoryHandle) => {
    if (await hasWritePermission(handle)) {
      const listed = await listDemos(handle);
      const coverage = await Promise.all(listed.map(demo => readCoverage(handle, demo)));
      setDemos(listed);
      setCoverages(Object.fromEntries(listed.map((demo, index) => [demo.id, coverage[index]])));
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const handle = await loadRootHandle();
        if (!mounted || !handle) return;
        rootRef.current = handle;
        setRoot(handle);
        if (await hasWritePermission(handle)) {
          await refresh(handle);
          const { activeSession, recordingError } = await chrome.storage.local.get(['activeSession', 'recordingError']);
          if (recordingError) {
            setNotice(String(recordingError));
            setSavingInterrupted(String(recordingError).startsWith('保存已中断'));
          }
          if (activeSession) {
            const session = activeSession as ActiveSession;
            manifestRef.current = (await loadDemo(handle, session.demoId)).manifest;
            sessionRef.current = session;
            setActive(session);
          }
        }
      } catch (error) { if (mounted) setNotice(`读取演示素材库失败：${errorText(error)}`); }
    })();
    return () => { mounted = false; };
  }, [refresh]);

  useEffect(() => {
    const onConnect = (port: chrome.runtime.Port) => {
      if (port.name !== ASSET_PORT) return;
      const session = sessionRef.current;
      const handle = rootRef.current;
      let origin = '';
      try { origin = new URL(port.sender?.url ?? '').origin; } catch { /* Reject senders without a page origin. */ }
      if (!session || !handle || port.sender?.tab?.id !== session.tabId || port.sender.frameId !== 0 || origin !== session.origin) {
        port.disconnect(); return;
      }
      assetPorts.current.add(port);
      port.onDisconnect.addListener(() => assetPorts.current.delete(port));
      receiveAssetPort(port, session, handle, operation => {
        writeQueue.current = writeQueue.current.then(operation).catch(error => {
          setNotice(`保存离线资源失败：${errorText(error)}`);
        });
      });
    };
    chrome.runtime.onConnect.addListener(onConnect);
    return () => {
      chrome.runtime.onConnect.removeListener(onConnect);
      for (const port of assetPorts.current) port.disconnect();
      assetPorts.current.clear();
    };
  }, []);

  useEffect(() => {
    const listener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
      if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'EVENT_BATCH') return;
      const batch = message as EventBatch;
      const session = sessionRef.current;
      if (!session || batch.sessionId !== session.sessionId || sender.tab?.id !== session.tabId) {
        sendResponse({ ok: false, error: '录制会话已失效，请重新开始录制' });
        return;
      }
      writeQueue.current = writeQueue.current.then(async () => {
        const handle = rootRef.current;
        const manifest = manifestRef.current;
        if (!handle || !manifest) throw new Error('演示素材库不可用，请重新授权目录');
        manifestRef.current = await writeBatch(handle, manifest, batch);
      });
      void writeQueue.current.then(() => sendResponse({ ok: true })).catch(error => {
        setNotice(`保存录制数据失败：${errorText(error)}`);
        sendResponse({ ok: false, error: errorText(error) });
        writeQueue.current = Promise.resolve();
      });
      return true;
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  async function selectFolder() {
    if (active) return;
    try {
      const handle = await chooseFolder();
      rootRef.current = handle;
      setRoot(handle);
      await refresh(handle);
      setNotice(`素材库：${handle.name}`);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setNotice(errorText(error));
    }
  }

  async function authorizeFolder() {
    if (!root) return;
    try {
      if (!(await requestWritePermission(root))) throw new Error('未获得素材库目录的写入权限');
      await refresh(root);
      const { activeSession } = await chrome.storage.local.get('activeSession');
      if (activeSession) {
        const session = activeSession as ActiveSession;
        manifestRef.current = (await loadDemo(root, session.demoId)).manifest;
        sessionRef.current = session;
        setActive(session);
      }
      setNotice(`素材库：${root.name}`);
    } catch (error) { setNotice(errorText(error)); }
  }

  async function openAddress() {
    try {
      const url = new URL(address.trim());
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('请输入有效的 HTTP 或 HTTPS 页面地址');
      const tab = await chrome.tabs.create({ url: url.href });
      targetTabRef.current = tab.id ?? null;
    } catch (error) { setNotice(errorText(error)); }
  }

  async function startRecording() {
    if (!root || busy) return;
    setBusy(true);
    setSavingInterrupted(false);
    setNotice('');
    let created: DemoManifest | null = null;
    try {
      const { activeSession } = await chrome.storage.local.get('activeSession');
      if (activeSession) throw new Error('已有录制任务正在进行，请先结束并保存');
      if (!(await hasWritePermission(root)) && !(await requestWritePermission(root))) throw new Error('请先授予素材库目录的写入权限');
      const remembered = targetTabRef.current ? await chrome.tabs.get(targetTabRef.current).catch(() => null) : null;
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = remembered ?? activeTab;
      if (!tab?.id || !tab.url) throw new Error('未找到目标页面，请先打开要录制的页面');
      const url = new URL(tab.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持录制 HTTP 或 HTTPS 页面');
      const match = `${url.protocol}//${url.hostname}/*`;
      const permitted = await chrome.permissions.request({ origins: [match] });
      if (!permitted) throw new Error('请授予目标网站的访问权限后重试');
      created = await createDemo(root, title.trim() || '未命名演示', url.href);
      manifestRef.current = created;
      const session: ActiveSession = { sessionId: created.id, demoId: created.id, tabId: tab.id, origin: url.origin };
      sessionRef.current = session;
      await chrome.storage.local.set({ activeSession: session, recordingError: null });
      const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
      if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
      await chrome.scripting.registerContentScripts([{
        id: SCRIPT_ID, matches: [match], js: ['recorder.js'], runAt: 'document_start',
        allFrames: false, persistAcrossSessions: false, world: 'ISOLATED'
      }]);
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['recorder.js'], world: 'ISOLATED' });
      setActive(session);
      setNotice('录制进行中。完成页面操作后，请在此处选择“结束录制并保存”。');
      await refresh(root);
    } catch (error) {
      if (created) {
        await chrome.storage.local.remove('activeSession');
        sessionRef.current = null;
        const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
        if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
      }
      setNotice(`无法开始录制：${errorText(error)}`);
    } finally { setBusy(false); }
  }

  async function stopRecording() {
    if (!root || !active || busy) return;
    setBusy(true);
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      stopDrain.current ??= (async () => {
        let flushed = false;
        try {
          const response = await chrome.tabs.sendMessage(active.tabId, { type: 'STOP_RECORDER' });
          flushed = response?.ok === true;
        } catch { /* The page may have navigated or closed; persisted chunks remain available. */ }
        sessionRef.current = null;
        for (const port of assetPorts.current) port.disconnect();
        assetPorts.current.clear();
        await writeQueue.current;
        const manifest = manifestRef.current;
        if (!manifest) throw new Error('未找到录制记录，请重新打开录制面板');
        const finished = await finishDemo(root, manifest, flushed ? 'ready' : 'interrupted');
        return { manifest: finished, flushed };
      })();
      const drained = await Promise.race([
        stopDrain.current,
        new Promise<null>(resolve => { drainTimer = setTimeout(() => resolve(null), 30000); })
      ]);
      if (!drained) {
        sessionRef.current = null;
        for (const port of assetPorts.current) port.disconnect();
        assetPorts.current.clear();
        const message = '保存已中断：本地文件写入超过 30 秒，尚未确认保存完成。已保存的操作仍保留；请等待磁盘恢复后重试，或重新打开面板继续保存。完成前不能开始新录制。';
        setSavingInterrupted(true);
        setNotice(message);
        await chrome.storage.local.set({ recordingError: message });
        const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
        if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
        // Keep activeSession and the pending drain for an explicit retry. The
        // filesystem may still complete; it must not silently finalize the UI.
        return;
      }
      const { manifest, flushed } = drained;
      await chrome.storage.local.remove('activeSession');
      await chrome.storage.local.remove('recordingError');
      const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
      if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
      setActive(null);
      setSavingInterrupted(false);
      stopDrain.current = null;
      sessionRef.current = null;
      manifestRef.current = null;
      await refresh(root);
      openPage('editor', manifest.id);
      setNotice(flushed ? '演示已保存。请在新标签页配置交互热点。' : '已保存部分录制数据，最后一批操作可能缺失。');
    } catch (error) { stopDrain.current = null; setNotice(`结束录制失败：${errorText(error)}`); }
    finally { clearTimeout(drainTimer); setBusy(false); }
  }

  async function removeDemo(demo: DemoManifest) {
    if (!root || deletingId || demo.id === sessionRef.current?.demoId) return;
    if (!window.confirm(`确定永久删除演示“${demo.title}”吗？\n录制、交互热点和本地资源文件将一并删除，且无法在工具中恢复。`)) return;
    setDeletingId(demo.id);
    try {
      const { activeSession } = await chrome.storage.local.get('activeSession');
      if ((activeSession as ActiveSession | undefined)?.demoId === demo.id) throw new Error('录制中的演示不能删除，请先结束录制');
      if (!(await hasWritePermission(root)) && !(await requestWritePermission(root))) throw new Error('未获得素材库目录的写入权限');
      await deleteDemo(root, demo.id);
      setDemos(current => current.filter(item => item.id !== demo.id));
      setCoverages(current => { const next = { ...current }; delete next[demo.id]; return next; });
      setNotice(`已删除演示“${demo.title}”。`);
      try { await refresh(root); }
      catch (error) { setNotice(`已删除演示“${demo.title}”，但刷新素材库失败：${errorText(error)}`); }
    } catch (error) { setNotice(`删除演示失败：${errorText(error)}`); }
    finally { setDeletingId(null); }
  }

  async function exportDemo(demo: DemoManifest) {
    if (!root || exportingId || demo.status !== 'ready') return;
    let destination: FileSystemFileHandle;
    try {
      if (!('showSaveFilePicker' in window)) throw new Error('当前浏览器不支持保存演示文件，请使用 Chrome 或 Edge');
      destination = await window.showSaveFilePicker({ suggestedName: suggestedDemoPackageName(demo.title),
        types: [{ description: 'SMTX Demo 演示包', accept: { 'application/zip': ['.smtxdemo'] } }] });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setNotice(`无法选择导出位置：${errorText(error)}`);
      return;
    }
    setExportingId(demo.id);
    setNotice('正在导出演示，请勿关闭录制面板。');
    try {
      if (!(await hasWritePermission(root)) && !(await requestWritePermission(root))) throw new Error('请先授权素材库目录');
      const prepared = await prepareDemoPackage(root, demo.id);
      const { bytesWritten } = await writeDemoPackage(prepared, destination);
      const size = bytesWritten >= 1_000_000 ? `${(bytesWritten / 1_000_000).toFixed(1)} MB` : `${Math.ceil(bytesWritten / 1_000)} KB`;
      const missing = prepared.resourceIssueCount ? `；${prepared.resourceIssueCount} 项资源未保存，回放画面可能不完整` : '';
      setNotice(`已导出演示“${demo.title}”（${size}）${missing}。`);
    } catch (error) { setNotice(`导出演示失败：${errorText(error)}。请检查演示内容或另选保存位置。`); }
    finally { setExportingId(null); }
  }

  return <div className="side-panel">
    <header className="panel-header"><div className="brand-mark">D</div><div><h1>SMTX Demo Builder</h1><p>Record · Add Hotspots · Replay</p></div></header>
    <section className="panel-section">
      <h2>本地素材库</h2>
      <p className="muted">选择一个本地目录，作为演示素材库</p>
      <div className="row"><button type="button" onClick={selectFolder} disabled={!!active}>{root ? '更换素材库目录' : '选择素材库目录'}</button>{root && <strong className="folder-name">{root.name}</strong>}</div>
      {root && <button className="text-button" type="button" onClick={authorizeFolder}>授权并刷新素材库</button>}
    </section>
    <section className="panel-section">
      <h2>录制演示</h2>
      <label>目标页面地址<input value={address} onChange={event => setAddress(event.target.value)} placeholder="https://demo.example.com" /></label>
      <button type="button" onClick={openAddress} disabled={!address.trim()}>打开目标页面</button>
      <label>演示名称<input value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：创建虚拟机" /></label>
      {active ? <button type="button" className="primary danger" onClick={stopRecording} disabled={busy}>结束录制并保存</button>
        : <button type="button" className="primary" onClick={startRecording} disabled={!root || busy}>开始录制</button>}
      {active && <p className="recording-indicator">{savingInterrupted ? '● 录制已中断，文件保存未完成' : '● 录制进行中'}</p>}
    </section>
    <section className="panel-section">
      <h2>我的演示 <span className="count">{demos.length}</span></h2>
      {demos.length === 0 ? <p className="muted">暂无演示。完成录制后，演示将在此显示。</p> : demos.map(demo =>
        <div className="demo-item" key={demo.id}><div className="demo-main"><strong>{demo.title}</strong><small>{new Date(demo.createdAt).toLocaleString()} · {demo.status === 'ready' ? '可播放' : '录制未完成'}</small>
          <AssetCoverage formatVersion={demo.formatVersion} summary={demo.offlineAssets} assets={coverages[demo.id]?.assets} issues={coverages[demo.id]?.issues} /></div>
          <div className="row"><button type="button" onClick={() => openPage('editor', demo.id)}>编辑热点</button><button type="button" onClick={() => openPage('player', demo.id)}>播放</button><button type="button" onClick={() => void exportDemo(demo)} disabled={exportingId !== null || demo.status !== 'ready' || active?.demoId === demo.id} title={demo.status !== 'ready' ? '请先结束录制' : '导出为 .smtxdemo 文件'}>{exportingId === demo.id ? '导出中…' : '导出'}</button><button type="button" className="danger" onClick={() => void removeDemo(demo)} disabled={deletingId !== null || exportingId !== null || active?.demoId === demo.id} title={active?.demoId === demo.id ? '请先结束录制' : `永久删除“${demo.title}”`}>删除</button></div></div>)}
    </section>
    {notice && <p className="notice" role="status">{notice}</p>}
  </div>;
}

function useLoadedDemo(id: string) {
  const [root, setRoot] = useState<FileSystemDirectoryHandle | null>(null);
  const [demo, setDemo] = useState<LoadedDemo | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async (handle: FileSystemDirectoryHandle) => {
    try { setDemo(await loadDemo(handle, id)); setError(''); }
    catch (cause) { setError(`打开演示失败：${errorText(cause)}`); }
  }, [id]);
  useEffect(() => {
    void loadRootHandle().then(async handle => {
      if (!handle) { setError('请先在录制面板中选择素材库目录'); return; }
      setRoot(handle);
      if (await hasWritePermission(handle)) await load(handle);
      else setError('请重新授权素材库目录');
    }).catch(cause => setError(errorText(cause)));
  }, [load]);
  async function authorize() {
    try {
      const handle = root ?? await chooseFolder();
      setRoot(handle);
      if (!(await requestWritePermission(handle))) throw new Error('未获得素材库目录的访问权限');
      await load(handle);
    } catch (cause) { setError(errorText(cause)); }
  }
  return { root, demo, setDemo, error, authorize };
}

function Editor({ id }: { id: string }) {
  const { root, demo, setDemo, error, authorize } = useLoadedDemo(id);
  const replayerRef = useRef<Replayer | null>(null);
  const [selected, setSelected] = useState<ClickCandidate | null>(null);
  const [stepTitle, setStepTitle] = useState('');
  const [notice, setNotice] = useState('');
  const [assetIssues, setAssetIssues] = useState<AssetIssue[]>([]);

  function inspect(click: ClickCandidate) {
    setSelected(click);
    setStepTitle(click.label);
    const first = demo?.events[0]?.timestamp ?? click.time;
    replayerRef.current?.pause(Math.max(0, click.time - first - 80));
  }

  async function addStep() {
    if (!root || !demo || !selected) return;
    try {
      const first = demo.events[0]?.timestamp ?? selected.time;
      const step = makeHotspot(selected, stepTitle.trim() || selected.label, first + 80);
      const steps = [...demo.steps, step].sort((a, b) => a.at - b.at);
      await saveSteps(root, id, steps);
      setDemo({ ...demo, steps });
      setNotice('交互热点已保存');
    } catch (cause) { setNotice(errorText(cause)); }
  }

  async function removeStep(step: DemoStep) {
    if (!root || !demo) return;
    try {
      const steps = demo.steps.filter(item => item.id !== step.id);
      await saveSteps(root, id, steps);
      setDemo({ ...demo, steps });
    } catch (cause) { setNotice(errorText(cause)); }
  }

  if (!demo || !root) return <div className="empty-page"><h1>热点编辑器</h1><p>{error || '正在加载演示…'}</p><button onClick={authorize}>选择或授权素材库</button></div>;
  const selectedAt = selected ? Math.max(0, selected.time - (demo.events[0]?.timestamp ?? selected.time) - 80) : 0;
  return <div className="workspace">
    <header className="workspace-header"><div><h1>{demo.manifest.title}</h1><p>选择录制的点击操作，创建交互步骤</p></div><button className="primary" onClick={() => openPage('player', id)}>播放演示</button></header>
    <AssetCoverage formatVersion={demo.manifest.formatVersion} summary={demo.manifest.offlineAssets} assets={demo.assets} issues={assetIssues} />
    <div className="editor-layout"><div className="editor-preview"><ReplayCanvas root={root} demo={demo} replayerRef={replayerRef} preloadThroughAt={selectedAt} onAssetIssues={setAssetIssues} onReady={replayer => { if (selected) replayer.pause(selectedAt); }} /><p className="muted">选择右侧操作，预览将定位至该操作发生前。</p></div>
      <aside className="editor-side"><h2>点击操作</h2><div className="click-list">{demo.manifest.clicks.length === 0 && <p className="muted">未检测到点击操作。</p>}
        {demo.manifest.clicks.map((click, index) => <button className={selected?.id === click.id ? 'selected' : ''} type="button" key={click.id} onClick={() => inspect(click)}><span>{index + 1}. {click.label}</span><small>{((click.time - (demo.events[0]?.timestamp ?? click.time)) / 1000).toFixed(1)} 秒</small></button>)}</div>
        {selected && <div className="step-form"><label>热点名称<input value={stepTitle} onChange={event => setStepTitle(event.target.value)} /></label><button className="primary" onClick={addStep}>添加交互热点</button></div>}
        <h2>交互步骤 <span className="count">{demo.steps.length}</span></h2><div className="step-list">{demo.steps.map((step, index) => <div key={step.id}><span>{index + 1}. {step.title}</span><button className="text-button" onClick={() => removeStep(step)}>移除</button></div>)}</div>
      </aside></div>{notice && <p className="notice" role="status">{notice}</p>}
  </div>;
}

function GuidedPlayer({ id }: { id: string }) {
  const { root, demo, error, authorize } = useLoadedDemo(id);
  const replayerRef = useRef<Replayer | null>(null);
  const appliedSpeedRef = useRef<number | null>(null);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const [gateIndex, setGateIndex] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const [hint, setHint] = useState('');
  const [assetIssues, setAssetIssues] = useState<AssetIssue[]>([]);
  const [transitionLimitMs, setTransitionLimitMs] = useState<number | null>(null);
  const steps = demo?.steps ?? [];
  const gate = waiting ? steps[gateIndex] : null;
  const firstEventTime = demo?.events[0]?.timestamp ?? 0;
  const duration = Math.max(0, (demo?.events.at(-1)?.timestamp ?? firstEventTime) - firstEventTime);
  const clickOffsets = useMemo(() => demo?.manifest.clicks.map(click => click.time - firstEventTime) ?? [], [demo, firstEventTime]);

  const applyPlaybackSpeed = useCallback((replayer: Replayer, at: number) => {
    const speed = transitionLimitMs === null ? 1 : transitionSpeedAt(clickOffsets, 0, duration, at, transitionLimitMs);
    if (speed !== appliedSpeedRef.current) {
      replayer.setConfig({ speed });
      appliedSpeedRef.current = speed;
    }
  }, [clickOffsets, duration, transitionLimitMs]);

  useEffect(() => {
    if (!demo) return;
    let frame = 0;
    const tick = () => {
      const replayer = replayerRef.current;
      if (replayer && !waiting) {
        const at = replayer.getCurrentTime();
        if (steps[gateIndex] && at >= steps[gateIndex].at) {
          replayer.pause(steps[gateIndex].at);
          setWaiting(true);
        } else {
          applyPlaybackSpeed(replayer, at);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [applyPlaybackSpeed, demo, steps, gateIndex, waiting]);

  function continueAfterHotspot() {
    setHint('');
    setWaiting(false);
    setGateIndex(index => index + 1);
    const replayer = replayerRef.current;
    if (replayer) {
      const at = (gate?.at ?? 0) + 1;
      applyPlaybackSpeed(replayer, at);
      replayer.play(at);
    }
  }

  function restart() {
    setGateIndex(0);
    setWaiting(false);
    setHint('');
    const replayer = replayerRef.current;
    if (replayer) {
      applyPlaybackSpeed(replayer, 0);
      replayer.play(0);
    }
  }

  if (!demo || !root) return <div className="empty-page"><h1>演示播放器</h1><p>{error || '正在加载演示…'}</p><button onClick={authorize}>选择或授权素材库</button></div>;
  return <div className={`player-page${transitionLimitMs !== null ? ' compact-transitions' : ''}`}><header className="player-header"><div><h1>{demo.manifest.title}</h1><p>{steps.length ? `交互步骤 ${Math.min(gateIndex + 1, steps.length)} / ${steps.length}` : '自由回放'}</p></div><div className="row"><label className="playback-speed-control">播放加速<select value={transitionLimitMs ?? 'off'} title="仅压缩相邻点击之间超过所选时长的间隔" onChange={event => setTransitionLimitMs(event.target.value === 'off' ? null : Number(event.target.value))}><option value="off">关闭</option><option value="1000">1 秒</option><option value="2000">2 秒</option><option value="3000">3 秒</option></select></label><button onClick={restart}>从头播放</button><button onClick={() => stageWrapRef.current?.requestFullscreen()}>全屏</button></div></header>
    <AssetCoverage formatVersion={demo.manifest.formatVersion} summary={demo.manifest.offlineAssets} assets={demo.assets} issues={assetIssues} compact />
    <div className="player-stage-wrap" ref={stageWrapRef}><ReplayCanvas root={root} demo={demo} preloadThroughAt={steps[gateIndex]?.at ?? duration} onAssetIssues={setAssetIssues} replayerRef={replayerRef} gate={gate} onGateClick={continueAfterHotspot} onWrongClick={() => setHint(`请点击高亮的“${gate?.title}”`)} onReady={replayer => { appliedSpeedRef.current = null; applyPlaybackSpeed(replayer, 0); replayer.play(0); }} />
      {gate && <div className="guide-card"><strong>请点击：{gate.title}</strong><span>{hint || '点击高亮区域以继续播放'}</span></div>}
    </div>
    <footer className="player-footer">{transitionLimitMs === null ? '播放加速已关闭：按录制原速播放。' : `播放加速已开启：超过 ${transitionLimitMs / 1000} 秒的点击间隔约按 ${transitionLimitMs / 1000} 秒播放。`}此演示不会在原平台执行操作。</footer>
  </div>;
}

const params = new URLSearchParams(location.search);
const view = params.get('view');
const id = params.get('id');
createRoot(document.getElementById('root')!).render(view === 'editor' && id ? <Editor id={id} /> : view === 'player' && id ? <GuidedPlayer id={id} /> : <SidePanel />);
