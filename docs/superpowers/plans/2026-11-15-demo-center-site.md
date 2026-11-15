# DemoCenter Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可在内网用 Docker Compose 部署的 DemoCenter，集中管理演示环境并上传、分类、播放互动演示。

**Architecture:** 独立的 `democenter/` 应用提供 React 前端与 Node API。PostgreSQL 保存环境、文件夹和演示展示信息；演示包解出的事件与资源保存在持久化目录。网页播放器复用现有录制模型与热点回放规则。

**Tech Stack:** React 19, TypeScript, Vite, Express 5, PostgreSQL 16, `yauzl`, rrweb 2.1.6, Docker Compose.

**Spec:** [DemoCenter 第一版设计](../specs/2026-11-14-demo-center-design.md)。

## Global Constraints

- 内网访问；不做登录、审批、角色或审计。所有同事可修改环境与演示。
- 环境保留独立的“对外展示”与“使用状态”字段，不记录占用人。
- 互动演示初始为空；一级文件夹，内置入口只有“全部演示”“未分类”。
- 上传 `.smtxdemo` 单演示 ZIP；只发布已完成且有热点和有效事件的演示；默认上限 512 MB。
- 播放器通过热点继续，不触发原平台操作；支持从头播放、全屏、关闭/1/2/3 秒过渡加速。
- 应用与 PostgreSQL 均由 Compose 管理；数据库和演示文件分别持久化。

## Review Focus

- 损坏或路径越界 ZIP 被拒绝，不能写到演示目录以外（服务端包校验测试）。
- 两人先后编辑同一环境，列表展示最后成功写入值（API 集成测试）。
- 删除非空文件夹将演示移至“未分类”，文件可继续播放（API 集成测试）。
- 上传资源缺失的包显示警告，但有效热点仍可播放（导入与播放器测试）。
- 错误点击不能推进热点，正确点击后才能继续（浏览器播放器测试）。

---

### Task 1: 服务端存储与导入

**Files:** `democenter/server/**`, `democenter/tests/**`.

**Interfaces:** 按 `democenter/contract.md` 提供 `/api/environments`、`/api/demo-folders`、`/api/demos`、`/api/demos/:id/playback` 和资源地址。

- [x] 编写包校验与演示导入 API 测试；在浏览器中验证环境 CRUD 与非空文件夹删除迁移。
- [x] 实现 PostgreSQL schema、API、ZIP 安全导入、临时上传与原子发布。
- [x] 运行 `npm test`，9 项测试通过。

### Task 2: 工作台和互动播放器

**Files:** `democenter/src/**`, `democenter/index.html`, `democenter/vite.config.ts`, `democenter/tsconfig.json`.

**Interfaces:** 消费 Task 1 API；录制模型沿用 `src/model.ts`、`src/core.ts` 与 `src/asset-refs.ts`。

- [x] 实现环境列表/详情/编辑，保留两个状态字段和可见/复制凭据。
- [x] 实现一级文件夹、素材库搜索、演示展示信息、上传预检与发布。
- [x] 实现独立 rrweb 播放器；热点暂停、错误点击提示、正确点击继续；加速、重播、全屏。
- [x] 运行 `npm run typecheck`、`npm run build`，确认通过。

### Task 3: 容器部署与联调

**Files:** `democenter/Dockerfile`, `democenter/compose.yaml`, `democenter/README.md`, `.dockerignore`.

- [x] 验证 `docker compose config --quiet`。
- [x] 完成启动、升级、备份恢复说明。
- [x] 构建镜像并启动 Compose，验证健康检查与空库首页。
- [x] 导入测试 `.smtxdemo`，验证上传、播放、删除、容器重建后持久化。

### Task 4: 整体审查

- [x] 运行网站和原扩展的测试与构建。
- [x] 审查 API、前端与部署文件的边界和错误处理，修复发现的问题。
- [x] 核对设计说明中的第一版验收标准与实际功能：网站功能已验证；录制器 `.smtxdemo` 导出和备份恢复演练尚待后续工作。
