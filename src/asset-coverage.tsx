import type { AssetIndex, AssetSummary } from './model.ts';
import { isInlineCssFragmentReference, redactAssetUrl } from './asset-refs.ts';
import { summarizeAssetIndex } from './asset-store.ts';

export interface AssetIssue { url: string; reason: string }

interface AssetCoverageProps {
  formatVersion: 1 | 2;
  summary?: AssetSummary;
  assets?: AssetIndex | null;
  issues?: AssetIssue[];
  compact?: boolean;
}

function issueReason(reason: string): string {
  if (/missing|unreadable|unavailable/i.test(reason)) return '本地文件缺失或无法读取';
  if (/decode/i.test(reason)) return '已保存图片无法解码';
  if (/preload timed out/i.test(reason)) return '已保存图片预加载超时';
  if (/^HTTP [1-5]\d\d$/i.test(reason)) return reason.toUpperCase();
  if (/cross.origin/i.test(reason)) return '跨域资源未捕获';
  if (/stylesheet/i.test(reason)) return '外部样式表无法安全保存';
  if (/10 MB/i.test(reason)) return '单项资源超过 10 MB';
  if (/200 MB/i.test(reason)) return '演示资源超过 200 MB';
  if (/SHA-256/i.test(reason)) return '资源校验失败（SHA-256 不匹配）';
  if (/unsupported|mismatch|extension|MIME/i.test(reason)) return '资源类型或内容不受支持';
  if (/timed out|timeout/i.test(reason)) return '资源读取或保存超时';
  if (/disconnect/i.test(reason)) return '录制连接中断';
  if (/fetch|network/i.test(reason)) return '资源网络读取失败';
  if (/finish|stop/i.test(reason)) return '录制结束前未完成捕获';
  return '资源读取或保存失败（详细原因已隐藏）';
}

const contextNames = { img: '图片', srcset: '响应式图片', svg: 'SVG 图片', css: 'CSS / 字体', stylesheet: '样式表' } as const;

export function AssetCoverage({ formatVersion, summary, assets, issues = [], compact = false }: AssetCoverageProps) {
  const legacy = formatVersion === 1 || summary?.status === 'legacy';
  const visibleAssets = assets ? { ...assets, entries: assets.entries.filter(entry =>
    entry.status !== 'failed' || !isInlineCssFragmentReference(entry.url, entry.context)) } : null;
  const indexed = visibleAssets ? summarizeAssetIndex(visibleAssets) : null;
  const recorded = assets ? summarizeAssetIndex(assets) : null;
  const ignored = (assets?.entries.length ?? 0) - (visibleAssets?.entries.length ?? 0);
  const discovered = Math.max(0, (summary?.discovered ?? 0) - ignored, indexed?.discovered ?? 0);
  const failures = visibleAssets?.entries.filter(entry => entry.status === 'failed') ?? [];
  const issueUrls = new Set(issues.map(issue => issue.url));
  const available = Math.max(0, (indexed?.saved ?? 0) - (visibleAssets?.entries.filter(entry => entry.status === 'saved' && issueUrls.has(entry.url)).length ?? 0));
  const mismatch = !!summary && !!recorded && (summary.discovered !== recorded.discovered || summary.saved !== recorded.saved || summary.failed !== recorded.failed || summary.uniqueBytes !== recorded.uniqueBytes || summary.status !== recorded.status);
  const status = legacy ? '此旧演示未保存离线资源'
    : !indexed || issues.length || mismatch || indexed.status === 'partial' ? '离线资源不完整'
      : indexed.status === 'no-candidates' ? '未发现需保存的资源' : '已发现资源均已保存';
  const details = <>
    {!legacy && <>{!!indexed?.uniqueBytes && <p>去重后 {(indexed.uniqueBytes / 1024).toFixed(1)} KB</p>}
      <p className="asset-availability">当前可用 {available} / 已发现 {discovered} 项{!indexed ? '；资源索引缺失或无法读取。' : issues.length ? '；部分已保存资源在本机不可读取。' : mismatch ? '；录制汇总与资源索引不一致。' : '。'}</p></>}
    {!legacy && <p className="asset-scope">覆盖状态仅表示已发现的受支持静态资源，不代表整个网站可离线使用。</p>}
    {!!failures.length && <><p className="asset-list-label">未保存资源（{failures.length}）</p><ul className="asset-failures">{failures.map(entry => <li key={entry.url}><span>{contextNames[entry.context]} · {redactAssetUrl(entry.url)}</span><small>{issueReason(entry.reason ?? '捕获未完成')}</small></li>)}</ul></>}
    {!!issues.length && <><p className="asset-list-label">回放警告（{issues.length}）</p><ul className="asset-failures asset-runtime-issues">{issues.map((issue, index) => <li key={`${issue.url}-${index}`}><span>{redactAssetUrl(issue.url)}</span><small>{issueReason(issue.reason)}</small></li>)}</ul></>}
  </>;
  return <section className={`asset-coverage${compact ? ' asset-coverage-compact' : ''}${status === '离线资源不完整' ? ' asset-coverage-partial' : ''}`} role="region" aria-label="离线资源覆盖">
    <strong>{status}</strong>
    {!legacy && <p>已保存 {indexed?.saved ?? 0} / 已发现 {discovered} 项离线资源</p>}
    {compact ? !legacy && <details className="asset-details"><summary>资源详情</summary><div className="asset-detail-panel">{details}</div></details> : details}
  </section>;
}
