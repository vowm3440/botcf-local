# Issues Log

## 2026-08-15 — BotCF 专用 Key 返回掩码导致代理 401

- 症状:代理 `/v1/responses` 返回 `401 Invalid token`;列表中的 Key 形如 `sk-****...****`。
- 根因:BotCF 新 API 只在创建响应返回完整 Key,后续列表/详情均返回掩码;旧逻辑在创建后再次读取详情。
- 解决:优先使用创建响应并立即 AES-GCM 密封;缓存缺失且仅有掩码时只轮换本应用命名空间的专用 Key。
- 失败尝试:`GET /api/token/:id` 和站点 key reveal 路径均不能恢复完整 Key。
- 预防:测试完整 Key 判定;禁止把掩码写入凭据代理。

## 2026-08-15 — OMP 自定义路由重启后回退到无效代理凭据

- 症状:OMP 会话调用模型时返回 `401 Incorrect API key provided: proxy-managed`。
- 根因:模型只通过 `set_model` 选择,OMP 重启后没有持久的自定义 provider 配置,请求发往默认 OpenAI 地址。
- 解决:从能力库生成应用自有 `models.yml`,provider 指向回环凭据代理;启动和切换会话时重新应用路由。
- 失败尝试:仅在现有 OMP 进程调用 `set_model`,重启后状态丢失。
- 预防:安装后冒烟必须覆盖 handshake、set_model 和一次真实 prompt。

## 2026-08-15 — OMP 每轮 Token 一直显示 0

- 症状:真实回答成功,界面仍显示输入 0 / 输出 0。
- 根因:`get_session_stats` 使用 `tokens.input` / `tokens.output`,解析器只识别 `inputTokens` 等别名。
- 解决:解析 OMP `SessionStats.tokens` 的规范字段并增加回归测试。
- 失败尝试:只从事件流 usage 帧累计,无法覆盖所有运行时版本。
- 预防:契约测试直接使用上游规范响应形状。

## 2026-08-15 — Docker 首次构建依赖解析失败

- 症状:`npm install` 在镜像内因 Vite 8 与旧 React 插件 peer range 冲突而失败;构建上下文达到 1.3GB。
- 根因:Dockerfile 未复制 lockfile、使用非确定性 install;仓库没有 `.dockerignore`;web 还残留服务端依赖。
- 解决:升级兼容 Vite 8 的 React 插件,删除无用依赖,改用 `npm ci`,复制全部 workspace manifest,新增 `.dockerignore`。
- 失败尝试:原始 `npm install --workspaces`。
- 预防:Docker 构建作为发布验收;生产依赖执行 `npm audit --omit=dev`。

## 2026-08-15 — 安装包重建时 EPERM

- 症状:electron-builder 无法删除 `release/win-unpacked/BotCF-Local.exe`。
- 根因:前一轮桌面冒烟留下 Electron 进程占用该文件。
- 解决:确认并终止该验收进程树后重新打包;随后再次启动最终产物并验证页面。
- 失败尝试:在进程占用期间直接覆盖产物。
- 预防:桌面冒烟结束必须确认 `BotCF-Local.exe` 进程树退出。

## 2026-08-24 — 切换主目录后 OMP 路由未恢复

- 症状:界面仍显示 `🥺grok-heavy / grok-4.6 / chat`,切换主目录返回 `restarted:true` 后第一次对话却得到空白助手消息;OMP 会话记录为 `anthropic/claude-opus-4-8` 和 `409 当前路由是 chat 接口,收到的却是 messages 请求`。
- 根因:`workspace/service.ts` 的 `reactivateRuntime()` 只执行 stop/start/handshake,没有调用 `applyActiveRouteToOmp()`;OMP 重启后恢复了自身持久化模型,与界面和凭据代理的活动路由分离。
- 解决:新增 `omp/runtime.ts` 的 `restartRuntime()` 作为唯一运行时重激活入口——stop → start → handshake → `applyActiveRouteToOmp()`(内含 `get_state` 校验)。主目录切换(`workspace/service.ts`)、显式 `POST /api/omp/restart`、更新后的 healthProbe 三处全部改为复用它;任一步失败返回 `status:'failed'`,停掉 OMP 退回直连模式并写入诊断中心,工作区接口随之带上 `runtimeError`,`restarted` 只在完整通过时为 true。
- 失败尝试:仅刷新页面或等待不会修复 OMP 内部模型;手动切换一次模型后恢复。
- 预防:`test/omp-runtime.test.ts` 用可注入的 `RuntimeControl` 断言步骤顺序、无路由时的短路、以及 start/handshake/applyRoute/状态校验四种失败都不得报告成功。契约测试 `test/omp-route-contract.test.ts`(2026-08-25 补)把注入的 seam 换成真实 RPC:一个按 docs/rpc.md 应答、且**跨进程保留自身模型选择**的假 omp 进程,断言重启后线上依次收到 `get_state`(握手)→ `set_model`(provider 由路由的 wire 协议决定)→ `set_thinking_level` → `get_state`(校验),之后 `get_state` 与路由一致且 `prompt` 被接受;假进程忽略 `set_model` 时必须报 failed 并停掉进程。剩余缺口只有真实 omp 二进制的端到端冒烟。

## 2026-08-24 — OMP 模型错误被显示为空白回答

- 症状:OMP 会话已记录 `stopReason:error/errorStatus:409/errorMessage`,但 SSE 正常结束,界面只显示空白“助手:”,诊断中心也没有新增模型错误。
- 根因:`routes/chat.ts` 的 `agent_end` 分支只识别 `stopReason:length`,其他终止错误直接 `finish()`;前端只有收到 `type:error` 才会追加 `[错误]`。
- 解决:`truncationNotice()` 扩展为 `terminalOutcome()`,把 terminal `agent_end` 归类为 normal/length/aborted/error 四种(容忍 `stopReason`/`stop_reason`、`errorMessage`/`error.message`、`errorStatus`/`statusCode` 等字段漂移,且在没有 assistant 消息时回落到帧本身)。`error` 发送脱敏的 `type:error` 并写入诊断中心,`length` 仍发警告 notice,中止发 `type:aborted`;变更文件摘要与工具事件的处理位置不变,仍在同一个 `finally` 里冲刷。
- 失败尝试:查询 `/api/chat/history` 只能看到用户消息,无法从界面恢复错误原因;直接读取 OMP JSONL 才确认 409。
- 预防:`test/chat.test.ts` 的 `terminalOutcome` 套件覆盖 error/length/abort/normal 四种终止原因、嵌套 error 对象、缺失原因的兜底文案。`test/chat-terminal-stream.test.ts`(2026-08-25 补)接着断言分类之后的接线:同一个 terminal `agent_end` 必须同时产出浏览器能解析的 `data: {...}` SSE 帧和一条诊断记录,两者文本一致且都经过脱敏;length 走 warning、abort 不写诊断、normal 什么都不发、`isTerminal:false` 一律忽略。OMP 自己的会话历史仍然只记录用户消息,因此错误的可见性由 SSE + 诊断中心负责,不能依赖 `/api/chat/history`。

## 2026-08-24 — 非法项目配置保存会覆盖为默认值

- 症状:先保存包含 `CUSTOM_KEEP_ME` 的有效配置,再保存 `{bad json`;接口返回 200 和一条警告,磁盘 `.botcf/config.json` 已被默认配置覆盖。
- 根因:`parseProjectConfig()` 为读取容错把语法错误降级为 `DEFAULT_PROJECT_CONFIG`,`POST /api/project-config` 又无条件保存解析结果;读取降级语义被错误复用于写入。
- 解决:读写拆成两套契约。`parseProjectConfig()` 仍为读取容错;新增 `checkProjectConfigText()`/`checkProjectConfig()` 供写入使用,JSON 语法错误、空文本、根节点不是对象一律返回拒绝,`POST /api/project-config` 据此返回 400 且完全不调用 `saveProjectConfig`,磁盘文件字节与 mtime 不变。字段级拒绝仍作为 warning 随保存返回。
- 失败尝试:依赖前端 JSON 模式不能避免问题,该模式直接把原始文本提交给同一接口并接受其规范化响应。
- 预防:`test/project-config.test.ts` 先写入含 `terminal.env.CUSTOM_KEEP_ME` 的哨兵配置,再提交 `{bad json`,断言拒绝、文件字节相同、mtime 相同、重读后哨兵仍在。

## 2026-08-24 — 多个近 1 MB 文件同时编辑时渲染器内存和延迟过高

- 症状:8 个大型项目同时打开 8 个约 950 KB/12,001 行文件并编辑时,桌面进程树工作集峰值 1,453.4 MiB、私有内存峰值 1,606.9 MiB;标签切换 628–719 ms,短文本输入 714–904 ms。关闭全部标签 10 秒后工作集仍约 998.2 MiB,重载页面后降到 725.9 MiB。
- 根因:`EditorTabs` 为每个标签始终挂载完整 `FileViewer`;每份受控 textarea、全文缓冲及按键后的全文派生计算同时常驻,关闭后 Chromium/V8 也不会立即归还高水位内存。
- 解决:`EditorTabs` 只挂载活动标签的 `FileViewer`(`key={activePath}` 保证换文件时重新挂载而不是复用实例)。需要跨切换存活的状态移出组件:未保存缓冲仍在 `editor/draftStore`(并改为可订阅,标签页的 ● 标记从它派生,因为隐藏标签已经没有组件可问,且只在“有草稿的路径集合”变化时通知,打字不再触发工作台重渲染),视图模式/阅读位置/内联展开进新的 `editor/viewerState`;`CodeSurface` 新增 `onScrollLine` 回调把顶部可见行写入 ref,`revealLine` 增加 `align:'top'` 让位置能精确往返。虚拟化/增量编辑模型未做,仍是遗留项。
- 失败尝试:仅关闭标签不能在 10 秒观察窗内释放进程工作集;页面重载可以释放,说明不是项目文件或服务端缓存占用。
- 预防:`apps/web/test/editorState.test.ts` 断言草稿跨卸载存活、订阅只在集合变化时触发、快照引用稳定、关闭标签同时丢弃视图状态。8 × 1 MB 的桌面性能门槛由 `perf/`(2026-08-25 补)承担:`npm run perf:editor` 复现同一负载并判定输入 P95、切换 P95、渲染器峰值与关闭后回落,阈值和修复前的基线一起记在 `perf/thresholds.json`。

## 2026-08-24 — 窄任务面板的操作按钮逐字换行

- 症状:实际 Electron 窗口中,任务面板约 300 px 宽时“上次输出”“运行”按钮被压成竖排文字,操作可用但难读。
- 根因:共享 `BUTTON` 没有 `whiteSpace:nowrap`/`flexShrink:0`;flex 默认 `flex-shrink:1`,所以行内空间不足时收缩的正是按钮(行里其他元素都是 `flex:'none'`,本来就不会被压)。
- 解决:`components/ui.ts` 的 `BUTTON` 加上 `whiteSpace:'nowrap'` 与 `flexShrink:0`(`PRIMARY_BUTTON`/`DANGER_BUTTON` 由它派生,一并生效)。行内可伸缩的只剩命令摘要那一列,它已经是 `flex:1 + minWidth:0 + ellipsis`,继续变窄时先省略命令、再由面板滚动区横向滚动。`ROW` 本身不加 nowrap——诊断中心用同一个 `ROW` 且依赖消息换行。
- 失败尝试:扩大整个窗口仍受已保存面板宽度影响;恢复布局会丢失用户布局,不应作为常规解决方式。
- 预防:为 Dock 最小宽度运行 100%/150% 缩放的截图验收,任务行所有动作必须保持横排可读。

## 2026-08-24 — 主目录切换后立即重载会把“还在加载”渲染成空工作区

- 症状:切换主目录后立刻重载页面,后端 `/api/workspace` 已返回 1 个 root,资源管理器首帧仍显示“工作区 · 0/8 个目录”和“工作区还没有目录”的空状态提示;稍后刷新恢复。
- 根因:`FileTree` 的初始 state 就是「空工作区」,没有「加载中」这一态,首次 `/api/omp/files` 请求失败也不重试——本地服务是桌面外壳一起拉起的进程,切换主目录后重载正好落在它还没应答的窗口里。
- 解决:`FileTree` 增加 `loaded` 状态,首帧显示“正在读取工作区…”,空状态提示只在确认加载完成后出现;`WorkspaceBar` 接受 `loading` 并显示“工作区 · 读取中…”(同时不再据未知的 rootCount 判定已达上限)。首次根列表失败按 200/500/1200 ms 退避重试三次,重试期间不显示错误横幅,最后一次才把原因显示出来。
- 失败尝试:把初始 `rootCount` 当作真实值渲染;仅靠用户手动点「刷新」。
- 预防:首屏相关的验收必须区分“加载中”“加载失败”“确实为空”三态;任何本地 API 的首次请求都不能把未完成当作空结果。

## 2026-08-24 — 应用重启时前端永久保留路由恢复前的空状态

- 症状:BotCF 与第三方模式重启后,`/api/state` 已恢复保存的 route,但界面模型选择仍为空、消息框保持“未选择路由”;等待 5 秒不会收敛,手动重新选择模型后恢复。
- 根因:服务端在 `app.listen()` 后才异步执行 `rearmRoute()`,前端 `App` 只在首次挂载读取一次 state;首次请求命中 `route:null` 后没有收到路由恢复事件,也不再轮询。
- 解决:服务端在开始监听前把 `appState.restoring` 置为真(存在已保存会话时),`/api/state` 一并返回该字段,前端因此能把“还没恢复完”和“确实没有路由”区分开。`rearmRoute()` 结束后清除该标志并通过 `appEvents`(新增 `apps/server/src/appEvents.ts`)向 `/api/omp/events` 推送 `state_changed`,`App` 收到即重新读取 state;同时在 `restoring` 为真时以 1 秒节奏轮询,覆盖“事件早于 EventSource 连接建立”的竞态。
- 失败尝试:页面静置与等待健康轮询均不会更新路由;只有手动重新选模型会触发 `onRouteChanged`。仅广播事件不足够——首帧可能在 SSE 连上之前就已经读到 `route:null`,所以 `restoring` 标志与事件必须同时存在。
- 预防:桌面/便携/Docker 启动 E2E 必须断言已保存 route 在首次可交互帧选中,消息框可立即发送。

## 2026-08-24 — 手动 OMP 回滚只改链接,运行进程和模型路由未切换

- 症状:`POST /api/omp/rollback` 把 `currentVersion` 从 v18.0.3 改成 v18.0.0 并返回成功,但 OMP PID/启动时间完全不变;随后显式 `/api/omp/restart` 才加载 v18.0.0,而重启后第一次第三方 chat 请求又因默认 Anthropic 模型得到 409 空白回答。
- 根因:手动回滚路由只调用 `updater.rollback()`/`swapTo()`,没有执行 updater 的 healthProbe;显式 restart 路由同样只 handshake,没有 `applyActiveRouteToOmp()`。
- 解决:新增 `OmpUpdater.rollbackVerified()`,手动回滚走与自动更新相同的事务:空闲检查 → relink → `healthProbe()`(内部即 stop/start/handshake/重应用 route/真实 prompt)→ 失败时 `swapTo(原版本)` 并再验证一次。`POST /api/omp/rollback` 改用它,验证失败返回 409 并带上原因,不再把 relink 成功当作回滚成功。显式 restart 的另一半此前已由 `omp/runtime.ts` 的 `restartRuntime()` 修好(stop→start→handshake→applyRoute→校验)。
- 失败尝试:仅看到 `currentVersion` 变化不能证明实际进程版本变化;必须同时核对 PID和 `<current>/omp --version`。
- 预防:回滚集成测试断言版本链接、运行 PID、RPC 模型、一次真实 prompt 与失败回滚后的原版本恢复。

## 2026-08-24 — Docker 健康但 amd64/arm64 的 OMP 均不可用

- 症状:amd64 与 arm64 容器 `/health` 均返回 ok 且容器为 healthy,但 `/api/omp/status` 为 `available:true/running:false/RPC 握手超时`;amd64 日志报 `/home/app/.omp` 在只读根文件系统上 EROFS、native addon 缺失,arm64 日志报缺少 `/lib/ld-linux-aarch64.so.1`。
- 根因:Alpine 只读镜像没有给 OMP native 解压目录配置可写 HOME;资产选择只按 linux+arch 匹配,arm64 选到 glibc 二进制而运行时镜像是 musl。容器 healthcheck 只测 HTTP,没有反映核心 AI runtime。
- 解决:镜像把 `HOME` 设为 `/data/home`(可写卷),新增 `docker/entrypoint.sh` 在启动前创建该目录,并在不可写时带明确错误退出而不是留下“HTTP 正常、AI 不可用”的容器;compose 同步该环境变量。`pickReleaseAsset` 增加 libc 维度:musl 主机优先选 musl 资产,没有 libc 标记的 linux 资产次之,glibc 资产只在别无选择时使用(`detectLibc()` 依据 `process.report` 是否报告 glibc 运行时版本判定)。Alpine 运行镜像同时安装 `gcompat`+`libstdc++`,让只发 glibc 资产的版本也能加载。README 写明容器验收必须核对 `/api/omp/status` 而不是 `/health`。
- 失败尝试:只验证 HTTP、非 root、read-only、cap_drop 和多架构 manifest 会得到假阳性;必须等待自动安装完成并检查 `/api/omp/status`。
- 预防:发布门禁实际运行 amd64 与 arm64 容器,要求 OMP handshake + route + prompt,不能以镜像构建成功代替运行验收。

## 2026-08-24 — Windows 发布产物仍使用 Electron 默认图标

- 症状:electron-builder 明确输出 `default Electron icon is used`;portable、Setup 与卸载器均未配置产品图标。
- 根因:`apps/desktop/package.json` 的 build 配置没有 `icon`/`win.icon` 资源。
- 解决:新增 `apps/desktop/build/generate-icon.mjs`(零依赖,用 zlib 直接写 256×256 PNG 并封进 ICO)生成 `build/icon.ico`,`npm run icon -w apps/desktop` 可重跑;`win.icon` 与 nsis 的 `installerIcon`/`uninstallerIcon`/`installerHeaderIcon` 均指向它,`main.cjs` 在未打包运行时也加载同一文件。图标脚本入库,改图不需要设计工具。
- 失败尝试:产品名和版本资源正确不能替代品牌图标;默认 Electron 图标仍会进入最终 exe。
- 预防:安装包截图验收和 PE 资源检查必须验证 ProductName、版本、图标和 Authenticode 四项。

## 2026-08-24 — Git 冲突状态下提交错误原因不准确

- 症状:回滚冲突已被 `/api/git/status` 正确标为 `conflictedCount:1`,此时提交返回“没有已暂存的修改”,没有提示先解决或放弃冲突。
- 根因:提交前置校验先检查暂存区为空,再检查冲突,错误优先级与用户当前阻塞原因相反。
- 解决:`commitStaged` 把冲突检查放到空索引检查之前,冲突时返回“仓库存在未解决的冲突,先解决冲突或放弃回滚,再提交”。顺序是关键——冲突文件本来就不会进暂存区,空索引判定放前面必然抢先命中并盖掉真实阻塞原因。
- 失败尝试:虽然提交被安全拒绝,但当前提示无法指导用户解除 REVERTING 状态。
- 预防:Git 状态机测试覆盖 conflict + empty index 的错误优先级与用户可执行提示。

## 2026-08-25 — 关闭标签后视图状态被卸载清理回写

- 症状:关闭处于前台的标签后,`editor/viewerState` 里仍留着该路径的条目;重新打开同一个文件时会跳回上次的阅读位置,而不是从头开始。被 `maxTabs` 自动淘汰的标签同样不会回收。
- 根因:`useOpenTabs` 的 close/closeOthers/closeAll 在点击时同步 `forgetViewerState(path)`,但视图状态是 `FileViewer` 在**卸载清理**里写的。React 对同一次提交先执行被移除子树的 cleanup、再执行父组件的 effect,所以删除必然早于回写,查看器在卸载路上又把条目放回去了。淘汰路径从来没有删除过任何条目。
- 解决:把“点击时删除某一个”换成“提交后按仍打开的标签集合清扫”。`viewerState` 用 `pruneViewerStates(open)` 取代 `forgetViewerState(path)`,`useOpenTabs` 在依赖 `tabs` 的 effect 里调用它。这与顺序无关——清扫时所有要写的查看器都已经写完——并且四条路径(关闭、关闭其他、全部关闭、自动淘汰)共用同一个出口。草稿仍在点击时立即清除:● 标记和淘汰保留集都从草稿缓存读,它们不能看到一个已经关掉的标签。
- 失败尝试:在 `close()` 里调整删除与 `setTabs` 的先后;两者在同一次提交里,删除总是早于卸载回写。
- 预防:`apps/web/test/editorState.test.ts` 直接构造“标签集合先提交、卸载回写随后发生”的时序并断言条目不再存在,另外覆盖“只保留仍打开的标签”和“存活条目引用不变”。组件级 close/closeOthers/closeAll 的真实 effect 时序验收还需要 DOM 测试环境(jsdom + testing-library),目前仓库未引入。

## 2026-08-25 — 工作区列表读取失败后标题仍显示“读取中…”

- 症状:根列表三次退避重试全部失败后,面板正文已经显示错误横幅,`WorkspaceBar` 的标题仍是“工作区 · 读取中…”,读起来像还在加载,而“刷新”就在旁边却没有被指向。
- 根因:标题只有 `loading = !loaded` 一个布尔量,“失败”和“加载中”共用同一个取值;正文判断用 `error`、标题判断用 `loaded`,两个来源可以互相矛盾。
- 解决:新增 `workspace/status.ts` 的 `workspaceStatus({loaded, failed})` → `'loading' | 'failed' | 'ready'`,标题和正文共用同一个值。失败时标题显示“工作区 · 无法读取”并提示点击刷新重试;`loaded` 优先,已经拿到过列表之后某次刷新失败只显示错误横幅,不会把树丢掉并改称工作区不可读。
- 失败尝试:只在正文补错误横幅——标题仍然在说“读取中”,而标题是先看到的那一行。
- 预防:`apps/web/test/workspaceStatus.test.ts` 断言三态互斥、失败不等于加载中、以及 loaded 优先于后续失败。首屏验收沿用同一条规则:加载中、失败、确实为空必须是互斥且可观察的三态,标题和正文只能有一个状态机。

## 2026-08-25 — Windows 图标生成器未接入干净发布流程

- 症状:当前工作区没有 `apps/desktop/build/icon.ico`;实际执行 `npm run dist:desktop` 时 electron-builder 先输出 `default Electron icon is used`,随后 NSIS 因找不到 `build/icon.ico` 退出。新生成的 `win-unpacked/BotCF-Local.exe` 图标指纹与 `node_modules/electron/dist/electron.exe` 相同。
- 根因:只新增了 `generate-icon.mjs` 和手动 `npm run icon` 脚本;`.ico` 没有入库,`dist`/`dist:desktop` 也没有依赖图标生成步骤。配置指向一个干净检出中不存在的文件。
- 解决:发布入口从 `electron-builder --win` 换成 `apps/desktop/build/dist.mjs`,它按顺序做四件事并对每一件判定:确定性生成 `icon.ico` → 校验容器内确有 256×256 PNG → 运行 electron-builder 并监视日志中的 `default Electron icon is used` → 用 `build/icon-pe.mjs` 直接从产物 PE 里读回 RT_ICON 资源,与 `.ico` 载荷做逐字节比对。主程序、Portable、Setup 三个 PE 都必须匹配。卸载器的图标由 NSIS 在编译期写进压缩负载、无法回读,脚本改为断言三个 NSIS 图标槽位都指向生成物,并把"这一项是配置断言而非资源回读"打印出来,不冒充已验证。`.ico` 同时入库(`.gitattributes` 标记为 binary),直接调用 electron-builder 也不会再撞上缺文件。
- 失败尝试:只在 electron-builder 配置里填写 `win.icon`/NSIS 图标路径;路径存在于配置不等于资源存在。
- 预防:从干净检出执行完整 `npm run dist:desktop`,断言退出码为 0、日志不含 `default Electron icon`、主 exe/Portable/Setup 的图标资源均为产品图标——这三条现在由发布入口自己执行,不再依赖人工验收。

## 2026-08-25 — arm64 Docker 在 QEMU 下仍超过 RPC 握手窗口

- 症状:当前多架构镜像实测中,amd64 自动安装 v18.0.4 后为 `running:true/protocolError:null`;arm64 已正确下载 musl 资产(文件 SHA256 `438a8541d87796711af24fdc7dc5e00e88eefc8a5ae75e92039e874cca1aa217`,`omp --version` 正常),但 `/api/omp/status` 仍为 `running:false`,错误为 `RPC 握手失败:等待 ready 帧超时`。显式 `/api/omp/restart` 同样失败;同一二进制手动运行最终能发出 `ready`。
- 根因:glibc 资产误选和只读 HOME 已修复,但 `OmpRpcClient.handshake()` 的 ready 等待仍固定为 10 秒;arm64 二进制在 x64 主机 QEMU 模拟下启动慢于该窗口,健康事务先将其停掉。
- 解决:新增 `apps/server/src/omp/startupBudget.ts`,把"一个写死的 10 秒"换成按机器推导、带上下界的启动预算。关键不是把窗口调大,而是先让"坏"和"慢"分开:`waitReady()` 现在在子进程 `exit`/`error` 的那一刻就失败(此前进程 0.5 秒就死掉也要等满整个窗口),所以坏二进制仍然是毫秒级失败,更宽的天花板只由"活着但还没说话"的进程付。在此基础上,只有检测到 CPU 模拟(内核报 arm64、`/proc/cpuinfo` 却是 x86 字段——qemu-user 不改写这个文件)时才放宽到 240 秒,原生机器保持 20 秒。`get_state` 保留独立且短得多的超时(原生 5 秒 / 模拟 30 秒),启动慢不能掩护 RPC 循环卡死。所有上限一律夹紧(ready ≤ 600 s、state ≤ 120 s),`OMP_STARTUP_PROFILE`/`OMP_READY_TIMEOUT_MS`/`OMP_STATE_TIMEOUT_MS` 的覆盖也过同一道夹紧,任何配置都不能把握手退回成无界等待。spawn→ready 实测值记录在 `/api/omp/status.startup`(含 p50/p95),下一次调整这些数字要拿它说话。
- 失败尝试:再次调用显式 restart;缓存已热仍在同一 10 秒窗口失败。安装 `gcompat` 不能解决已选中 musl 二进制的启动耗时。
- 预防:`ci/verify-docker-omp.sh` 在指定平台构建并启动镜像(只读根文件系统、用户 1001),等待自动安装完成后断言 `/api/omp/status` 为 `running:true` 且 `protocolError:null`,并打印启动画像与 spawn→ready 分位数。脚本明确不把 `/health` 或 `omp --version` 当作通过条件——那正是上一轮漏判的两个绿灯。

## 2026-08-25 — 编辑器性能门槛可永久停在驱动阶段

- 症状:`npm run perf:editor` 两次完成构建、夹具和工作区初始化后永久停在 `[perf] driving the editor…`;一次超过 15 分钟,一次独占运行超过 3 分钟,均没有生成 `perf/last-run.json`,只能外部终止。终止后服务端口已关闭,但第二次留下的临时 data 目录需要额外清理。
- 根因:驱动的大多数 DOM 等待有 60 秒 deadline,但 `nextFrame()` 直接等待 `requestAnimationFrame` 且没有超时,main 进程对整段 `executeJavaScript` 也没有总 watchdog;桌面会话不再投递 frame callback 时没有任何路径能失败并进入 `finally`。
- 解决:每个异步原语都加了可诊断的上限——帧回调 5 秒、单条 DOM 等待 60 秒、渲染侧整段驱动 5 分钟、整次运行 8 分钟(`--budget` / `PERF_BUDGET_MS`)。驱动改为**返回**失败而不是抛异常穿过 `executeJavaScript`:`{ok:false, stage, message, diagnostics, partial}` 带着死亡阶段、当时的 `document.visibilityState`/`hidden`/已投递帧数,以及已经测到的分位数,main 进程把它写进 `last-run.json` 的 `failure` 区块。驱动还会通过 console 通道持续上报阶段,所以即使渲染进程一个字都没返回,报告里也有最后的位置。总时限用尽时由 watchdog 走同一条写报告的路径,窗口、服务、夹具、临时 data 目录的清理移进 `finally`(此前抛异常会把采样定时器留在事件循环里)。另外补上最可能的根因:Windows 上被其他窗口盖住即算 occluded,Chromium 会停发帧回调,而 `backgroundThrottling:false` 不覆盖这条路径——现在显式追加 `disable-backgrounding-occluded-windows` 等开关并把窗口置顶,并在驱动开头先等一帧,让"帧时钟不走"在最便宜的地方就失败。
- 失败尝试:停止 Docker、浏览器和其他重负载后独占重跑;仍停在同一阶段,所以不能把第一次挂起只归因于并发负载。
- 预防:性能门禁自身必须有小于 CI job timeout 的总时限,每个异步原语都可取消,且失败路径也要写结构化结果并清理窗口、服务、夹具和临时数据。
