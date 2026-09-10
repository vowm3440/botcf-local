# 轻量 IDE 演进计划(修订版):项目隔离、资源预算与退出回收

> 状态:设计稿,待确认。核对基线:工作树 `917e4c1`(main,含未提交修改),2026-09-06。
> 本文是对上一版评审意见的修订。所有"当前实现"条目都对应到了具体文件和行号;
> 原稿引用的版本号 `d014355` 不在本仓库历史中(仓库历史已重置,HEAD 之前只有 4 个提交),
> 因此原稿中的代码事实全部重新核对过。

## 0. 相对原稿的修改摘要

| # | 原稿说法 | 核对结果 | 修订 |
|---|---|---|---|
| 1 | "多个目录目前共享 AI 运行时,尚未形成独立项目会话" | 部分正确。仓库已有多根工作区模型 `apps/server/src/workspace/model.ts`(上限 `MAX_WORKSPACE_ROOTS = 8`),但只有一个 `ompClient`,其 `workdir` 指向主根(`workspace/store.ts:38`) | 计划从"新建项目概念"改为"给已有 root 挂资源状态",工作量小很多 |
| 2 | "OMP 的 stop() 主要调用直接子进程 kill()" | 正确(`omp/rpc.ts:314-316`)。但 `process/killTree.ts` 已实现 Windows `taskkill /T /F` 与 POSIX 进程组杀,任务与终端已在用 | 不需要新写,直接复用 `killTree`;Job Object 降为可选 |
| 3 | "聊天历史接口最多读 40 页再合并" | 正确(`routes/chat.ts:728`) | 保留 |
| 4 | "聊天增量直接调用 setMessages" | 正确(`chat/useChatSession.ts:158-166`),delta、reasoning、notice 三条路径各自 setState | 保留,补充:changedFiles 已是按事件增量(`:152`),不是每 token 重算 |
| 5 | "递归 fs.watch,收到事件后再过滤" | 正确(`preview/watcher.ts:86-89`);已有 120 ms 合并与 50 条路径上限,但 `pending` Set 本身无上限 | 保留,细化为"pending 有界 + 溢出转全量重扫" |
| 6 | "草稿存在内存 Map,无字节预算" | 正确(`editor/draftStore.ts:24`);标签上限 24(`editor/tabsModel.ts:20`),被 `keep` 保护的脏标签不淘汰 | 保留 |
| 7 | "任务并发 4、终端 4" | 正确(`tasks/manager.ts:21`、`terminal/registry.ts:15`) | 保留 |
| 8 | "文件读取上限 1 MiB" | 正确(`textFile.ts:11`) | 保留 |
| 9 | RPC 背压 | 原稿未给证据。核对:`rpc.ts:411/419` 直接 `stdin.write`,不看返回值;`pending` Map 无上限 | 作为确认缺口列入 |
| 10 | 性能门槛边界 | 正确(`perf/README.md` §边界)。但 README 引用的 `docs/perf-gate-2026-08-28.md`、`docs/fix-verification-report-2026-08-24.md` 在仓库中不存在 | 新增"恢复 docs 目录"为前置任务 |
| 11 | 预算数字 | 原稿给的是 16 GB 机器的起点,合理 | 保留,但改为"配置默认值 + 动态降级",并注明每条如何验证 |
| 12 | 阶段顺序 | 原稿是主题列表,没有依赖顺序 | 重排为 6 个阶段,每阶段有验收条件 |

原稿的核心判断不变:**保留 CodeMirror 6 与 OMP RPC,先做隔离、预算和回收,再加功能;不换 Electron,不重写后端。**

## 1. 目标与非目标

**目标**:覆盖"读代码 → 编辑 → AI 修改 → 审查 → 运行测试/预览"的日常流程,在 16 GB 开发机上同时打开 8 个企业规模目录、2 个活跃工作时输入仍流畅。

**非目标**(本轮不做):VS Code 扩展兼容、DAP 调试、远程开发。LSP 只做预留接口,不在本轮接入语言服务器。

能力对照(保留原稿,略作收敛):

| 能力 | 实现方式 | 本轮范围 |
|---|---|---|
| 编辑、高亮、搜索、折叠、Diff | CodeMirror 6 | 已有,本轮只改资源策略 |
| 补全、跳转、重命名 | `@codemirror/lsp-client` + 语言服务器 | 预留 per-root 进程槽位,不接入 |
| AI 读写、工具执行 | OMP RPC | 会话隔离、背压、回收 |
| Git、终端、任务、预览 | 服务端工作台 | 接入统一预算 |
| 调试 | DAP | 不做 |

## 2. 当前架构事实(已核对)

| 事实 | 位置 | 对多开的影响 |
|---|---|---|
| 多根工作区,最多 8 根,一个主根 | `workspace/model.ts:41` | 已有"多项目"容器,缺资源状态 |
| 单一 `ompClient`,cwd 跟主根 | `omp/rpc.ts:484`、`workspace/store.ts:38` | 切主根即切 AI 上下文,无法两根并行 |
| RPC 写入不看背压,pending 无上限 | `omp/rpc.ts:400-420` | 慢子进程或事件风暴时内存无界 |
| OMP stop 仅杀直接子进程 | `omp/rpc.ts:291-320` | OMP 起的工具子进程可能残留 |
| 进程树杀已存在 | `process/killTree.ts` | 可直接复用 |
| 历史接口一次拉 40 页 | `routes/chat.ts:728` | 长会话恢复时集中分配 |
| 流式 delta 逐条 setState | `chat/useChatSession.ts:158-166` | 高频渲染,需测量 |
| 递归 watch 后过滤;pending 无界 | `preview/watcher.ts:86-111` | 大仓库 `node_modules` 仍被监听 |
| 草稿 Map 无字节预算;24 标签上限 | `editor/draftStore.ts`、`editor/tabsModel.ts:20` | 脏标签只增不减 |
| 只挂载活动编辑器 | `editor/CodeSurface.tsx` | 已避免多套 DOM |
| 文件 1 MiB 上限、只读预览 | `textFile.ts:11` | 大文件流畅是有边界的 |
| 任务并发 4、终端 4、历史 12 | `tasks/manager.ts`、`terminal/registry.ts` | 有数量限制,无 CPU/内存维度 |
| perf:editor 只测渲染进程树 | `perf/README.md` §边界 | 不能证明多项目总体性能 |

## 3. 设计:root 的资源状态机

在现有 `Workspace` 上给每个 root 增加运行态(不持久化,重启后全部为 `cold`):

```
cold ──(用户切换/打开文件)──> active
active ──(失焦)──> background ──(idle ≥ N 分钟且无 pinned 任务)──> cold
任一状态 ──(移除 root)──> closed
```

| 状态 | 保留 | 释放 |
|---|---|---|
| active | 编辑视图、该 root 的 OMP 会话、watcher、运行中任务 | 无 |
| background | 草稿、会话句柄、最近文件缓存;运行中任务 | 编辑视图;watcher 降为按需刷新 |
| cold | 草稿(先落盘恢复日志)、标签列表 | OMP 运行时、watcher、文件缓存、预览 |
| closed | 恢复日志 | 该 root 拥有的一切引用 |

**不自动进入 cold 的条件**:有运行中任务/预览、有进行中的 AI 生成、用户显式 pin。

**释放顺序**(每个持有资源的模块实现同一个 `release(rootId)` 接口):
停止新请求 → 取消在途 → 保存状态 → 关订阅 → 销毁视图 → `killTree` 进程 → 删缓存引用。

多窗口:所有窗口连同一个本地服务,预算计数只在服务端。

## 4. 预算(默认值,可配置,待压测校正)

| 项 | 默认 | 落点 | 验证方式 |
|---|---|---|---|
| 并行 AI 会话(OMP 运行时) | 2,其余排队 | 新 `omp/pool.ts` | 第 3 个会话应显示"排队中" |
| 重型任务(build/test) | 1;普通任务仍 4 | `tasks/manager.ts` 加权重字段 | 两个 build 串行 |
| 常驻预览 | 1 | `preview/manager.ts` | 第 2 个需显式确认 |
| 非活动文档缓存 | 64 MiB 总量,LRU | `editor/draftStore.ts` + 新 `docCache.ts` | 超限后最旧只读文档被淘汰 |
| UI 日志缓存 | 每路 4 MiB / 全局 32 MiB;完整日志落盘 | 任务、终端、聊天工具卡 | 超长输出不增长堆 |
| RPC pending / 事件队列 | 各 256 帧;单帧 4 MiB | `omp/rpc.ts` | 超限拒绝并报错,不 OOM |
| watcher pending 路径 | 2 000;溢出置 `rescan` 标记 | `preview/watcher.ts` | 大量改动后只触发一次全量刷新 |
| root 空闲回收 | 5 分钟 | 状态机 | 切回时显示"正在恢复" |

动态降级:服务端每 10 s 采样自身与子进程 RSS,系统可用内存低于 15% 时把并行 AI 会话临时降为 1、暂停后台 root 的 watcher。恢复时留 5% 缓冲防抖。

不给语言服务器统一内存上限(本轮不接入,先留字段)。不用定时强制 GC。

## 5. 分阶段实施

每阶段独立可合并、有测试;不做完上一阶段不进下一阶段。

### 阶段 0:恢复文档与基线(0.5 天)
- 建 `docs/`,补齐 `perf/README.md` 引用的两份缺失文档的占位说明或删掉引用。
- 跑一次 `npm run perf:editor`,把结果存为 `docs/perf-baseline-<date>.json` 作为本计划的对照。
- 验收:README 无悬空链接;基线文件存在。

### 阶段 1:退出回收(1 天,风险低,收益直接)
- `omp/rpc.ts` 的 `stop()` 改用 `process/killTree.ts`。
- 新增测试:OMP 子进程再起一个孙进程,`stop()` 后孙进程不存活(Windows 与 POSIX)。
- 服务关闭钩子顺序按 §3 的释放顺序排列。
- 验收:`omp-rpc-lifecycle.test.ts` 新增用例通过。

### 阶段 2:通信背压与历史分页(1.5 天)
- `rpc.ts`:`write()` 返回 false 时等待 `drain`;pending 超 256 时 `call` 立即拒绝;单帧超 4 MiB 丢弃并记 stderr。
- `/api/chat/history` 改为透传 `cursor`,前端按页加载,首屏只取最新一页。
- `useChatSession`:delta / reasoning 用 30–50 ms 合并写入,结束与错误时立即刷新。
- 验收:伪造 5 000 帧/秒事件流,服务端堆不超基线 +50 MiB;`chat-direct-stream.test.ts` 补分页用例。

### 阶段 3:root 资源状态机与 OMP 池(3 天,核心)
- `workspace/` 增加 `runtimeState.ts`(纯函数状态机 + 测试)。
- `omp/pool.ts`:`Map<rootId, OmpRpcClient>`,上限 2,超出排队;空闲 5 分钟 `stop()`。
- 模型路由、凭据代理授权、事件转发都带 `rootId`;`routes/chat.ts` 按 root 取客户端。
- UI:root 列表显示状态徽标(活动/后台/休眠/恢复中)、pin 按钮。
- 验收:8 根打开只操作 1 根时,OMP 进程数 = 1;切换到第 3 根时第 1 根排队或被回收;pin 的 root 不回收。

### 阶段 4:内存预算(2 天)
- `docCache.ts`:按字节 LRU;`draftStore` 脏草稿先写 `<dataDir>/drafts/<rootId>/` 恢复日志,再允许淘汰视图。
- 恢复时比对 mtime,不一致进入现有冲突处理(`draftPolicy.ts`)。
- 撤销历史策略:非活动标签只保留文本 + 最近 200 步历史序列化;超出丢弃,UI 提示。
- 日志缓存按 §4 上限截断,完整日志落盘。
- 验收:perf:editor 新增"24 个脏标签"场景,`retainedDeltaMiB` 不随标签数线性增长。

### 阶段 5:CPU 与监听(1.5 天)
- `watcher.ts`:pending 上限 2 000,溢出置 `rescan`;Windows/macOS 递归监听保留,Linux 改按目录递归并跳过排除列表。
- 排除规则拆三份配置:搜索、监听、读取。
- Git 状态刷新按 repo 去重合并;全项目搜索改流式并可取消。
- 重型任务权重字段与串行队列。
- 验收:在有 `node_modules` 的仓库执行 `npm install`,watcher 事件批次 ≤ 3 次;两个 build 任务串行。

### 阶段 6:验收压测(2 天,贯穿)
新增 `perf:workspace`(Electron 驱动,复用 `harness/app.cjs`),记录 Electron 界面、本地服务、OMP、任务/预览四类进程分别的 RSS 与句柄数:

| 场景 | 判定 |
|---|---|
| 1 / 4 / 8 根打开,只 1 根活动 | 非活动根 5 分钟后 OMP 进程数为 0 |
| AI 生成 + build + 预览同时运行 | 输入 P95 ≤ 40 ms(沿用现有门槛) |
| 批量改文件、切分支 | watcher 批次有界、Git 刷新不堆积 |
| 超长日志、长会话、超长单行 | 堆增长有上限 |
| 连续开关 root 50 次 | RSS、句柄、监听数无单调增长(允许 ±10%) |
| 强杀 OMP / 应用异常退出 | 草稿可恢复;无残留子进程与端口 |

阈值绑定机器型号、版本号、负载写入 `perf/thresholds.json`。

## 6. 依赖与风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| OMP 协议是否支持多实例同一会话目录并发 | 高 | 阶段 3 前先做协议探针测试;不支持则每 root 独立会话目录 |
| 分页历史改动 UI 恢复逻辑 | 中 | 阶段 2 保留旧接口一版,前端切换开关 |
| 草稿落盘与磁盘文件冲突 | 中 | 复用现有 `draftPolicy` 冲突路径,不新造 |
| Linux 递归 watch 替换成本 | 低 | 只在 Linux 分支做,其余平台保持 |
| 预算数字过紧导致频繁排队 | 中 | 全部可配置;阶段 6 数据校正 |

## 7. 工作量

| 阶段 | 估算 |
|---|---|
| 0 文档与基线 | 0.5 天 |
| 1 退出回收 | 1 天 |
| 2 背压与分页 | 1.5 天 |
| 3 状态机与 OMP 池 | 3 天 |
| 4 内存预算 | 2 天 |
| 5 CPU 与监听 | 1.5 天 |
| 6 压测 | 2 天 |
| 合计 | 约 11.5 天 |

复杂度:**中高**。阶段 3 是关键路径,阶段 1、2 可先行独立合并。


## 8. 执行记录与偏差(工作树 917e4c1 之上,未提交)

> 本条是逐阶段交付记录。计划正文是设计稿;这里记的是 2026-09-07 在实际工作树上做到哪、
> 哪些按字面交付、哪些以等效/简化形态交付。所有改动与测试都留在工作树里,未 commit。

| 阶段 | 状态 | 交付 | 偏差/备注 |
|---|---|---|---|
| 0 文档与基线 | 完成 | perf/README.md 已存在并引用恢复的 docs;perf/last-run.json 有当日基线 | 无 |
| 1 退出回收 | 完成 | omp/rpc.ts stop 走 killTree;关闭钩子顺序化;omp-rpc-lifecycle 覆盖孙进程回收 | 无 |
| 2 背压与分页 | 完成 | write() 背压/pending 256 上限/单帧 4 MiB;chat-direct-stream、omp-rpc-backpressure 覆盖 | 无 |
| 3 root 状态机与 OMP 池 | 完成(范围修订) | workspace/runtimeState.ts(纯状态机)、omp/pool.ts(容量 2 + 5 min 空闲回收 + pin)、workspace/rootRuntime.ts 单例、per-root OmpRpcClient(workdir=root path)、UI 徽标与 pin、/api/workspace/runtime 快照;resource/degrade.ts 动态降级(计划 §4):每 10 s 采样系统可用内存,<15% 时池容量临时降 1(驱逐空转非 pin 运行时)并暂停非活动根预览的 reload 监听,≥20%(5% 防抖)才恢复;server 启动接线、shutdown 停止;resource-degrade 决策/迟滞、pool setCapacity 驱逐/保护、preview-manager 暂停恢复单测固定 | **模型路由/凭据代理仍走单一全局 active route**(ompClient 门面绑 active root),未做 per-root route;UI「手动显式激活」等价于切 primary。原因:产品是单登录/单模型路由,root 间差异只在会话目录与 workdir;per-root route/凭据需先有 per-root 供应商配置面(新功能),不在本轮「只改资源策略」范围,故模型调用统一走全局 route,但事件转发带 rootId(routes/omp.ts)且聊天只面向活动 root 的 per-root 客户端。**agent dir 共享并发**已用真实 OMP 双实例探针验证(concurrency-probe) |
| 4 内存预算 | 完成(磁盘恢复日志 + 完整日志落盘) | docCache.ts 字节 LRU;draftStore 脏草稿字节核算 + 溢出先写 <dataDir>/drafts/<rootId>/ 磁盘恢复日志(/api/drafts,根移除时整目录清理)再淘汰;重开文件从日志取回并按 mtime 提示冲突,保存仍走服务端 mtime 409;FileViewer/App 已接线。任务/终端输出除有界环形缓冲外,每行同步落盘 <dataDir>/logs/{tasks,terminals}/<rootId>/<id>.log(TranscriptSink,与记录同生命周期:close/prune/clear/root 移除清理,server 启动清扫崩溃残留;经 /api/tasks/runs/:id/log、/api/terminal/sessions/:id/log 可读全文);draft-recovery/transcripts/terminal-registry 单测 + 真实服务端路由 E2E + editor e2e 20/20 验证 | 撤销历史 200 步序列化仍按等效机制:CodeMirror history 只存在于唯一挂载的活动编辑器,切换即销毁、无跨标签累积可界;预览日志沿用有界环形缓冲(SSE 事件流,无磁盘副本);draftPolicy 冲突路径沿用保存时 mtime 409,未新增独立 UI 分支 |
| 5 CPU 与监听 | 完成 | preview/watcher.ts pending 上限 2 000 + 溢出置 rescan(批量发 reload);watcher 双后端:Windows/macOS 原生 recursive 保留,Linux(auto)改走目录遍历后端(walkWatch.ts 按目录逐个 fs.watch,排除子树根本不打开;后置目录创建/移入可补挂深层 watch,目录属性噪声过滤,watch 数上限 4 000、超出仅告警一次);排除规则按活动拆三份(exclusions.ts:WATCH_RULES 供监听、SEARCH_RULES 预留、READ_RULES 读取侧不排除,语义独立、单测固定);tasks/model.ts 重型 kind 判定 + tasks/manager.ts 权重槽位(重型占满池、普通 4 并发)与 FIFO 串行队列;TaskRun 增 queued 态与 UI「排队中」;git/service.ts Git 状态刷新按 repo 顶层去重:repoStatusCache(单 repo 一次 git status、150 ms 窗口复用、并发共享同一 in-flight promise)、statusOf 按 root prefix 过滤切片并重锚、7 个变更操作入口失效缓存,其中内部再读状态的 unstage/discard/commit/undo 在成功返回前二次失效,杜绝改动完成后 150 ms 窗口内刷新命中操作前快照;git-service 补「同 repo 双 root 并发仅 1 次 git status / prefix 切片过滤与重锚 / 变更后缓存失效」、watcher-walk 补「walk 后端嵌套/排除子树静默/后置目录发现/上限告警 + 三套规则独立」单测 | **全项目流式搜索无可实现对象**:核对后仓库只有 CodeMirror 文档内查找,没有全项目搜索实现(计划该条假定其存在),新增该能力属计划非目标「再加功能」,不随资源预算交付,故 SEARCH_RULES 预留为空语义并在模块注释注明。**watcher walk 后端**:用真实 fs.watch 以 strategy:'walk' 在 Windows 上全量单测固定(本机无 Linux,未做实机回归;代码为平台无关的单目录 watch,无 Linux 特有 API);recursive 后端行为不变。验收以 watcher-rescan、watcher-walk、tasks-manager、git-service 单测固定 |
| 6 验收压测 | 完成(server 侧 + Electron 引导) | npm run perf:workspace(perf/workspace.cjs):真实服务 + 真实窗口,1/4/8 根 RSS、50 次开关循环 RSS/句柄增量、渲染进程峰值与回收后 JS 堆;阈值入 perf/thresholds.json workspace.gate,结果写 perf/last-workspace-run.json | OMP 进程与任务/预览 RSS 不在此脚本驱动(harness 把更新器指向死代理,池恒为 0):池容量不变量逐样本断言,真 OMP 起停/回收与「两个 build 串行」「watcher 批次有界」由阶段 3/5 单测固定;README §perf:workspace 已标注边界 |