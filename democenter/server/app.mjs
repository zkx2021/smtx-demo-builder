import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPackage, inspectExtractedPackage, MAX_UPLOAD_BYTES, PackageError } from './package.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultDistDir = path.resolve(moduleDir, '../dist');

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function requiredName(value, label = '名称') {
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(400, `${label}不能为空`);
  if (value.trim().length > 200) throw new ApiError(400, `${label}过长`);
  return value.trim();
}
function string(value, label, max = 5000) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw new ApiError(400, `${label}无效`);
  return value.trim();
}
function enumValue(value, choices, label) {
  if (!choices.includes(value)) throw new ApiError(400, `${label}无效`);
  return value;
}
function dateOrNull(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new ApiError(400, '预计释放时间无效');
  return new Date(value).toISOString();
}
function accounts(value) {
  if (!Array.isArray(value) || value.length > 50) throw new ApiError(400, '账号列表无效');
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ApiError(400, '账号列表无效');
    return { label: string(item.label, '账号用途', 200), username: string(item.username, '账号名', 500), password: string(item.password, '密码', 2000) };
  });
}
function tags(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 30 || value.some(tag => typeof tag !== 'string' || tag.length > 100)) throw new ApiError(400, '标签无效');
  return [...new Set(value.map(tag => tag.trim()).filter(Boolean))];
}
function folderId(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)) throw new ApiError(400, '文件夹编号无效');
  return value;
}
function environmentInput(input, existing = {}) {
  const merged = { ...existing, ...input };
  const usageStatus = enumValue(merged.usageStatus ?? 'open', ['open', 'maintenance', 'occupied'], '使用状态');
  return {
    name: requiredName(merged.name, '环境名称'),
    purpose: string(merged.purpose, '用途', 1000),
    url: string(merged.url, '入口地址', 2000),
    externalStatus: enumValue(merged.externalStatus ?? 'internal', ['public', 'internal'], '对外展示状态'),
    usageStatus,
    releaseAt: usageStatus === 'occupied' ? dateOrNull(merged.releaseAt) : null,
    note: string(merged.note, '备注', 10000),
    accounts: accounts(merged.accounts ?? []),
  };
}
function demoInput(input, existing = {}) {
  const merged = { ...existing, ...input };
  return {
    title: requiredName(merged.title, '演示标题'),
    description: string(merged.description, '简介', 10000),
    productVersion: string(merged.productVersion, '产品版本', 200),
    tags: tags(merged.tags),
    uploader: string(merged.uploader, '上传人', 200),
    folderId: folderId(merged.folderId),
  };
}
function iso(value) { return value == null ? null : (value instanceof Date ? value : new Date(value)).toISOString(); }
function environment(row) {
  return { id: row.id, name: row.name, purpose: row.purpose, url: row.url, externalStatus: row.external_status,
    usageStatus: row.usage_status, releaseAt: iso(row.release_at), note: row.note, accounts: row.accounts, updatedAt: iso(row.updated_at) };
}
function folder(row) { return { id: row.id, name: row.name, createdAt: iso(row.created_at) }; }
function demo(row) {
  return { id: row.id, sourceDemoId: row.source_demo_id, title: row.title, description: row.description,
    productVersion: row.product_version, tags: row.tags, uploader: row.uploader, folderId: row.folder_id,
    uploadedAt: iso(row.uploaded_at), stepCount: row.step_count, assetStatus: row.asset_status,
    resourceIssueCount: row.resource_issue_count };
}
function one(result, message) {
  if (!result.rows[0]) throw new ApiError(404, message);
  return result.rows[0];
}
function asyncRoute(fn) { return (req, res, next) => Promise.resolve(fn(req, res)).catch(next); }

export async function cleanupStaleUploads(dataDir, now = Date.now()) {
  for (const name of ['tmp', 'staging']) {
    const dir = path.join(dataDir, name);
    let entries;
    try { entries = await readdir(dir); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      const target = path.join(dir, entry);
      const info = await stat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (info && now - info.mtimeMs > 24 * 60 * 60 * 1000) await rm(target, { recursive: true, force: true });
    }
  }
}

export function createApp({ pool, dataDir = process.env.DATA_DIR ?? path.resolve(moduleDir, '../data'), distDir = defaultDistDir }) {
  if (!pool) throw new Error('Database pool is required');
  const tmpDir = path.join(dataDir, 'tmp');
  const stagingDir = path.join(dataDir, 'staging');
  const demosDir = path.join(dataDir, 'demos');
  const trashDir = path.join(dataDir, 'trash');
  for (const dir of [tmpDir, stagingDir, demosDir, trashDir]) mkdirSync(dir, { recursive: true });
  const upload = multer({ dest: tmpDir, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0 } });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', asyncRoute(async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  }));

  app.get('/api/environments', asyncRoute(async (_req, res) => {
    const result = await pool.query('SELECT * FROM environments ORDER BY updated_at DESC, name ASC');
    res.json(result.rows.map(environment));
  }));
  app.post('/api/environments', asyncRoute(async (req, res) => {
    const value = environmentInput(req.body ?? {});
    const result = await pool.query(`INSERT INTO environments (id,name,purpose,url,external_status,usage_status,release_at,note,accounts)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,
    [randomUUID(), value.name, value.purpose, value.url, value.externalStatus, value.usageStatus, value.releaseAt, value.note, JSON.stringify(value.accounts)]);
    res.status(201).json(environment(result.rows[0]));
  }));
  app.patch('/api/environments/:id', asyncRoute(async (req, res) => {
    const current = environment(one(await pool.query('SELECT * FROM environments WHERE id=$1', [req.params.id]), '环境不存在'));
    const value = environmentInput(req.body ?? {}, current);
    const result = await pool.query(`UPDATE environments SET name=$2,purpose=$3,url=$4,external_status=$5,usage_status=$6,
      release_at=$7,note=$8,accounts=$9::jsonb,updated_at=now() WHERE id=$1 RETURNING *`,
    [req.params.id, value.name, value.purpose, value.url, value.externalStatus, value.usageStatus, value.releaseAt, value.note, JSON.stringify(value.accounts)]);
    res.json(environment(one(result, '环境不存在')));
  }));
  app.delete('/api/environments/:id', asyncRoute(async (req, res) => {
    one(await pool.query('DELETE FROM environments WHERE id=$1 RETURNING id', [req.params.id]), '环境不存在');
    res.json({ ok: true });
  }));

  app.get('/api/demo-folders', asyncRoute(async (_req, res) => {
    const result = await pool.query('SELECT * FROM demo_folders ORDER BY created_at ASC, name ASC');
    res.json(result.rows.map(folder));
  }));
  app.post('/api/demo-folders', asyncRoute(async (req, res) => {
    const name = requiredName(req.body?.name, '文件夹名称');
    const result = await pool.query('INSERT INTO demo_folders (id,name) VALUES ($1,$2) RETURNING *', [randomUUID(), name]);
    res.status(201).json(folder(result.rows[0]));
  }));
  app.patch('/api/demo-folders/:id', asyncRoute(async (req, res) => {
    const name = requiredName(req.body?.name, '文件夹名称');
    const result = await pool.query('UPDATE demo_folders SET name=$2 WHERE id=$1 RETURNING *', [req.params.id, name]);
    res.json(folder(one(result, '文件夹不存在')));
  }));
  app.delete('/api/demo-folders/:id', asyncRoute(async (req, res) => {
    one(await pool.query('DELETE FROM demo_folders WHERE id=$1 RETURNING id', [req.params.id]), '文件夹不存在');
    res.json({ ok: true });
  }));

  app.get('/api/demos', asyncRoute(async (_req, res) => {
    const result = await pool.query('SELECT * FROM demos ORDER BY uploaded_at DESC, title ASC');
    res.json(result.rows.map(demo));
  }));
  app.post('/api/demos/inspect', upload.single('file'), asyncRoute(async (req, res) => {
    if (!req.file) throw new ApiError(400, '请选择 .smtxdemo 演示文件');
    const uploaded = req.file.path;
    let stage;
    try {
      if (!req.file.originalname.toLowerCase().endsWith('.smtxdemo')) throw new ApiError(400, '只支持 .smtxdemo 演示文件');
      const token = randomUUID();
      stage = path.join(stagingDir, token);
      const packageDir = path.join(stage, 'package');
      await extractPackage(uploaded, packageDir);
      const inspected = await inspectExtractedPackage(packageDir);
      const metadata = { createdAt: Date.now(), sizeBytes: req.file.size, sourceTitle: inspected.manifest.title,
        sourceDemoId: inspected.manifest.id, stepCount: inspected.steps.length, assetStatus: inspected.assetStatus,
        resourceIssueCount: inspected.resourceIssueCount, formatVersion: inspected.manifest.formatVersion,
        packageFormatVersion: inspected.packageManifest.packageFormatVersion };
      await writeFile(path.join(stage, 'meta.json'), JSON.stringify(metadata), { flag: 'wx' });
      res.json({ uploadToken: token, sourceTitle: metadata.sourceTitle, sourceDemoId: metadata.sourceDemoId,
        stepCount: metadata.stepCount, assetStatus: metadata.assetStatus, sizeBytes: metadata.sizeBytes,
        resourceIssueCount: metadata.resourceIssueCount });
    } catch (error) {
      if (stage) await rm(stage, { recursive: true, force: true });
      throw error;
    } finally { await rm(uploaded, { force: true }); }
  }));
  app.post('/api/demos', asyncRoute(async (req, res) => {
    const token = req.body?.uploadToken;
    if (typeof token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(token)) throw new ApiError(400, '上传凭证无效');
    const value = demoInput(req.body);
    const source = path.join(stagingDir, token);
    let metadata;
    try { metadata = JSON.parse(await readFile(path.join(source, 'meta.json'), 'utf8')); }
    catch { throw new ApiError(400, '上传凭证不存在或已使用，请重新上传'); }
    if (Date.now() - metadata.createdAt > 24 * 60 * 60 * 1000) throw new ApiError(400, '上传凭证已过期，请重新上传');
    const id = randomUUID();
    const destination = path.join(demosDir, id);
    try { await rename(source, destination); }
    catch (error) {
      if (error.code === 'ENOENT') throw new ApiError(400, '上传凭证不存在或已使用，请重新上传');
      throw error;
    }
    let result;
    try {
      result = await pool.query(`INSERT INTO demos
        (id,source_demo_id,title,description,product_version,tags,uploader,folder_id,format_version,package_format_version,step_count,asset_status,resource_issue_count)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [id, metadata.sourceDemoId, value.title, value.description, value.productVersion, JSON.stringify(value.tags),
        value.uploader, value.folderId, metadata.formatVersion, metadata.packageFormatVersion, metadata.stepCount,
        metadata.assetStatus, metadata.resourceIssueCount]);
    } catch (error) {
      try { await rename(destination, source); }
      catch (restoreError) { console.error('Could not restore staged demo after database failure:', restoreError); }
      throw error;
    }
    res.status(201).json(demo(result.rows[0]));
  }));
  app.patch('/api/demos/:id', asyncRoute(async (req, res) => {
    const current = demo(one(await pool.query('SELECT * FROM demos WHERE id=$1', [req.params.id]), '演示不存在'));
    const value = demoInput(req.body ?? {}, current);
    const result = await pool.query(`UPDATE demos SET title=$2,description=$3,product_version=$4,tags=$5::jsonb,
      uploader=$6,folder_id=$7 WHERE id=$1 RETURNING *`,
    [req.params.id, value.title, value.description, value.productVersion, JSON.stringify(value.tags), value.uploader, value.folderId]);
    res.json(demo(one(result, '演示不存在')));
  }));
  app.delete('/api/demos/:id', asyncRoute(async (req, res) => {
    const client = await pool.connect();
    const source = path.join(demosDir, req.params.id);
    const trash = path.join(trashDir, `${req.params.id}-${randomUUID()}`);
    let moved = false;
    let committed = false;
    try {
      await client.query('BEGIN');
      one(await client.query('SELECT id FROM demos WHERE id=$1 FOR UPDATE', [req.params.id]), '演示不存在');
      await rename(source, trash);
      moved = true;
      await client.query('DELETE FROM demos WHERE id=$1', [req.params.id]);
      await client.query('COMMIT');
      committed = true;
      await rm(trash, { recursive: true });
      res.json({ ok: true });
    } catch (error) {
      if (!committed) {
        await client.query('ROLLBACK');
        if (moved) await rename(trash, source);
      }
      throw error;
    } finally { client.release(); }
  }));
  app.get('/api/demos/:id/steps', asyncRoute(async (req, res) => {
    one(await pool.query('SELECT id FROM demos WHERE id=$1', [req.params.id]), '演示不存在');
    const steps = JSON.parse(await readFile(path.join(demosDir, req.params.id, 'package', 'steps.json'), 'utf8'));
    res.json(steps);
  }));
  app.get('/api/demos/:id/playback', asyncRoute(async (req, res) => {
    one(await pool.query('SELECT id FROM demos WHERE id=$1', [req.params.id]), '演示不存在');
    const loaded = await inspectExtractedPackage(path.join(demosDir, req.params.id, 'package'));
    res.json({ manifest: loaded.manifest, steps: loaded.steps, events: loaded.events, assets: loaded.assets,
      assetStatus: loaded.assetStatus, resourceIssueCount: loaded.resourceIssueCount });
  }));
  app.get('/api/demos/:id/assets/:filename', asyncRoute(async (req, res) => {
    one(await pool.query('SELECT id FROM demos WHERE id=$1', [req.params.id]), '演示不存在');
    const filename = req.params.filename;
    if (!/^[a-f0-9]{64}\.(?:png|jpg|gif|webp|avif|bmp|ico|svg|woff|woff2|ttf|otf)$/.test(filename)) throw new ApiError(404, '资源不存在');
    const assetPath = path.join(demosDir, req.params.id, 'package', 'assets', filename);
    try {
      const index = JSON.parse(await readFile(path.join(demosDir, req.params.id, 'package', 'assets', 'index.json'), 'utf8'));
      const reference = index.entries.find(entry => entry.status === 'saved' && entry.filename === filename);
      if (!reference) throw new Error('missing');
      const info = await stat(assetPath);
      if (!info.isFile() || info.size !== reference.bytes) throw new Error('missing');
    }
    catch { throw new ApiError(404, '资源不存在'); }
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; script-src 'none'; sandbox");
    res.sendFile(assetPath);
  }));

  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api/')) res.sendFile(path.join(distDir, 'index.html'));
      else next();
    });
  }
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return;
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '演示文件超过 512 MB 上传上限' });
    if (error instanceof multer.MulterError) return res.status(400).json({ error: '上传文件无效' });
    if (error.code === '23505') return res.status(409).json({ error: '文件夹名称已存在' });
    if (error.code === '23503') return res.status(400).json({ error: '文件夹不存在' });
    if (error.code === '22P02') return res.status(404).json({ error: '记录不存在' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: '请求内容过大' });
    if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: '请求 JSON 无效' });
    const status = error.status && error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status === 500) console.error(error);
    res.status(status).json({ error: status === 500 ? '服务器处理失败，请稍后重试' : error.message });
  });
  return app;
}
