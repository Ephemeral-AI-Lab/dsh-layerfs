<!-- source: 054e91f58510 -->
# 编写和更新界面指南

这份指南逐页讲解 dsh-layerfs 的界面：每一页是做什么用的，页上每个组件显示什么，每个操作会做什么，
以及背后运行的是哪个 LayerFS CLI 调用。本文件是每一页都要遵循的模板和规则。

## 文件

```
docs/guide/
  README.md          指南的入口页：全局地图
  <page>.md          界面的一页（home、store、project、machine、…）
  components.md      多个页面共用的部件，只讲一次
  cli-map.md         每个操作 → 主机路由 → LayerFS 调用
  cli-routes.md      自动生成：每个主机路由 → LayerFS 调用
  img/<page>-<what>.png
tools/guide/
  shoot.mjs          截图运行器
  shots/<page>.mjs   每页一个截图模块
  cli-map.mjs        生成 cli-routes.md
  calls.mjs          在开发服务器上运行主机操作（示例数据）
  fixture-session.mjs  一个带少量 LayerFS 写入的项目对话
```

## 用词

- 用界面自己的词，和英文 locale 里写的完全一致（`src/client/**/locale.ts`）。
  按钮和菜单项用 **粗体**，页面名和标签页名照界面上的写。
- 位置写成路径：`LayerFS › Store › demo-starter › 备份`。菜单：`⋯ › 备份到…`。
  DSH 没有 URL，路径就是读者找到一个地方的方式。
- Center 的第一页在界面里叫 **主页**（Home）。指南自己的入口页是 README，永远不叫“主页”。
- 讲用户体验，不讲代码：读者看到什么、它为什么在那里、按下去会发生什么、各种状态是什么意思、
  控件禁用时该怎么办。源文件只放在每页的最后一节。

## 一页的结构

```markdown
# <Page name>

> **Where:** `LayerFS › …` · **Opens from:** … · **Source:** see the end

One or two sentences: what this page is for and when you come here.

![<Page>, numbered](img/<page>-overview.png)

| # | Component | What it is |
|---|---|---|
| 1 | Nav bar | [Components › Nav bar](components.md#nav-bar) |
| 2 | … | … |

## Layout
Header, tab bar, body: one short paragraph.

## <Tab name>            (one section per tab; a page without tabs has one "Body" section)
![…](img/<page>-<tab>.png)

What the tab answers, in a sentence or two.

| Component | What it shows | Interaction → result | LayerFS call | States |
|---|---|---|---|---|
| Store card | … | **Open** → the Store page | `store list` (read) | loading, broken, needs you |
| | | **⋯ › Compact** → confirm → a job card | `store compact` | disabled while a job runs |

## Variants
SQLite vs PostgreSQL, macOS native vs Docker/Lima, tabs that only show sometimes: what changes and why.

## Modals opened here
| Modal | Opened by | What it does | LayerFS call | Undo |
|---|---|---|---|---|

## States and signals
What a disabled control, a notice or a badge on this page means, and what to do.

## Where next
Links to the pages this one leads to.

## Source
`src/client/…` files this page describes.
```

## LayerFS 调用列

- 调用写简短形式：`store move`。只有在读者可能会照着输入的正文里，才写完整形式
  （`layerfs store move <store> <machine>`）。
- **多个调用：** 写清楚（`machine stop`，然后 `machine start`；经由 native 执行 `store move` ×2）。
- **读取：** 视图为了画出自己而做的读取，标上“(read)”（中文页写作 `(读取)`）。写入不加标记。
- **没有调用：** 写 `—`，并说明原因（主机内存、本地视图状态、记住的标签页）。
- **密钥：** 密码和存储桶密钥通过 stdin 交给 LayerFS；示例里永远不要出现。
- 找调用的方法：顺着客户端的 `api.call(method, path)` 或 `api.op(name)` 找到主机路由
  （`src/host/routes/router.ts`、`cli-routes.md`）或操作（`src/host/**`），再从处理函数找到它的
  `lfs.<family>.<call>(` 调用。日志页会列出一次点击实际运行了哪些调用，并标出所属会话：用它来核对。
- 每个操作也要写进 [cli-map.md](cli-map.md)。

## 截图

- 用 `tools/guide/shoot.mjs` 在开发服务器上截图，不要手动截，也不要在 3080 上截：
  ```bash
  DSH_LAYERFS_DEV_DIR=$PWD/.dev-guide node tools/guide/shoot.mjs tools/guide/shots/store.mjs
  ```
- 默认 1440×900、2 倍分辨率，除非某张截图需要别的尺寸。整页没有额外信息时，用 `clip` 裁到组件本身；
  编号标注按页面主表格的顺序编号。
- 手机布局和桌面不同的页面还要一张手机截图：390×844、2 倍分辨率。先改文字、手机截图稍后补时，
  指南用正文描述手机上的行为；补这张图不需要重截其他页面的图。
- 图片命名为 `<page>-<what>.png`。截图通过后，删掉 `img/_failed-*.png`。
- 示例数据：Starter 预设的 Store `demo-starter`（项目 `bookshelf`，Docker 机器上的 Sandbox
  `guide-box`）、native 上的 Store `guide-notes`（项目 `handbook`，以及由 `fixture-session.mjs` 生成的
  一个项目对话），还有存储桶 `guide-backups`（一个本地 MinIO），里面有 `guide-notes` 的一份备份。
- 截图里永远不能出现密钥、token 或带认证的 URL。

## 重建示例数据

截图需要上面描述的示例数据，跑在一个使用无密钥脚本模型的私有开发服务器上。从零开始搭建：

1. 用独立的主目录启动一个旁路服务器（这里用 3097 端口；绝不用 3080）：
   ```bash
   DSH_LAYERFS_DEV_DIR=$PWD/.dev-guide DSH_LAYERFS_DEV_OVERLAY=<a copy of dev/fake-llm.overlay.yml naming this checkout's dev/fake-llm/index.js> node scripts/dev.mjs --port 3097
   ```
2. 在预设对话框里构建 Starter 预设（主页 › **试用预设**（Try a preset）› **入门**（Starter）），或者用
   `GET /api/demo-presets/quickstart/build-plan` 读出它的计划，再通过 `tools/guide/calls.mjs` 提交到
   `/api/demo-presets/quickstart/environment-reset`。
3. 通过 `tools/guide/calls.mjs`：
   - 创建 Sandbox `guide-box`（`POST /api/projects/demo-starter%2Fbookshelf/sandboxes`）；
   - 创建 Store `guide-notes`（`POST /api/stores`）及其项目 `handbook`（带 `source` 文件夹的 `POST /api/projects`）；
   - 把一个本地 MinIO 存储桶连接为 `guide-backups`（`POST /api/buckets`，用你自己生成的测试密钥）；
   - 把 `guide-notes` 备份到它（`POST /api/stores/guide-notes/backup`）。
4. `node tools/guide/fixture-session.mjs guide-notes/handbook` 生成项目对话。把它打印出来的会话 id
   填进用到会话 id 的截图模块（`readme.mjs`、`conversation.mjs`）。
5. 在 Sandbox 页的 **新建 Workspace**（New workspace）表单里，在 `guide-box` 中把 Workspace `guide-ws`
   挂载到一个旁支上，并在里面运行一条只读命令。

完成后，停掉开发主目录的 Docker 机器（用那个主目录的 `LAYERFS_HOME` 和 `LAYERFS_BUNDLE` 运行
`layerfs machine stop docker`）、MinIO 容器和旁路服务器。

## 更新

界面变了的时候：重新运行该页的截图模块，更新它的表格，重新生成 `cli-routes.md`
（`node tools/guide/cli-map.mjs`），并核对 `cli-map.md`。
