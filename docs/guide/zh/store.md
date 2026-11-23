<!-- source: 9bede6dbce27 -->
# Store

> **位置：** `LayerFS › 主页 › Store › <store>` · **打开方式：** 主页 › Store 或某台机器的 Store 标签页上 Store 卡片的名称、导航栏的层级切换器、跳转到、项目页上的 Store 链接、存储桶的关联 Store · **源码：** 见文末

Store 是存放项目的数据库：某台机器上的一个 SQLite 文件，或者某台服务器上的一个 PostgreSQL
数据库。这一页回答“它有多大、里面有什么、谁在用、有没有备份（或者能不能连上）”，并且汇集了
所有针对整个 Store 的操作：推送、拉回、迁移、备份、压缩、移除（SQLite），或者检查、更换登录、
断开连接（PostgreSQL）。

![demo-starter 的 Store 页（带编号）](../img/store-overview.png)

| # | 组件 | 说明 |
|---|---|---|
| 1 | 导航栏 | [组件 › 导航栏](components.md#nav-bar)：`主页 › Store › demo-starter`；最后一级的切换器列出所有 Store |
| 2 | 头部 | Store 的图标、名称、未就绪时的状态标签，以及它的类型和所在位置（点 **docker** 打开那台机器） |
| 3 | **检查完整性**（Check integrity） | 对 Store 运行诊断，并打开诊断页 |
| 4 | ⋯ | Store 菜单：[组件 › Store 菜单](components.md#store-menu) |
| 5 | 标签页 | **概览**（Overview）· **项目**（Projects）*n* · **备份**（Backups）*n*（SQLite）或 **连接**（Connection）（PostgreSQL） |
| 6 | 磁贴 | 数据库文件（或服务器）、项目及其提交数、正在运行、上次备份（或连接自） |
| 7 | 数据库文件的构成 | 内容、元数据和空闲页，以及压缩比 |
| 8 | 由哪些项目写入 | 每个项目在打包字节中的占比 |
| 9 | 健康状况 | 机器、备份和空闲页（PostgreSQL：服务器和备份） |
| 10 | Store 详情 | 默认折叠：创建时间、文件大小或服务器，以及 **移除…**（Remove…）/ **断开连接…**（Disconnect…） |

## 布局

头部（名称、类型、位置、**检查完整性**（Check integrity）、⋯）下面有两条按需出现的横栏：Store
需要你处理时的红色提示，以及迁移、备份、恢复或压缩正在进行（或刚结束）时的
[任务卡片](components.md#job-card)。再往下是三个标签页；页面会按 Store 记住你上次选的标签。

页面会在每次 `storage` 事件、每次操作之后，以及页面可见时每 15 秒，重新读取存储视图
（`GET /api/storage`：`home get`、`project list`、`store auths`、`store list`）。各标签页自己的读取
（`store get --with stats`、项目账本）会在 `storage`、`storage-job` 和 Workspace 事件时刷新，合并为
每 2 秒最多一次。

## 头部与提示

| 组件 | 显示内容 | 操作 → 结果 | LayerFS 调用 | 状态 |
|---|---|---|---|---|
| 头部 | 图标、名称、状态标签（**忙碌**（Busy）、**受阻**（Blocked）、**损坏**（Broken）、**未知**（Unknown）；就绪时不显示）、**SQLite** · 位置，或 **PostgreSQL** · `host:port/db` | 点机器名 → 那台机器的页面 | `store list` (读取) | 忙碌时标签会闪烁 |
| **检查完整性**（Check integrity） | Store 的诊断 | 按下 → 开始一次诊断，并打开显示结果的诊断页 | `store doctor` | 正在交接这次运行时不可用 |
| **测试连接**（Test connection）（PostgreSQL） | 同一个诊断，只是以连接来命名 | 按下 → 同上 | `store doctor` | |
| ⋯ | [Store 菜单](components.md#store-menu) | 见下文 [Store 菜单](#store-menu) | 各行不同 | Store 未就绪时各行禁用 |
| 待处理提示 | 状态词及原因：**已损坏 · …**（Broken · …）、**等待 docker**（Waiting on docker）、**docker 已停止。**（docker is stopped.）、**已阻塞 · docker 已损坏**（Blocked · docker broken）；悬停显示 LayerFS 的原句 | 旁边唯一的操作：**启动 docker**（Start docker）（机器已停止时）、Store 的[修复按钮](components.md#fix-buttons)，或 **修复 docker**（Repair docker）（打开损坏的机器） | `machine start`，或修复本身的调用 | Store 就绪且机器在运行时隐藏 |
| 任务卡片 | 这个 Store 上正在运行或刚结束的任务 | [组件 › 任务卡片](components.md#job-card)：**重试**（Retry，迁移的推送半程失败时为 **重试推送**，Retry push）、**关闭**（Dismiss）、**打开**（Open）*Sandbox* | 见任务卡片 | 成功后保留一分钟，失败后保留到你关闭为止 |
| 其他客户端的操作 | **另一个客户端正在此 Store 上运行** *op*（Another client runs *op* on this Store） | — | `store list` (读取：其 `op`) | 只在另一个进程占用这个 Store 时出现 |
| 标签页 | **概览**（Overview）、**项目**（Projects）*n*、**备份**（Backups）*n* / **连接**（Connection） | 点击 → 该标签页 | —（标签页记在浏览器里） | |

## 概览

![概览](../img/store-overview.png)

Store 有多大、是谁写的、有没有需要你留意的地方。

| 组件 | 显示内容 | 操作 → 结果 | LayerFS 调用 | 状态 |
|---|---|---|---|---|
| **数据库文件**（Database file）磁贴（SQLite） | 文件大小；机器没有响应时显示 **大小读取于** *时间*（size seen *when*） | — | `store list` (读取) | **大小未知**（Size unavailable） |
| **服务器**（Server）磁贴（PostgreSQL） | **可连接**（Reachable）、**无法连接**（Unreachable，附原因）或 **未知**（Unknown）；悬停显示修复行 | — | `store list` (读取) | 损坏时为红色 |
| **项目**（Projects）磁贴 | 项目数和 **n 次提交**（n commits）（账本统计中时为 **已统计 n 次提交**（n commits so far）） | 点击 → 项目标签页 | `project list`、`project stats`、`branch get` (读取) | Store 拒绝时显示 **未读取：…**（Not read: …） |
| **正在运行**（Running now）磁贴 | 这个 Store 的项目中 daemon 正在运行的 Sandbox | — | `machine list`、`sandbox list` (读取，`GET /api/machines`) | |
| **上次备份**（Last backup）磁贴（SQLite） | 最近一次有时间记录的副本距今多久及其对应存储桶；若无时间戳则显示已知状态 | 点击 → 备份标签页 | `store list` (读取：其链接)、`backup list` (读取) | 未关联备份时显示灰色 **尚未备份**（No backup yet） |
| **连接自**（Connected from）磁贴（PostgreSQL） | 有几台机器连接，以及它们的名称 | 点击 → 连接标签页 | `store list` (读取：`connections`) | |
| 数据库文件的构成 | 一条堆叠构成条，展示 **内容**（Content）、**元数据**（Metadata，采用中性蓝灰，不用警告橙）和 **空闲页**（Free pages），宽分段直接在条内标出名称与占比、下方列出详细大小，0 字节分段不在条内占位；**唯一内容** *x* **打包为** *y*（Unique content *x* packs into *y*）以及 **×** 比例 | 悬停 → 分段详情与联动高亮 | `store get --with stats` (读取) | **读取中…**（Reading…）、**未读取：…**（Not read: …）、**LayerFS 未报告此 Store 的构成。**（LayerFS did not report this Store's parts.） |
| Store 的增长 | 文件、内容和元数据在本机过去各次读取中的变化；间隔超过日志记录间隔的地方显示为断开 | — | —（本机对早先 `store get --with stats` 读取的记录） | 至少记录过一次读取后才显示；**图表从本机对此 Store 的读取开始：目前只有一次。**（The chart starts with this host's reads of the Store: one so far.） |
| 由哪些项目写入 | 纵向列表，展示每个项目的打包字节与占比；没有被任何提交计入的字节归为 **初始化及更早**（Init and earlier） | — | `project stats` (读取)、`store get --with stats` (读取) | **还没有项目提交内容。**（No project has committed content yet.） |
| 健康状况 | **机器**（Machine）（*docker* **正在运行**（is running）/ 已停止）、**备份**（Backups）（仅全部副本核验最新时亮绿点 **已是最新**；落后副本只用自身时间并标明桶名显示灰色 **自上次备份后已更改**、**桶已更改**、**未检查**、**未列出** 或 **尚未备份**；仅 **缺失** / **两侧均已更改** 标红）、**空闲页**（Free pages）（可重用的比例）；PostgreSQL：**服务器**（Server）、**备份**（Backups）**由服务器自身的备份负责，而非 LayerFS**（covered by the server's own backups, not LayerFS） | — | 来自上面的读取 | 绿、灰、红色圆点 |
| Store 详情 | **创建时间**（Created）、**数据库文件**（Database file）或 **服务器**（Server）；然后是 **移除 Store**（Remove Store）/ **断开 Store**（Disconnect Store） | **移除…**（Remove…）→ [输入名称确认](#modals-opened-here)；**断开连接…**（Disconnect…）→ 确认 | `store remove` ↻ / `store disconnect` ↻ | 默认折叠 |

![展开的 Store 详情](../img/store-details.png)

## 项目

![项目](../img/store-projects.png)

Store 里的所有项目，和主页 › 项目里的表格一样，只是少了 Store 这一列。

| # | 组件 | 显示内容 | 操作 → 结果 | LayerFS 调用 | 状态 |
|---|---|---|---|---|---|
| | 摘要 | **n 次提交 · 大小 · n 个运行中**（n commits · size · n running） | — | `project stats` (读取) | |
| | 搜索 | 按名称筛选行 | 输入；Escape 清空 | — | 项目超过四个时才出现 |
| 1 | **添加项目**（Add project） | | 按下 → [添加项目](#modals-opened-here) | `project init` | Store 未就绪时不可用 |
| 2 | 项目表 | 每个项目：名称及 **n 个运行中**（n running）、最新一条提交、**会话**（Sessions）、**Sandbox**（Sandboxes）、**最近会话**（Last session）、**最近提交**（Last commit）、**提交**（Commits）、**分支**（Branches）、**大小**（Size），附一条表示其在 Store 中占比的横条 | 点列标题排序（有会话运行时，最近会话一列保持不动）；箭头展开该行的会话或 Sandbox；点名称打开项目页；点 Sandbox 打开它的页面 | `project list`、`project stats`、`branch get` (读取)；会话来自这个 DSH（无调用）；Sandbox 来自 `sandbox list` (读取) | 账本读完之前，行里先不显示数字；**还没有项目**（No projects yet）、**没有匹配的项目**（No matching projects） |

## 备份（SQLite）

![备份](../img/store-backups.png)

这个 Store 的副本存在哪里、每份有多新，以及刷新或恢复某一份的按钮。打开此标签页时，会自动对尚未列出且未报错的关联存储桶执行一次列出。

| # | 组件 | 显示内容 | 操作 → 结果 | LayerFS 调用 | 状态 |
|---|---|---|---|---|---|
| | 数量 | **n 个备份目标**（n destination(s)） | — | — | |
| 1 | **备份到…**（Back up to…） | | 按下 → [备份](#modals-opened-here)（还没有存储桶时：**添加存储桶…**（Add bucket…）→ 添加存储桶，然后备份） | `backup create` | 未就绪时不可用（悬停说明原因） |
| 2 | 备份目标卡片 | 服务商图标、可点击的存储桶名、可点击的文件名（已列出且未缺失时）、**上次保存**（Last saved）、**大小**（Size）、**服务商**（Provider）（**MinIO**、**Cloudflare R2**） | 点击存储桶 → [存储桶页](bucket.md)；点击文件 → 备份文件页 | `store list` (读取：链接)，以及该存储桶最近一次 `backup list` | **尚未配置备份目标。**（No backup destinations configured.） |
| 3 | 状态标签 | **已备份**（Backed up）、**Store 已更改**（Store changed）、**存储桶已更改**（Bucket changed）、**双方都已更改**（Both changed）、**缺失**（Missing）、**未检查**（Not checked）、虚线 **未列出**（Not listed），或列表失败（**未列出 · 密钥被拒绝**等）——与存储桶页用词完全相同；悬停显示 LayerFS 的原句 | — | `backup list` (读取) | 列出前显示虚线 **未列出**；列表失败时显示红色标签 |
| 4 | 主备份 / 恢复动作 | **立即备份**（Back up now，最新、Store 已更改或未列出时）、**另存为新文件…**（Back up as new file…，**缺失**、**双方都已更改**、**存储桶已更改** 时），或 **重新连接…**（Connect again…，密钥被拒时） | **立即备份** → 立即开始一个备份任务；**另存为新文件…** → 打开[备份](#modals-opened-here)并预填新文件名；**重新连接…** → 重新连接存储桶 | `backup create`，然后 `backup list` | 未就绪时不可用（悬停说明原因） |
| 5 | **恢复…**（Restore…） | | 按下 → 针对这个文件打开[恢复](#modals-opened-here) | `backup restore`，然后 `backup list` | **缺失** 时隐藏；存储桶未列出时禁用并说明需先列出；忙碌时不可用 |
| | **列出存储桶** / **重新列出**（List the bucket / List again） | | 按下 → 立即列出该存储桶 | `backup list` (读取) | 列出时显示加载圆点 |

## 连接（PostgreSQL）

示例数据里没有 PostgreSQL Store，所以这个标签页是根据代码描述的。

两张卡片。**数据库**（Database）：服务器和数据库（`host:port/db`）、**登录**（Login）（已保存的登录，或
**没有已保存的登录**（No saved login））、**ID**（Id，LayerFS 识别它所用的数据库 id）、**synchronous_commit**
（或 **数据库默认值**（Database default）），以及一条状态行（圆点、状态、**检查于** *时间*（checked *when*）、
PostgreSQL 版本和 **可连接 · n 毫秒**（Reachable · n ms））。**机器**（Machines）：每个连接方一行，
**这台电脑**（This computer）排在最前，每行显示 **专属地址**（own address）或 **默认地址**（default address）、
最近一次连通情况及时间、它在这个 Store 上的 Sandbox，以及几个按钮。

| 组件 | 显示内容 | 操作 → 结果 | LayerFS 调用 | 状态 |
|---|---|---|---|---|
| 数据库卡片 | 服务器、登录、id、synchronous_commit、最近一次检查 | — | `store list` (读取)、`store auths` (读取) | 损坏时为红色，并带修复按钮 |
| **更换登录…**（Change login…） | | 按下 → [编辑连接](#modals-opened-here)；Store 没有指定已保存的登录时打开[保存登录](#modals-opened-here) | `store update`、`store save-auth`、`store connect` | |
| **检查**（Check）（数据库） | | 按下 → 打开[连接数据库](#modals-opened-here)的检查界面，从这台电脑检查；在按下那个具名的 **从 … 检查 …**（Check … from …）之前什么都不会运行 | `store doctor --machine`，然后 `store get` | |
| 机器行 | 机器、**专属地址**（own address）/ **默认地址**（default address）、连通圆点（**可连接 · n 毫秒**（Reachable · n ms）、**可访问**（reached）、**检查失败**（check failed）、**未检查**（not checked））、时间、**n 个 Sandbox**（n Sandboxes） | — | `store list` (读取：`connections`) | 机器损坏或最近一次检查失败时为红点 |
| **检查**（Check）（行） | | 按下 → 检查界面，从那台机器检查 | `store doctor --machine` | |
| **编辑**（Edit）（行） | | 按下 → 那台机器的专属连接 | `store connect --machine`（LayerFS 会先从那台机器检查） | 只对有专属地址的机器出现 |
| **忘记**（Forget）（行） | | 按下 → 确认 **移除** *机器* **到** *store* **的专属连接？**（Remove *machine*'s own connection to *store*?） | `store disconnect --machine` ↻ | 只对有专属地址或有检查记录的机器出现 |
| **连接一台机器**（Connect a machine） | | 按下 → 检查界面，从第一台还没连接的运行中机器检查（没有的话从这台电脑） | `store doctor --machine` | |

## Store 菜单

头部（以及每张 Store 卡片）上的 ⋯ 汇集了所有针对整个 Store 的操作。完整的组件说明见
[组件 › Store 菜单](components.md#store-menu)。

| 机器上的 SQLite | LayerFS Home 中的 SQLite |
|---|---|
| ![docker 上 demo-starter 的菜单](../img/store-menu-machine.png) | ![LayerFS Home 中 guide-notes 的菜单](../img/store-menu-home.png) |

| 菜单行 | 显示于 | 操作 → 结果 | LayerFS 调用 | 禁用条件 |
|---|---|---|---|---|
| **推送到…**（Push to…） | LayerFS Home 中的 SQLite | [推送](#modals-opened-here) → 任务卡片 | `store move <store> <machine>` | 未就绪 |
| **拉回 Home**（Pull to home） | 机器上的 SQLite | 立即开始一个拉回任务 | `store get`，然后 `store move <store> native` | 未就绪 |
| **迁移到其他机器…**（Move to another machine…） | 机器上的 SQLite | [迁移](#modals-opened-here) → 任务卡片 | `store get`，然后经由 native 执行 `store move` ×2 | 未就绪 |
| **备份到…**（Back up to…） | SQLite | [备份](#modals-opened-here)（没有存储桶时先添加存储桶） | `backup create`，然后 `backup list` | 未就绪 |
| **立即备份 · *存储桶*/*文件***（Back up now · *bucket*/*file*） | SQLite，每个关联的存储桶一行 | 立即开始一个备份任务 | `backup create`，然后 `backup list` | 未就绪 |
| **压缩…**（Compact…） | 两种都有，前提是 LayerFS 运行时支持 `store compact` | [确认](#modals-opened-here) → 任务卡片 | `store get`，然后 `store compact` | 未就绪（提示：**请先启动机器** *m*（Start machine *m* first）、**请先修复机器** *m*（Repair machine *m* first）、**Store 当前未就绪**（The Store is not ready））；Store 损坏且修复方式就是压缩时仍然提供 |
| **移除…**（Remove…） | SQLite | [输入名称确认](#modals-opened-here) | `store remove` ↻ | 从不 |
| **检查**（Check） | PostgreSQL | 从这台电脑打开检查界面（在机器页上：从那台机器） | `store doctor --machine` | |
| **更换登录…**（Change login…） | PostgreSQL | 编辑连接 / 保存登录 | `store update` / `store save-auth` | |
| **断开** *机器*（Disconnect *machine*） | PostgreSQL，每台有专属地址的机器一行 | 确认 → 那台机器重新使用 Store 的默认地址 | `store disconnect --machine` ↻ | |
| **断开连接…**（Disconnect…） | PostgreSQL | 确认（无需输入名称）→ 主目录忘掉这个 Store；数据库本身保留 | `store disconnect` ↻ | 从不 |

## 机器 › Store 标签页

`LayerFS › 主页 › 机器 › <machine> › Store` 是单台机器的 Store 面板；主页 › Store 是所有 Store 的
同一个面板。机器页本身见 [machine.md](machine.md)。

![docker › Store（带编号）](../img/store-machine-board.png)

| # | 组件 | 显示内容 | 操作 → 结果 | LayerFS 调用 | 状态 |
|---|---|---|---|---|---|
| 1 | 类型切换 | **SQLite** *n* **个 Store · 大小**（Stores · size）和 **PostgreSQL** *n* **个数据库**（databases）；悬停显示说明（**Store 文件位于 docker 的磁盘上。拉回可将其带回 LayerFS Home。**（The Store file lives on docker's disk. Pull brings it back to the LayerFS Home.）） | 点击或 ←/→ → 切换到该类型 | —（按机器记在浏览器里） | 机器不能存放的类型会在悬停时说明原因 |
| 2 | **推送 Store 到这里**（Push a Store here）（SQLite；在 LayerFS Home 上为 **添加 Store**（Add Store）） | | 按下 → [向 *机器* 添加 Store](#modals-opened-here) | `store move`（推送、拉回，或先拉回再推送） | 机器不能存放 SQLite Store 时通过 `ExplainedButton` 禁用并说明原因（**此机器无法存放 SQLite Store。**，This machine cannot hold SQLite Stores.） |
| 2 | **连接数据库**（Connect a database）（PostgreSQL） | | 按下 → [在 *机器* 上连接数据库](#modals-opened-here) | `store connect`，然后 `store doctor --machine` | |
| 3 | Store 卡片 | [组件 › Store 卡片](components.md#store-card) | 名称 → Store 页；⋯ → Store 菜单；**拉回**（Pull）/ **推送到…**（Push to…） | `store move` | |
| | 空状态行 | **docker 上没有 SQLite Store。推送一个到这里，即可在此运行其 Sandbox。**（No SQLite Store is on docker. Push one here to run its Sandboxes on it.；LayerFS Home 上为 **LayerFS Home 中没有 SQLite Store。可新建一个，或从其他机器拉回。**，No SQLite Store is in LayerFS Home. Create one or pull one back from a machine.）/ **没有 PostgreSQL Store 运行于 docker。连接一个数据库，即可在此运行其会话。**（No PostgreSQL Store runs on docker. Connect a database to run its sessions here.） | — | — | |

主页 › Store 上的 Store 卡片（和机器标签页上的卡片相同，多了 **存放于**（Stored on））：

![Store 卡片（带编号）](../img/store-card.png)

各编号部分见[组件 › Store 卡片](components.md#store-card)。

![docker › Store › PostgreSQL，空](../img/store-machine-board-pg.png)

在 PostgreSQL 一侧，卡片按已保存的登录分组，每个登录一个标题：登录名、用户、使用它的 Store 数、
最差的状态（改密码后检查失败时为 **未连上**（Not reached））、**更换密码…**（Rotate password…），
以及它 ⋯ 里的 **移除登录**（Remove login）（只要还有 Store 在用它，就不可用，并显示
**使用者：** *stores*（Used by *stores*））。机器页只列出从这台机器连接的 Store 所用的登录。

| 组件 | 操作 → 结果 | LayerFS 调用 |
|---|---|---|
| 登录标题的 **更换密码…**（Rotate password…） | [新密码](#modals-opened-here) → 检查所有使用它的 Store | `store save-auth`，然后对每个 Store `store doctor`、`store get` |
| 登录标题 ⋯ › **移除登录**（Remove login） | 输入名称确认 **移除登录** *auth*？（Remove login *auth*?） | `store remove-auth` ↻ |

## 变体

- **LayerFS Home 中的 SQLite 与机器上的 SQLite。** 位置显示为 **LayerFS Home**（无链接）或机器名
  （链接）。菜单在 LayerFS Home 上提供 **推送到…**（Push to…），在机器上提供 **拉回 Home**（Pull to home）和
  **迁移到其他机器…**（Move to another machine…）；健康状况里的机器一行跟随机器的状态。机器已停止时，
  存放在机器上的 Store 会显示 **docker 已停止。**（docker is stopped.）和 **启动 docker**（Start docker），
  大小显示为 **大小读取于** *时间*（size seen *when*）。
- **PostgreSQL。** 位置是服务器（`host:port/db`）；头部多一个 **测试连接**（Test connection）；第一个磁贴
  是 **服务器**（Server），最后一个是 **连接自**（Connected from）；第三个标签页是 **连接**（Connection）；
  健康状况说明备份由服务器自己负责；菜单是 检查 / 更换登录… / 断开 *机器* / 压缩… / 断开连接…。
  PostgreSQL Store 不属于任何机器：每个会话自己选择在哪台机器上运行。
- **压缩…**（Compact…）只在所选的 LayerFS 运行时支持 `store compact` 时出现。

## 此处打开的对话框

| 对话框 | 打开方式 | 作用 | LayerFS 调用 | 撤销 |
|---|---|---|---|---|
| [将 *store* 推送到…](../img/store-push.png)（Push *store* to…） | ⋯ › **推送到…**（Push to…）；卡片上的 **推送到…**（Push to…） | 选一台机器（显示它的剩余磁盘和 Store 的大小；剩余空间小于 Store 时红色提示并禁用 **推送**（Push），余量不足 1.15× 时黄色警告；已停止的机器通过带按键保护的 `StartFirst` 提供 **启动** *m*（Start *m*））；**当前被占用：以下项仍存在时 LayerFS 会拒绝移动该 Store**（Held now: LayerFS refuses to move the Store while these remain）列出挡路的 Sandbox，禁用 **推送** 并在页脚提示原因 | `store move <s> <m>`（作为任务） | **拉回 Home**（Pull to home） |
| [将 *store* 迁移到其他机器](../img/store-move.png)（Move *store* to another machine） | ⋯ › **迁移到其他机器…**（Move to another machine…） | **先拉回 LayerFS Home，再推送到目标机器：两个操作。如果推送失败，Store 会留在 LayerFS Home。**（A pull to LayerFS Home, then a push to the machine: two operations. If the push fails, the Store stays in LayerFS Home.）与推送共用磁盘拒绝/警告、带按键保护的 **启动** *m* 与 **当前被占用** 阻止 | `store get`、`store move <s> native`、`store move <s> <m>` | 迁移回去 |
| [将 *store* 备份到…](../img/store-backup.png)（Back up *store* to…） | ⋯ › **备份到…**（Back up to…）；备份标签页的 **备份到…** 或 **另存为新文件…** | 按服务商列出存储桶，每个都说明写到那里会发生什么（**已是最新**（Already current）、**更新 … 的副本**（Updates the copy from…）、**在此存储桶新建备份**（New backup in this bucket）、**副本已丢失…**（The copy is gone…）、**两侧均已更改…**（Both sides changed…）、**存储桶副本已被其他位置改写…**（Bucket copy was rewritten elsewhere…）、**未列出…**（Not listed…））；**文件**（File）附 **更改**（Change）（**缺失**、**双方都已更改**、**存储桶已更改** 三态均强制要求合法的新文件名）；**添加存储桶**（Add a bucket） | `backup create <s> <b> [--file]`，然后 `backup list` | 旧副本被替换；无法撤销 |
| [*store* 的备份](../img/store-backups-dialog.png)（Backups of *store*） | 卡片上的备份徽标 | 所有副本按服务商分组，放在一条健康状况条下面；每行提供对应操作（**更新**（Update）、**立即备份**（Back up now）、**恢复…**（Restore…）、**双方都已更改** 时提供 **另存为新文件…** + **恢复…**，或密钥被拒时提供 **重新连接…**）；底部 **备份到另一个存储桶**（Back up to another bucket）；所有禁用的行内与底部按钮均说明原因。打开时会重新列出每个关联的存储桶 | 每个关联存储桶 `backup list` (读取)；`backup create` | — |
| [恢复 *bucket*/*file*](../img/store-restore.png)（Restore *bucket*/*file*） | 备份标签页、存储桶页或备份对话框里的 **恢复…**（Restore…） | **作为新 Store**（As a new Store，实时校验名称合法性）或 **替换** *store*（Replace *store*）（除非 Store 位于 LayerFS Home、已就绪且空闲、无运行中 Sandbox 占用、已关联该存储桶、该存储桶已成功列出且副本存在并确认自上次传输后本地未改，否则会被拒绝并写清具体原因；桶尚未列出时弹窗内提供一键 **列出存储桶** 按钮） | `backup restore <b> <file> <store>`，然后 `backup list` | 移除新 Store |
| [向 *store* 添加项目](../img/store-add-project.png)（Add project to *store*） | 项目标签页的 **添加项目**（Add project） | 名称，可选的绝对路径 **源文件夹**（Source folder）；显示 **正在创建** *名称* · *步骤*（Creating *name* · *step*）及计数 | `project init`（主机任务，轮询 `GET /api/project-inits/:id`） | 删除这个项目 |
| [压缩 *store*？](../img/store-compact.png)（Compact *store*?） | ⋯ › **压缩…**（Compact…） | 普通确认；**压缩**（Compact）开始一个任务 | `store compact` | — |
| [移除 *store*？](../img/store-remove.png)（Remove *store*?） | ⋯ › **移除…**（Remove…）、Store 详情里的 **移除…**（Remove…） | [输入名称确认](components.md#confirm-dialog)：**输入** *名称* **以确认**（Type *name* to confirm） | `store remove` ↻ | 无（备份仍留在存储桶里） |
| 断开 PostgreSQL Store *store*？（Disconnect the PostgreSQL Store *store*?） | ⋯ › **断开连接…**（Disconnect…）（PostgreSQL） | 确认；数据库及其数据保留 | `store disconnect` ↻ | 重新连接数据库 |
| [新建 Store](../img/store-new.png)（New Store） | 导航栏 **添加 › 新建 Store**（Add › New Store）；主页 › Store 的 **新建 Store**（New Store）；native 的 **添加 Store › 新建 Store**（Add Store › New Store） | **SQLite** 或 **PostgreSQL**（后者转到连接数据库）；**空 Store**（Empty Store）或 [**从备份恢复**](../img/store-new-restore.png)（Restore from a backup）（对未列出桶自动列出一次、过滤已丢失文件、展示桶列出错误并支持 **重新连接…**、无存储桶时直接提供 **添加存储桶…**，以及 **重新列出**、文件列表与 **新 Store 的名称**（New Store's name））；**位置**（Location）磁贴，已停止的机器旁有 **启动** *m*（Start *m*）。先在 LayerFS Home 创建，再迁移过去 | `store create` ↻（或 `backup restore`），然后用 `store move` 迁移到其他机器 | 移除 |
| [连接数据库](../img/store-connect-new.png)（Connect a database） | 导航栏 **添加 › 连接数据库**（Add › Connect a database）；主页 › Store 的 PostgreSQL 一侧 **连接数据库**（Connect a database） | 还没有 PostgreSQL Store 时直接打开新服务器表单：**连接 URL**（Connection URL）（不含登录信息）、**Store 名称**（Store name）、**登录**（Login）（**用户**（User）/**密码**（Password），或 **已保存的登录**（Saved login））、[**更多选项**](../img/store-connect-options.png)（More options）（**synchronous_commit**）。**取消**（Cancel）关闭对话框；有列表时 **返回**（Back）回到列表。之后进入检查界面 | `store save-auth`（新登录）、`store connect`、`store get`，然后 `store doctor --machine` | **断开连接…**（Disconnect…） |
| 连接数据库：选择 | 同上，已有 PostgreSQL Store 时 | 所有已连接的 Store 按服务器分组，各带 **检查**（Check）（在机器页上为 **连接**（Connect））；**+ 此服务器上的新数据库**（+ New database on this server）（沿用主机和登录）；**+ 新服务器**（+ New server） | 同上 | |
| 连接数据库：检查 | **检查**（Check）、**连接一台机器**（Connect a machine）、一个状态标签 | **检查来源**（Check from）（一台机器）、机器 → 服务器 → Store 的路径，以及五个步骤 **Store 记录为最新格式**（Store record is up to date）、**能连到服务器**（Reaches the server）、**通过登录验证**（Signs in）、**能找到此 Store**（Finds the Store）、**可以写入**（May write it）；按下 **从** *机器* **检查** *store*（Check *store* from *machine*）时运行。当 LayerFS 明确指出原因时，失败会标出停在哪一步并给出对应修法：[服务器连不上](../img/store-check-server.png)（**为** *机器* **设置专属地址**（Give *machine* its own address）→ ***机器* 连接的 URL**（URL *machine* dials）→ **保存并检查**（Save and check）；在 LayerFS Home 上为 **编辑连接**（Edit connection））、[登录错误](../img/store-check-login.png)（**更换登录…**（Change login…）、**更换密码…**（Rotate password…））、[缺少权限](../img/store-check-privilege.png)（列出缺失权限并提供 **更换登录…**（Change login…））、[记录过旧](../img/store-check-record.png)（**更新**（Update）或 **保存登录…**（Save a login…））。若 LayerFS 未提供足以定位具体步骤的证据，步骤与连线保持中性，仅展示原始拒绝而不猜测修法。修完后可点 **重新检查**（Check again） | `store doctor --machine` (读取并记录)、`store connect --machine`、`store update` | 忘记 |
| [在 *机器* 上连接数据库](../img/store-connect-machine.png)（Connect a database on *machine*） | 机器 › Store › PostgreSQL 的 **连接数据库**（Connect a database） | 和连接数据库一样；检查从那台机器运行 | 同上 | |
| 编辑 *store* 的连接（Edit *store*'s connection） | **更换登录…**（Change login…） | **URL（不含密码）**（URL (no password)）、**登录**（Login）（保留、输入新的，或选一个已保存的）、**synchronous_commit**；只发送改动过的部分 | `store connect`、`store save-auth`、`store update` ↻ | 再编辑一次 |
| *机器* 到 *store* 的专属连接（*machine*'s own connection to *store*） | 连接 › **编辑**（Edit） | 一个 URL；**保存并检查**（Save and check） | `store connect --machine`（LayerFS 先检查） | **忘记**（Forget） |
| 为 *store* 保存登录（Save a login for *store*） | **更换登录…**（Change login…）/ Store 没有指定已保存登录时的 **保存登录…**（Save a login…）修复 | **用户**（User）、**密码**（Password）、**登录名称**（Login name），或一个已保存的登录 | `store save-auth`、`store update --auth` ↻ | — |
| *auth* 的新密码（New password for *auth*） | 登录标题的 **更换密码…**（Rotate password…） | **用户**（User）、**密码**（Password）；然后每个使用它的 Store 一个圆点（**可访问**（reached）/ **检查失败**（check failed）） | `store save-auth`、对每个 Store `store doctor`、`store get` ↻ | 再更换一次 |
| [向 *机器* 添加 Store](../img/store-to-machine.png)（Add a Store to *machine*） | 机器 › Store 的 **推送 Store 到这里**（Push a Store here）/ **添加 Store**（Add Store） | **SQLite**（**移动一个到这里**（Move one here））或 **PostgreSQL**（**连接一个，或让已有的在此运行**（Connect one, or run one here））；列出其他机器上的 SQLite Store（含大小与来源，不可移动项显示真实原因如 **请先启动机器** *m*（Start machine *m* first））；检查目标剩余磁盘（小于 Store 红框拒绝、不足 1.15× 黄框警告）、带按键保护的 **启动** *m*、**当前被占用** 阻止，跨非 Home 机器迁移附两步操作说明；**移动到这里**（Move here）；在 LayerFS Home 上附 **或者直接在此新建：新建 Store**（Or create an empty Store here: New Store） | `store get`，然后 `store move`（推送、拉回，或先拉回再推送） | 移回去 |
| [添加存储桶](../img/store-bucket-add.png)（Add bucket） | 导航栏 **添加 › 添加存储桶**（Add › Add bucket）；备份对话框里的 **添加存储桶**（Add a bucket）；备份标签页的 **添加存储桶…**（Add bucket…） | **MinIO** 或 **Cloudflare R2**、**名称**（Name）、**存储桶**（Bucket）、**端点**（Endpoint）或 **账户 ID**（Account ID）+ **辖区**（Jurisdiction）、**前缀**（Prefix）、**访问密钥**（Access key）、**私密密钥**（Secret key）；从备份对话框打开时，完成后回到备份对话框 | `backup connect`（密钥经 stdin 传入）↻ | 断开存储桶 |
| 重新连接 *bucket*（Connect *bucket* again） | 密钥被拒绝的存储桶上的 **重新连接…**（Connect again…） | 同一个表单，名称锁定、URL 已填好；同一个 URL 会替换密钥（**密钥已替换；Store 关联保留**（Key replaced; links kept））并仅重列该存储桶 | `backup connect`，然后 `backup list` | — |

## 状态与信号

- **忙碌**（Busy）标签、菜单行变灰：有任务（本机的，或其他客户端的 **另一个客户端正在运行 …**
  （Another client runs …））占用着这个 Store。等它的卡片结束。
- **等待 docker**（Waiting on docker）/ **docker 已停止。**（docker is stopped.）：Store 所在的机器停了；
  **启动 docker**（Start docker）会启动它（按键保护会忽略对刚出现的按钮的点击）。
- **已阻塞 · docker 已损坏**（Blocked · docker broken）/ **已阻塞 · docker 记录无法读取**（Blocked · docker unreadable）：它的机器坏了；按钮是那台机器的
  修复，没有的话 **修复 docker**（Repair docker）会打开那台机器。
- **已损坏 · …**（Broken · …）：Store 自身的问题；[修复按钮](components.md#fix-buttons)会运行 LayerFS 的
  修复（结果未知时为 **压缩** *store*（Compact *store*），PostgreSQL Store **没有已保存的登录**（no saved
  login）时为 **保存登录…**（Save a login…），记录过时为 **更新**（Update））。
- **继续之前请检查此 Store：某个操作的结果未知。**（Inspect the Store before continuing: an operation's
  outcome is unknown.）：某个任务没有返回结果就结束了；修复方式是再压缩一次。
- 灰色 **尚未备份**（No backup yet）/ 健康状况 **自上次备份后已更改**（changed since the last backup，灰色圆点）：
  备份一下，或者忽略它（没有备份或备份较旧都不算错误）；只有 **缺失**（Missing）和 **双方都已更改**（Both changed）显示为红色。
- **大小读取于** *时间*（size seen *when*）：机器没有响应；显示的是上次读到的大小。

## 下一步

- [项目](project.md)：项目标签页里的项目名。
- [机器](machine.md)：位置链接，以及上文的 Store 标签页。
- [存储桶](bucket.md)：存储桶的备份卡片、备份对话框。
- [主页](home.md)：主页 › Store，所有 Store 卡片都在这里。
- 诊断页：**检查完整性**（Check integrity）、**测试连接**（Test connection）。

## 源码

`src/client/storage/StorePage.tsx`、`store-page.ts`、`StoreOverview.tsx`、`StoreProjects.tsx`、
`ProjectTable.tsx`、`StoreLinks.tsx`、`StoreCard.tsx`、`JobProgress.tsx`、`dialogs.tsx`、
`ConnectDatabase.tsx`、`BackupDialogs.tsx`、`pg-fields.tsx`、`MachineStores.tsx`、
`machine-stores.ts`、`StoragePage.tsx`（`actionsFor`）、`src/client/doctor/Doctor.tsx`
（`DoctorAction`）；主机：`src/host/routes/storage.ts`、`projects.ts`、`machines.ts`。
