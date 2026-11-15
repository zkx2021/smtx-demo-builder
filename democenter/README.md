# DemoCenter

DemoCenter 是部署在公司内网的演示工作网站，提供演示环境信息管理、一级文件夹，以及 SMTX Demo Builder 互动演示的上传与热点播放。首页不预置演示数据。第一版不包含账号登录、审批或审计；访问该网站的同事均可修改内容。

## 启动

需要 Docker Engine 和 Docker Compose。复制 `.env.example` 为 `.env`，按需修改访问端口和数据库密码，然后在 `democenter` 目录运行：

```powershell
docker compose up -d --build
```

打开 `http://<服务器地址>:8080`；如果修改了 `DEMO_CENTER_PORT`，使用对应端口。`docker compose ps` 可查看应用与数据库状态，`docker compose logs -f app` 可查看应用日志。上传文件上限为 512 MB。网站第一次启动时自动初始化数据表。

## 使用

### 演示环境

在“DemoCenter 环境”中新增环境，填写名称、用途、入口地址、对外展示状态、使用状态、预计释放时间、备注和一条或多条访问凭据。列表可搜索和筛选；选择环境后在右侧查看、编辑或删除。密码默认遮盖，可手动显示或复制。“公开”表示当前可供同事使用，是否适合对外展示由独立的“对外展示”字段决定。

### 互动 Demo

在“互动 Demo”中先创建需要的一级文件夹，再选择“上传演示”。选择 SMTX Demo Builder 导出的单条 `.smtxdemo` 文件，等待格式与资源检查结果，填写展示信息并发布。上传不会覆盖同一源演示的旧记录。已发布的演示可搜索、移动文件夹、编辑展示信息、播放或删除。删除文件夹时，其中的演示移到“未分类”。

播放器播放到交互步骤时暂停；点击画面中的热点才继续。顶部提供从头播放、全屏、过渡加速（关闭、1 秒、2 秒、3 秒）。播放器展示录制快照，不会再次向原管理平台提交操作。资源不完整的演示会显示提示，实际画面仍以播放结果为准。

## 数据与维护

Compose 使用两个持久化卷：`postgres_data` 保存环境、文件夹和展示信息，`demo_files` 保存演示事件和资源。更新应用时运行 `docker compose up -d --build`，不要使用 `docker compose down -v`，后者会移除持久化卷。

备份需要同时覆盖 PostgreSQL 数据库与 `demo_files` 卷；只备份其中一项无法完整恢复演示。建议暂停上传与编辑后执行备份，定期在测试环境演练恢复。数据库可用 `pg_dump -U democenter democenter` 导出；演示文件可从应用容器的 `/data/demos` 目录归档。恢复时先恢复数据库和文件卷，再启动应用并检查演示列表与播放器。

## 本地开发

在 `democenter` 目录执行 `npm ci`。网站开发服务为 `npm run dev`，API 服务为 `npm run dev:server`；API 需要可访问的 PostgreSQL 和 `DATABASE_URL`、`DATA_DIR` 环境变量。验证命令为 `npm test`、`npm run typecheck`、`npm run build`。Docker Compose 是第一版的部署目标。

## 已知边界

- 网站只接受 `.smtxdemo` 单演示包；旧版扩展安装 ZIP、任意网页地址和视频文件不能上传。
- 录制器的 `.smtxdemo` 导出功能尚在后续实现计划中；网站可先用符合包约定的测试文件验证导入。
- VNC 新标签页录制、网站内录制和热点编辑、PPT 加载项不属于第一版。
