# DemoCenter API 约定

响应成功时返回 JSON。错误使用非 2xx 状态和 `{ "error": "可阅读的中文说明" }`。日期为 ISO 8601 字符串；可选值使用 `null`。

## 演示环境

`GET /api/environments` → `Environment[]`。

`POST /api/environments` → `Environment`；`PATCH /api/environments/:id` → `Environment`；`DELETE /api/environments/:id` → `{ok:true}`。

`Environment`: `{id,name,purpose,url,externalStatus,usageStatus,platform,cpuArchitecture,releaseAt,note,accounts,updatedAt}`。`externalStatus` 为 `public|internal`；`usageStatus` 为 `open|requestable|maintenance|occupied`，分别对应“公开”“可申请”“维护中”“占用中”。`platform` 为 `hci|virtualization|null`，分别显示“超融合”“虚拟化”“未指定”；`cpuArchitecture` 为 `X86|Hygon|Kunpeng|null`。既有环境的新字段默认为 `null`。`accounts` 为 `{label,username,password}[]`。

## 文件夹

`GET /api/demo-folders` → `DemoFolder[]`；`POST /api/demo-folders` 请求 `{name}`；`PATCH /api/demo-folders/:id` 请求 `{name}`；`DELETE /api/demo-folders/:id` 将演示移动到未分类。写操作返回对象或 `{ok:true}`。

`DemoFolder`: `{id,name,createdAt}`。仅一级，名称唯一。

## 互动演示

`GET /api/demos` → `DemoRecord[]`。前端自行按文件夹、搜索词筛选。

`POST /api/demos/inspect` 以 `multipart/form-data` 上传字段 `file`（`.smtxdemo`，上限 512,000,000 字节）→ `{uploadToken,sourceTitle,sourceDemoId,stepCount,assetStatus,sizeBytes,resourceIssueCount}`。上传后暂存，尚不发布。

`POST /api/demos` 使用 JSON `{uploadToken,title,description,productVersion,tags,uploader,folderId}` → `DemoRecord`。标题必填，其余展示字段可为空；同一源演示可重复上传，生成不同站点 ID。

`PATCH /api/demos/:id` 使用 JSON `{title?,description?,productVersion?,tags?,uploader?,folderId?}` → `DemoRecord`；`DELETE /api/demos/:id` → `{ok:true}`。

`DemoRecord`: `{id,sourceDemoId,title,description,productVersion,tags,uploader,folderId,uploadedAt,stepCount,assetStatus,resourceIssueCount}`。`assetStatus` 为 `complete|partial|legacy|no-candidates`。

`GET /api/demos/:id/steps` → `Step[]`，用于详情页轻量展示互动步骤。

`GET /api/demos/:id/playback` → `{manifest,steps,events,assets,assetStatus,resourceIssueCount}`；其中 `manifest/steps/events/assets` 沿用录制器的同名模型，`assets` 可为 `null`。资源状态用于播放器明确提示部分资源缺失。`GET /api/demos/:id/assets/:filename` 返回已导入的资源文件。

## 演示包

`.smtxdemo` 是 ZIP，根目录含 `package-manifest.json`（`packageFormatVersion:1`、`demoId`、`exportedAt`）、`manifest.json`、`steps.json`、`events/*.json`，可含 `assets/index.json` 与资源文件。只接受已完成、至少一个热点和有效事件的包。资源缺失可导入并标记 `partial`；拒绝越界路径、损坏 ZIP、未知包版本及超过上传上限的文件。
