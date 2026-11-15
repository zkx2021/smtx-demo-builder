import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import { request, json } from './api';
import type { Account, DemoFolder, DemoInput, DemoRecord, Environment, EnvironmentInput, Inspection, Playback, UsageStatus } from './api';
import { Player } from './player';
import { ResizableTable } from './resizable-table';
import type { ResizableColumn } from './resizable-table';
import './styles.css';

const blankEnvironment = (): EnvironmentInput => ({ name: '', purpose: '', url: '', externalStatus: 'public', usageStatus: 'open', releaseAt: null, note: '', accounts: [] });
const environmentInput = (item: Environment): EnvironmentInput => ({ name: item.name, purpose: item.purpose, url: item.url, externalStatus: item.externalStatus, usageStatus: item.usageStatus, releaseAt: item.releaseAt, note: item.note, accounts: item.accounts });
const blankDemo = (folderId: string | null): DemoInput => ({ title: '', description: '', productVersion: '', tags: [], uploader: '', folderId });
const dateTime = (value: string | null | undefined) => value ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
const dateOnly = (value: string) => new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
const bytes = (value: number) => value >= 1048576 ? `${(value / 1048576).toFixed(value >= 104857600 ? 0 : 1)} MB` : `${Math.ceil(value / 1024)} KB`;
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : '操作失败，请重试。';
const assetLabel = (status: DemoRecord['assetStatus']) => status === 'complete' ? '资源完整' : status === 'no-candidates' ? '无外部资源' : status === 'legacy' ? '旧版资源' : '资源不完整';
const assetWarning = (status: DemoRecord['assetStatus']) => status === 'partial' || status === 'legacy';
const environmentColumns: ResizableColumn[] = ['环境 / 入口', '对外展示', '使用状态', '预计释放', '最近更新'].map(label => ({ label, initial: 120, min: 100 }));
const libraryColumns: ResizableColumn[] = ['演示标题', '产品版本', '互动步骤', '资源状态', '上传日期'].map(label => ({ label, initial: 95, min: 85 }));

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const path: Record<string, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    search: <><circle cx="10.8" cy="10.8" r="6.6" /><path d="m16 16 4.2 4.2" /></>,
    folder: <path d="M3 6.5h6l2.2 2H21v10.5H3z" />,
    file: <><path d="M6 2.5h8l4 4V21H6z" /><path d="M14 2.5v4h4" /></>,
    edit: <><path d="m4 16 11.8-11.8 4 4L8 20H4z" /><path d="m13.5 6.5 4 4" /></>,
    trash: <><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 10v7M14 10v7" /></>,
    link: <><path d="M10 13.5a4 4 0 0 0 6.1.4l2.7-2.7a4 4 0 0 0-5.7-5.6l-1.5 1.5" /><path d="M14 10.5a4 4 0 0 0-6.1-.4l-2.7 2.7a4 4 0 0 0 5.7 5.6l1.5-1.5" /></>,
    copy: <><rect x="8" y="8" width="11" height="12" rx="1.5" /><path d="M5 16H4V4h12v1" /></>,
    eye: <><path d="M2.5 12s3.5-5 9.5-5 9.5 5 9.5 5-3.5 5-9.5 5-9.5-5-9.5-5Z" /><circle cx="12" cy="12" r="2.5" /></>,
    play: <path d="m8 5 11 7-11 7z" />,
    back: <path d="m12 4-8 8 8 8M4 12h17" />,
    restart: <><path d="M4 10a8 8 0 1 1-.1 4M4 4v6h6" /></>,
    expand: <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />,
    move: <path d="M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4" />,
    chevron: <path d="m6 9 6 6 6-6" />,
    close: <path d="M5 5 19 19M19 5 5 19" />,
    check: <path d="m4 12 5 5L20 6" />
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{path[name]}</svg>;
}

function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => { const handle = () => setPath(location.pathname); addEventListener('popstate', handle); return () => removeEventListener('popstate', handle); }, []);
  const go = (next: string) => { history.pushState({}, '', next); setPath(new URL(next, location.origin).pathname); scrollTo(0, 0); };
  return { path, go };
}

function Header({ active, go }: { active: 'environments' | 'demos'; go: (path: string) => void }) {
  return <header className="site-header"><button className="brand" onClick={() => go('/')}><span className="brand-mark"><i /><i /><i /></span><span>DemoCenter</span></button><nav aria-label="主导航"><button className={active === 'environments' ? 'active' : ''} onClick={() => go('/')}>DemoCenter 环境</button><button className={active === 'demos' ? 'active' : ''} onClick={() => go('/demos')}>互动 Demo</button></nav></header>;
}

function Banner({ message, clear }: { message: string; clear: () => void }) {
  return message ? <div className="banner" role="alert"><span>{message}</span><button aria-label="关闭提示" onClick={clear}><Icon name="close" size={16} /></button></div> : null;
}

function Empty({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="empty"><div className="empty-symbol"><Icon name="file" size={32} /></div><h3>{title}</h3><p>{detail}</p>{action}</div>;
}

function Status({ status, kind }: { status: string; kind: 'usage' | 'asset' }) {
  const label = kind === 'usage' ? ({ open: '公开', maintenance: '维护中', occupied: '占用中' } as Record<string, string>)[status] : assetLabel(status as DemoRecord['assetStatus']);
  const tone = kind === 'usage' ? status : assetWarning(status as DemoRecord['assetStatus']) ? 'warning' : 'open';
  return <span className={`status ${tone}`}><i />{label}</span>;
}

function EnvironmentForm({ initial, onCancel, onSave, busy }: { initial: EnvironmentInput; onCancel: () => void; onSave: (input: EnvironmentInput) => void; busy: boolean }) {
  const [form, setForm] = useState(initial);
  useEffect(() => setForm(initial), [initial]);
  const change = <K extends keyof EnvironmentInput>(key: K, value: EnvironmentInput[K]) => setForm(current => ({ ...current, [key]: value }));
  const updateAccount = (index: number, key: keyof Account, value: string) => change('accounts', form.accounts.map((account, at) => at === index ? { ...account, [key]: value } : account));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) return;
    onSave({ ...form, name: form.name.trim(), purpose: form.purpose.trim(), url: form.url.trim(), releaseAt: form.usageStatus === 'occupied' ? form.releaseAt : null,
      accounts: form.accounts.filter(account => account.label.trim() || account.username.trim() || account.password).map(account => ({ label: account.label.trim(), username: account.username.trim(), password: account.password })) });
  };
  return <form className="detail-form" onSubmit={submit}>
    <div className="form-grid"><label><span>环境名称 <b>*</b></span><input required value={form.name} onChange={e => change('name', e.target.value)} placeholder="例如：SMTX 演示集群" /></label><label>产品 / 用途<input value={form.purpose} onChange={e => change('purpose', e.target.value)} placeholder="用于方案讲解和功能演示" /></label></div>
    <label>访问入口<input type="url" value={form.url} onChange={e => change('url', e.target.value)} placeholder="https://" /></label>
    <div className="form-grid"><label>对外展示<select value={form.externalStatus} onChange={e => change('externalStatus', e.target.value as EnvironmentInput['externalStatus'])}><option value="public">可对外展示</option><option value="internal">仅内部使用</option></select></label><label>使用状态<select value={form.usageStatus} onChange={e => change('usageStatus', e.target.value as UsageStatus)}><option value="open">公开</option><option value="maintenance">维护中</option><option value="occupied">占用中</option></select></label></div>
    {form.usageStatus === 'occupied' && <label>预计释放<input type="datetime-local" value={form.releaseAt ? form.releaseAt.slice(0, 16) : ''} onChange={e => change('releaseAt', e.target.value ? new Date(e.target.value).toISOString() : null)} /></label>}
    <label>说明 / 备注<textarea value={form.note} onChange={e => change('note', e.target.value)} rows={3} placeholder="补充使用说明或当前占用情况" /></label>
    <div className="form-subhead"><h3>访问凭据</h3><button type="button" className="link-button" onClick={() => change('accounts', [...form.accounts, { label: '', username: '', password: '' }])}><Icon name="plus" size={15} /> 添加账号</button></div>
    {form.accounts.length === 0 && <p className="quiet">尚未添加账号。可以保存后再补充。</p>}
    {form.accounts.map((account, index) => <div className="account-edit" key={index}><div className="account-edit-head">账号 {index + 1}<button type="button" aria-label="移除账号" onClick={() => change('accounts', form.accounts.filter((_, at) => at !== index))}><Icon name="trash" size={16} /></button></div><input aria-label="用途标签" placeholder="用途标签，例如：管理员账号" value={account.label} onChange={e => updateAccount(index, 'label', e.target.value)} /><div className="form-grid"><input aria-label="用户名" placeholder="用户名" value={account.username} onChange={e => updateAccount(index, 'username', e.target.value)} /><input aria-label="密码" placeholder="密码" value={account.password} onChange={e => updateAccount(index, 'password', e.target.value)} /></div></div>)}
    <div className="form-actions"><button type="button" className="secondary-button" onClick={onCancel}>取消</button><button className="primary-button" disabled={busy}>{busy ? '正在保存…' : '保存环境'}</button></div>
  </form>;
}

function Credential({ account }: { account: Account }) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(account.password); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setCopied(false); } };
  return <div className="credential"><span>{account.label || '账号'}</span><strong>{account.username || '—'}</strong><div className="secret"><code>{visible ? account.password : '••••••••'}</code><button title={visible ? '隐藏密码' : '显示密码'} aria-label={visible ? '隐藏密码' : '显示密码'} onClick={() => setVisible(!visible)}><Icon name="eye" size={17} /></button><button title={copied ? '已复制' : '复制密码'} aria-label="复制密码" onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={17} /></button></div></div>;
}

function Environments() {
  const [items, setItems] = useState<Environment[]>([]), [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [query, setQuery] = useState(''), [usage, setUsage] = useState('all'), [mode, setMode] = useState<'detail' | 'create' | 'edit'>('detail');
  const selected = items.find(item => item.id === selectedId) ?? null;
  const filtered = items.filter(item => (usage === 'all' || item.usageStatus === usage) && `${item.name} ${item.purpose} ${item.url}`.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => { request<Environment[]>('/api/environments').then(data => { setItems(data); setSelectedId(data[0]?.id ?? null); }, cause => setError(errorMessage(cause))).finally(() => setLoading(false)); }, []);
  async function save(input: EnvironmentInput) {
    setBusy(true); setError('');
    try {
      const result = await request<Environment>(mode === 'create' ? '/api/environments' : `/api/environments/${encodeURIComponent(selectedId!)}`, json(mode === 'create' ? 'POST' : 'PATCH', input));
      setItems(current => mode === 'create' ? [result, ...current] : current.map(item => item.id === result.id ? result : item));
      setSelectedId(result.id); setMode('detail');
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  async function remove() {
    if (!selected || !confirm(`确定删除“${selected.name}”吗？此操作无法撤销。`)) return;
    setBusy(true); setError('');
    try { await request(`/api/environments/${encodeURIComponent(selected.id)}`, { method: 'DELETE' }); const rest = items.filter(item => item.id !== selected.id); setItems(rest); setSelectedId(rest[0]?.id ?? null); setMode('detail'); }
    catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  return <main className="page-shell"><h1 className="page-title">演示环境</h1><Banner message={error} clear={() => setError('')} />
    <div className="toolbar"><button className="primary-button" onClick={() => setMode('create')}><Icon name="plus" /> 新建环境</button><div className="search-field"><Icon name="search" /><input aria-label="搜索环境" placeholder="搜索环境名称或入口（如：SMTX、CloudTower）" value={query} onChange={e => setQuery(e.target.value)} /></div><select aria-label="按使用状态筛选" value={usage} onChange={e => setUsage(e.target.value)}><option value="all">使用状态：全部</option><option value="open">公开</option><option value="maintenance">维护中</option><option value="occupied">占用中</option></select></div>
    <div className="environment-layout"><section className="panel table-panel"><div className="table-scroll"><ResizableTable columns={environmentColumns} storageKey="democenter.environment.columns.v3"><tbody>{filtered.map(item => <tr key={item.id} className={selectedId === item.id && mode !== 'create' ? 'selected' : ''} onClick={() => { setSelectedId(item.id); setMode('detail'); }}><td><strong>{item.name}</strong><small>{item.url || item.purpose || '尚未填写入口'}</small></td><td>{item.externalStatus === 'public' ? '可对外展示' : '仅内部使用'}</td><td><Status status={item.usageStatus} kind="usage" /></td><td>{dateTime(item.releaseAt)}</td><td>{dateTime(item.updatedAt)}</td></tr>)}</tbody></ResizableTable></div>{!loading && filtered.length === 0 && <Empty title={items.length ? '没有匹配的环境' : '还没有演示环境'} detail={items.length ? '试试其他关键词或状态。' : '添加第一个环境，集中维护入口、状态和访问凭据。'} action={!items.length && <button className="secondary-button" onClick={() => setMode('create')}>新建环境</button>} />}{loading && <p className="loading">正在加载环境…</p>}</section>
      <aside className="panel detail-panel">{mode === 'create' ? <><div className="detail-heading"><h2>新建环境</h2></div><EnvironmentForm initial={blankEnvironment()} onCancel={() => setMode('detail')} onSave={save} busy={busy} /></> : selected ? mode === 'edit' ? <><div className="detail-heading"><h2>编辑环境</h2></div><EnvironmentForm initial={environmentInput(selected)} onCancel={() => setMode('detail')} onSave={save} busy={busy} /></> : <><div className="detail-heading"><h2>{selected.name}</h2><Status status={selected.usageStatus} kind="usage" /></div>{selected.purpose && <p className="detail-description">{selected.purpose}</p>}<div className="detail-toolbar"><button className="outline-blue" onClick={() => setMode('edit')}><Icon name="edit" size={16} /> 编辑</button></div><dl className="data-list"><div><dt>对外展示</dt><dd>{selected.externalStatus === 'public' ? '可对外展示' : '仅内部使用'}</dd></div><div><dt>使用状态</dt><dd><Status status={selected.usageStatus} kind="usage" /></dd></div><div><dt>预计释放</dt><dd>{dateTime(selected.releaseAt)}</dd></div><div><dt>最近更新</dt><dd>{dateTime(selected.updatedAt)}</dd></div></dl><div className="detail-section"><h3>访问入口</h3>{selected.url ? <div className="url-box"><Icon name="link" size={17} /><a href={selected.url} target="_blank" rel="noopener noreferrer">{selected.url}</a><button aria-label="复制入口" onClick={() => navigator.clipboard.writeText(selected.url)}><Icon name="copy" size={17} /></button></div> : <p className="quiet">尚未填写入口</p>}</div><div className="detail-section"><h3>访问凭据</h3>{selected.accounts.length ? selected.accounts.map((account, index) => <Credential account={account} key={index} />) : <p className="quiet">尚未添加访问凭据</p>}</div>{selected.note && <div className="detail-section"><h3>备注</h3><p className="detail-description">{selected.note}</p></div>}<button className="danger-link" disabled={busy} onClick={remove}><Icon name="trash" size={17} /> 删除环境</button></> : <Empty title="选择一个环境" detail="从列表中选择环境查看详情，或新建环境。" />}</aside></div>
  </main>;
}

function DemoEditor({ initial, folders, onSave, onCancel, busy }: { initial: DemoInput; folders: DemoFolder[]; onSave: (input: DemoInput) => void; onCancel: () => void; busy: boolean }) {
  const [form, setForm] = useState(initial), [tagText, setTagText] = useState(initial.tags.join('，'));
  useEffect(() => { setForm(initial); setTagText(initial.tags.join('，')); }, [initial]);
  const change = <K extends keyof DemoInput>(key: K, value: DemoInput[K]) => setForm(current => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => { event.preventDefault(); onSave({ ...form, title: form.title.trim(), description: form.description.trim(), productVersion: form.productVersion.trim(), uploader: form.uploader.trim(), tags: tagText.split(/[,，]/).map(tag => tag.trim()).filter(Boolean) }); };
  return <form className="demo-form" onSubmit={submit}><label><span>标题 <b>*</b></span><input required value={form.title} onChange={e => change('title', e.target.value)} placeholder="演示标题" /></label><label>简介<textarea rows={3} value={form.description} onChange={e => change('description', e.target.value)} placeholder="简要介绍演示内容" /></label><label>产品版本<input value={form.productVersion} onChange={e => change('productVersion', e.target.value)} placeholder="例如 v8.2.0" /></label><label>标签<input value={tagText} onChange={e => setTagText(e.target.value)} placeholder="多个标签用逗号分隔" /></label><label>上传人<input value={form.uploader} onChange={e => change('uploader', e.target.value)} placeholder="填写姓名" /></label><label>所在文件夹<select value={form.folderId ?? ''} onChange={e => change('folderId', e.target.value || null)}><option value="">未分类</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label><div className="form-actions"><button type="button" className="secondary-button" onClick={onCancel}>取消</button><button className="primary-button" disabled={busy}>{busy ? '正在保存…' : '保存信息'}</button></div></form>;
}

function Library({ go }: { go: (path: string) => void }) {
  const [demos, setDemos] = useState<DemoRecord[]>([]), [folders, setFolders] = useState<DemoFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string>('all'), [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [steps, setSteps] = useState<Playback['steps']>([]);
  const selected = demos.find(item => item.id === selectedId) ?? null;
  const filtered = demos.filter(item => (selectedFolder === 'all' || (selectedFolder === 'uncategorized' ? !item.folderId : item.folderId === selectedFolder)) && (filter === 'all' || item.productVersion === filter || item.tags.includes(filter)) && `${item.title} ${item.tags.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()));
  const filters = useMemo(() => [...new Set(demos.flatMap(item => [item.productVersion, ...item.tags]).filter(Boolean))].sort(), [demos]);
  const folderName = (id: string | null) => id ? folders.find(folder => folder.id === id)?.name ?? '未分类' : '未分类';
  useEffect(() => { Promise.all([request<DemoRecord[]>('/api/demos'), request<DemoFolder[]>('/api/demo-folders')]).then(([records, folderRecords]) => { setDemos(records); setFolders(folderRecords); const wanted = new URLSearchParams(location.search).get('selected'); setSelectedId(records.find(record => record.id === wanted)?.id ?? records[0]?.id ?? null); }, cause => setError(errorMessage(cause))).finally(() => setLoading(false)); }, []);
  useEffect(() => { if (!selectedId) { setSteps([]); return; } let cancelled = false; request<Playback['steps']>(`/api/demos/${encodeURIComponent(selectedId)}/steps`).then(data => { if (!cancelled) setSteps(data); }, () => { if (!cancelled) setSteps([]); }); return () => { cancelled = true; }; }, [selectedId]);
  async function createFolder() { const name = prompt('新文件夹名称')?.trim(); if (!name) return; setBusy(true); setError(''); try { const result = await request<DemoFolder>('/api/demo-folders', json('POST', { name })); setFolders(current => [...current, result]); setSelectedFolder(result.id); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }
  async function renameFolder(folder: DemoFolder) { const name = prompt('重命名文件夹', folder.name)?.trim(); if (!name || name === folder.name) return; setBusy(true); setError(''); try { const result = await request<DemoFolder>(`/api/demo-folders/${encodeURIComponent(folder.id)}`, json('PATCH', { name })); setFolders(current => current.map(item => item.id === folder.id ? result : item)); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }
  async function deleteFolder(folder: DemoFolder) { if (!confirm(`确定删除文件夹“${folder.name}”吗？其中的演示将移至“未分类”。`)) return; setBusy(true); setError(''); try { await request(`/api/demo-folders/${encodeURIComponent(folder.id)}`, { method: 'DELETE' }); setFolders(current => current.filter(item => item.id !== folder.id)); setDemos(current => current.map(item => item.folderId === folder.id ? { ...item, folderId: null } : item)); if (selectedFolder === folder.id) setSelectedFolder('uncategorized'); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }
  async function save(input: DemoInput) { if (!selected) return; setBusy(true); setError(''); try { const result = await request<DemoRecord>(`/api/demos/${encodeURIComponent(selected.id)}`, json('PATCH', input)); setDemos(current => current.map(item => item.id === result.id ? result : item)); setEditing(false); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }
  async function move(folderId: string | null) { if (!selected) return; setBusy(true); setError(''); try { const result = await request<DemoRecord>(`/api/demos/${encodeURIComponent(selected.id)}`, json('PATCH', { folderId })); setDemos(current => current.map(item => item.id === result.id ? result : item)); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }
  async function remove() { if (!selected || !confirm(`确定删除演示“${selected.title}”吗？此操作无法撤销。`)) return; setBusy(true); setError(''); try { await request(`/api/demos/${encodeURIComponent(selected.id)}`, { method: 'DELETE' }); const rest = demos.filter(item => item.id !== selected.id); setDemos(rest); setSelectedId(rest[0]?.id ?? null); setEditing(false); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }
  const uploadPath = `/demos/upload${selectedFolder !== 'all' && selectedFolder !== 'uncategorized' ? `?folder=${encodeURIComponent(selectedFolder)}` : ''}`;
  return <main className="page-shell"><h1 className="page-title">互动 Demo</h1><Banner message={error} clear={() => setError('')} /><div className="toolbar"><button className="primary-button" onClick={() => go(uploadPath)}><Icon name="plus" /> 上传演示</button><div className="search-field"><Icon name="search" /><input aria-label="搜索演示" placeholder="搜索演示标题或标签" value={query} onChange={e => setQuery(e.target.value)} /></div><select aria-label="按产品或标签筛选" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">产品 / 标签：全部</option>{filters.map(value => <option key={value} value={value}>{value}</option>)}</select></div>
    <div className="library-layout"><aside className="panel folder-panel"><div className="folder-heading"><h2>文件夹</h2><button className="link-button" disabled={busy} onClick={createFolder}><Icon name="plus" size={16} /> 新建</button></div><p className="folder-help">按文件夹组织已上传的互动演示</p><div className="folder-list"><button className={selectedFolder === 'all' ? 'active' : ''} onClick={() => setSelectedFolder('all')}><Icon name="folder" /> 全部演示 <span>({demos.length})</span></button><button className={selectedFolder === 'uncategorized' ? 'active' : ''} onClick={() => setSelectedFolder('uncategorized')}><Icon name="folder" /> 未分类 <span>({demos.filter(item => !item.folderId).length})</span></button>{folders.map(folder => <div className={`folder-row ${selectedFolder === folder.id ? 'active' : ''}`} key={folder.id}><button className="folder-select" onClick={() => setSelectedFolder(folder.id)}><Icon name="folder" /> <span>{folder.name} ({demos.filter(item => item.folderId === folder.id).length})</span></button><button className="folder-more" title="重命名文件夹" aria-label={`重命名 ${folder.name}`} onClick={() => renameFolder(folder)}><Icon name="edit" size={15} /></button><button className="folder-more" title="删除文件夹" aria-label={`删除 ${folder.name}`} onClick={() => deleteFolder(folder)}><Icon name="trash" size={15} /></button></div>)}</div></aside>
      <section className="panel table-panel"><div className="table-scroll"><ResizableTable columns={libraryColumns} storageKey="democenter.library.columns.v3"><tbody>{filtered.map(item => <tr key={item.id} className={selectedId === item.id ? 'selected' : ''} onClick={() => { setSelectedId(item.id); setEditing(false); }}><td><strong>{item.title}</strong><small>{item.description || item.tags.join('、') || '暂无简介'}</small></td><td>{item.productVersion || '—'}</td><td>{item.stepCount} 步</td><td><Status status={item.assetStatus} kind="asset" /></td><td>{dateOnly(item.uploadedAt)}</td></tr>)}</tbody></ResizableTable></div>{!loading && filtered.length === 0 && <Empty title={demos.length ? '没有匹配的演示' : '素材库还是空的'} detail={demos.length ? '试试其他关键词、标签或文件夹。' : '上传 SMTX Demo Builder 导出的演示文件，开始建立素材库。'} action={!demos.length && <button className="secondary-button" onClick={() => go(uploadPath)}>上传演示</button>} />}{loading && <p className="loading">正在加载演示…</p>}</section>
      <aside className="panel detail-panel">{selected ? editing ? <><div className="detail-heading"><h2>编辑演示信息</h2></div><DemoEditor initial={{ title: selected.title, description: selected.description, productVersion: selected.productVersion, tags: selected.tags, uploader: selected.uploader, folderId: selected.folderId }} folders={folders} onSave={save} onCancel={() => setEditing(false)} busy={busy} /></> : <><div className="detail-heading"><h2>{selected.title}</h2></div><p className="detail-description">{selected.description || '暂无简介'}</p><div className="folder-location"><span>所在文件夹： <strong>{folderName(selected.folderId)}</strong></span><label className="move-label"><Icon name="move" size={15} /><select aria-label="移动到文件夹" value={selected.folderId ?? ''} disabled={busy} onChange={e => move(e.target.value || null)}><option value="">移动到：未分类</option>{folders.map(folder => <option key={folder.id} value={folder.id}>移动到：{folder.name}</option>)}</select></label></div><dl className="data-list"><div><dt>产品版本</dt><dd>{selected.productVersion || '—'}</dd></div><div><dt>标签</dt><dd className="tags">{selected.tags.length ? selected.tags.map(tag => <span key={tag}>{tag}</span>) : '—'}</dd></div><div><dt>互动步骤</dt><dd>{selected.stepCount} 步</dd></div><div><dt>资源状态</dt><dd><Status status={selected.assetStatus} kind="asset" /></dd></div><div><dt>上传人</dt><dd>{selected.uploader || '—'}</dd></div><div><dt>上传日期</dt><dd>{dateTime(selected.uploadedAt)}</dd></div></dl>{assetWarning(selected.assetStatus) && <p className="resource-note">{selected.resourceIssueCount ? `${selected.resourceIssueCount} 个资源缺失。` : '部分资源可能缺失。'}播放画面可能不完整。</p>}<button className="primary-button wide" onClick={() => go(`/demos/${encodeURIComponent(selected.id)}/play`)}><Icon name="play" size={18} /> 播放演示</button><button className="secondary-button wide" onClick={() => setEditing(true)}><Icon name="edit" size={17} /> 编辑信息</button><div className="detail-section"><h3>互动步骤</h3>{steps.length ? <ol className="step-list">{steps.map((step, index) => <li key={step.id}><span>{index + 1}</span>{step.title}</li>)}</ol> : <p className="quiet">打开播放器查看演示步骤。</p>}</div><button className="danger-link" disabled={busy} onClick={remove}><Icon name="trash" size={17} /> 删除演示</button></> : <Empty title="选择一个演示" detail="从列表中选择演示查看详情，或上传新演示。" />}</aside></div>
  </main>;
}

function Upload({ go }: { go: (path: string) => void }) {
  const [folders, setFolders] = useState<DemoFolder[]>([]), [file, setFile] = useState<File | null>(null), [inspection, setInspection] = useState<Inspection | null>(null);
  const [form, setForm] = useState<DemoInput>(() => blankDemo(new URLSearchParams(location.search).get('folder'))), [tagText, setTagText] = useState('');
  const [inspecting, setInspecting] = useState(false), [publishing, setPublishing] = useState(false), [error, setError] = useState('');
  useEffect(() => { request<DemoFolder[]>('/api/demo-folders').then(setFolders, cause => setError(errorMessage(cause))); }, []);
  const choose = async (chosen: File | undefined) => {
    if (!chosen) return;
    setFile(chosen); setInspection(null); setError('');
    if (!chosen.name.toLowerCase().endsWith('.smtxdemo')) { setError('请选择 .smtxdemo 演示文件。'); return; }
    if (chosen.size > 512000000) { setError('文件超过 512 MB 上传上限，请选择较小的演示包。'); return; }
    setInspecting(true);
    try { const body = new FormData(); body.append('file', chosen); const result = await request<Inspection>('/api/demos/inspect', { method: 'POST', body }); setInspection(result); setForm(current => ({ ...current, title: result.sourceTitle })); }
    catch (cause) { setError(errorMessage(cause)); } finally { setInspecting(false); }
  };
  async function publish(event: FormEvent) {
    event.preventDefault(); if (!inspection) return; setPublishing(true); setError('');
    try { const record = await request<DemoRecord>('/api/demos', json('POST', { uploadToken: inspection.uploadToken, ...form, title: form.title.trim(), description: form.description.trim(), productVersion: form.productVersion.trim(), tags: tagText.split(/[,，]/).map(value => value.trim()).filter(Boolean), uploader: form.uploader.trim() })); go(`/demos?selected=${encodeURIComponent(record.id)}`); }
    catch (cause) { setError(errorMessage(cause)); } finally { setPublishing(false); }
  }
  const change = <K extends keyof DemoInput>(key: K, value: DemoInput[K]) => setForm(current => ({ ...current, [key]: value }));
  return <main className="page-shell upload-page"><div className="breadcrumb"><button onClick={() => go('/demos')}>互动 Demo</button><span>/</span>上传演示</div><h1 className="page-title">上传演示文件</h1><p className="page-subtitle">导入 SMTX Demo Builder 导出的演示文件</p><Banner message={error} clear={() => setError('')} /><form className="upload-layout" onSubmit={publish}><div className="upload-main"><section className="panel form-panel"><h2>演示包</h2><label className="file-drop"><input type="file" accept=".smtxdemo" onChange={e => { const chosen = e.target.files?.[0]; e.target.value = ''; void choose(chosen); }} /><span className="file-icon"><Icon name="file" size={27} /></span><span className="file-details"><strong>{file ? file.name : '选择 .smtxdemo 演示文件'}</strong><small>{file ? bytes(file.size) : '点击选择从 Demo Builder 导出的文件'}</small></span><span className="file-action">{file ? '更换文件' : '选择文件'}</span></label><p className="file-hint">支持 .smtxdemo，最大 512 MB</p></section><section className="panel form-panel"><h2>展示信息</h2><div className="upload-fields"><label><span>标题 <b>*</b></span><input required value={form.title} onChange={e => change('title', e.target.value)} placeholder="演示标题" /></label><label>简介<textarea rows={3} value={form.description} onChange={e => change('description', e.target.value)} placeholder="介绍演示内容和关键步骤" /></label><label>产品版本<input value={form.productVersion} onChange={e => change('productVersion', e.target.value)} placeholder="例如 v8.2.0" /></label><label>标签<input value={tagText} onChange={e => setTagText(e.target.value)} placeholder="多个标签用逗号分隔" /></label><label>上传人<input value={form.uploader} onChange={e => change('uploader', e.target.value)} placeholder="填写姓名" /></label><label>所在文件夹<select value={form.folderId ?? ''} onChange={e => change('folderId', e.target.value || null)}><option value="">未分类</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label></div></section></div><aside className="panel inspection-panel"><h2>演示包检查</h2>{inspection ? <><div className={`inspection-result ${assetWarning(inspection.assetStatus) ? 'caution' : ''}`}><Icon name="check" size={20} /> 可以发布</div><dl className="data-list"><div><dt>文件大小</dt><dd>{bytes(inspection.sizeBytes)}</dd></div><div><dt>互动步骤</dt><dd>{inspection.stepCount}</dd></div><div><dt>资源状态</dt><dd><Status status={inspection.assetStatus} kind="asset" /></dd></div><div><dt>资源缺失</dt><dd>{inspection.resourceIssueCount}</dd></div></dl>{assetWarning(inspection.assetStatus) && <p className="resource-note">资源不完整，发布后可能影响部分回放画面。</p>}</> : <div className="inspection-pending"><Icon name="file" size={30} /><p>{inspecting ? '正在检查演示包…' : '选择文件后，将在这里显示格式和资源检查结果。'}</p></div>}<div className="inspection-bottom"><p>发布后，所有同事可在素材库中查看和播放。</p><button className="primary-button wide" disabled={!inspection || inspecting || publishing}>{publishing ? '正在发布…' : '上传并发布'}</button><button type="button" className="secondary-button wide" onClick={() => go('/demos')}>取消</button></div></aside></form></main>;
}

function App() {
  const { path, go } = usePath();
  const player = /^\/demos\/([^/]+)\/play$/.exec(path);
  if (player) return <Player key={player[1]} id={decodeURIComponent(player[1])} go={go} />;
  return <><Header active={path === '/' ? 'environments' : 'demos'} go={go} />{path === '/demos/upload' ? <Upload key={location.search} go={go} /> : path === '/demos' ? <Library key={path} go={go} /> : <Environments />}</>;
}

createRoot(document.getElementById('root')!).render(<App />);
