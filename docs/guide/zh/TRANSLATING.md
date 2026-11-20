# 翻译说明（Translating the guide）

`docs/guide/zh/` 是 `docs/guide/` 的简体中文版。The explorer (`tools/guide/site.mjs`) shows it
when the reader switches to 中文. This file holds the rules every zh page follows.

## Files

- One zh file per English file, same name: `docs/guide/store.md` → `docs/guide/zh/store.md`.
  `cli-routes.md` is generated and stays English only (the explorer shows the English page with a note).
- The first line of every zh file records the English version it was translated from:
  `<!-- source: <first 12 hex of sha256 of the English file> -->`
  (`shasum -a 256 docs/guide/store.md | cut -c1-12`). The explorer marks a zh page whose English
  has changed since, so it can be brought up to date.

## Structure (the explorer depends on it)

- **Keep every heading, in the same order, at the same level** (`#`…`######`), one zh heading per
  English heading, none added or removed. The explorer gives zh headings the English section ids
  by position, so `#store--backups-sqlite` opens the same section in both languages.
- Keep every table's columns and rows (same count, same order), every list item, every image and
  every link. Translate the words inside them.
- Links keep their English targets and anchors: `[备份](store.md#backups-sqlite)`.
  Images and English-only files are one folder up: `../img/store-overview.png`, `../cli-routes.md`.

- **Table headers use these exact words** (the explorer finds the call column and the "Where"
  column by them, and builds the By LayerFS call index from them):

  | English header | 中文 |
  |---|---|
  | # | # |
  | Component | 组件 |
  | What it shows | 显示内容 |
  | What it is | 说明 |
  | What it does | 作用 |
  | Interaction → result | 操作 → 结果 |
  | Interaction | 操作 |
  | LayerFS call / LayerFS call(s) | LayerFS 调用 |
  | States | 状态 |
  | Modal | 对话框 |
  | Opened by | 打开方式 |
  | Undo | 撤销 |
  | Where | 位置 |
  | Host route or op | 主机路由或 op |
  | Menu item | 菜单项 |
  | Result | 结果 |

  Any other header: translate it plainly.
- **LayerFS call cells:** keep every code span exactly. The marker `(read)` becomes `(读取)` with
  ASCII parentheses, and `(read, kept 1 min)` becomes `(读取，缓存 1 分钟)`: the explorer looks for
  `(读取` to tag reads. `—`, `↻`, `/` and the order of calls stay as they are.
- **Mermaid blocks:** keep the syntax, node ids and arrows; translate only the label text, and wrap a
  translated label in double quotes (`A["主页"]`) so CJK punctuation cannot break the parser.
- Keep the HTML comments of the English file out (only the `source` line is needed).

## Words

- 简体中文，平实、直接，用“你”。不要翻译腔，不要逐字直译；按中文习惯组织句子。
- **UI labels:** use the app's own zh label, then the English label in parentheses, because the
  screenshots show the English UI: **推送到…**（Push to…）. Find the zh label in the app's locale
  files: `grep -rn "'Push to…'" src/client/*/locale.ts` gives the key (`pushTo`), and the same key in
  the file's `zh` object is the zh label. If a label has no zh entry, keep the English in bold.
- **Never translate:** code spans (LayerFS calls like `store move`, routes, ops, file paths,
  identifiers), fixture names (`demo-starter`, `bookshelf`, `guide-notes`, `handbook`, `guide-box`,
  `guide-backups`), placeholders like `<store>` or `{name}`, keyboard keys.
- Paths: write them with the zh UI's words, e.g. `LayerFS › 主页 › Store › demo-starter › 备份`.

## Glossary (from the app's zh locale)

The app's own zh labels do not always agree with each other. Prose uses the word below (the one the
app uses most); a label quoted from the app stays exactly as the app writes it, even when it uses the
other word. The last column lists those known variants, so a reviewer does not "fix" them.

| English | 中文 | Quoted app labels that differ |
|---|---|---|
| Store, Sandbox, Workspace, Layer, Worker, Daemon, LayerFS, DSH, Center | 保留英文 | Store: setup and picker labels say 存储 (**新建存储**, **搜索项目或存储**); Sandbox: Presets says 沙盒; Worker: the Doctor fix says **重启工作进程** |
| Storage (the host's Storage view) | 存储 / 存储视图 | |
| project / project session | 项目 / 项目会话 | |
| DSH session / conversation | DSH 会话 / 对话 | |
| machine | 机器 | |
| Branch / Commit / checkpoint | 分支 / 提交 / 检查点 | |
| bucket / backup / restore | 存储桶 / 备份 / 恢复 | |
| Home (Center's first page) | 主页 | |
| LayerFS Home, the native machine: where a Store lives, a machine card, a location, "pull to home" | LayerFS Home（保留英文） | **拉回 Home**（Pull to home） |
| the LayerFS home as a whole: its records, runtime, machines, call log ("this LayerFS home") | LayerFS 主目录 / 此主目录 | |
| Overview / Files / History / Stats / Trajectory | 概览 / 文件 / 历史 / 统计 / 轨迹 | |
| Doctor / Logs / Presets / Settings | 诊断 / 日志 / 预设 / 设置 | Doctor: the Doctor page's title and a few of its sentences say 医生 (**此 LayerFS 还没有医生**) |
| needs-you notice | 待处理提示 | |
| refusal / refused | 拒绝 / 被拒绝 | |
| fix (a LayerFS fix line) | 修复 | |
| job | 任务 | |
| read (a view's read) | 读取 | |
| interaction | 操作 | |
| component | 组件 | |
| screenshot / callout | 截图 / 编号标注 | |
| scratch folder | 草稿目录 | **草稿：{folder}** |
