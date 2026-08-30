# BotCF 两份报告问题复核（2026-08-25）

## 结论

**没有全部修复。** 当前 11 项问题的判定：

- 已修复：6 项
- 基本修复但缺真实外部链路实测：2 项
- 部分修复：2 项
- 未修复：1 项

阻止“全部关闭”的三项硬证据：

1. Windows 图标：`apps/desktop/build/icon.ico` 不存在；`npm run dist:desktop` 输出 `default Electron icon is used`，随后 NSIS 因找不到该文件失败。
2. Docker arm64：已选中正确的 v18.0.4 musl 资产，但 QEMU 下 `/api/omp/status` 仍为 `running:false`，固定 10 秒 ready 超时。
3. 编辑器性能：8 × 1 MB 门槛两次停在 `[perf] driving the editor…`，无 `perf/last-run.json`，性能指标仍不可判定。

## 逐项判定

| 来源 | 问题 | 判定 | 当前证据 |
|---|---|---|---|
| 修复报告 P1-001 | OMP 重启/主根切换后未重应用活动路由 | 基本修复 | `restartRuntime()` 统一 stop → start → handshake → applyRoute；主根、显式 restart、更新 healthProbe 均复用。真实 RPC 线级假进程契约与单元测试通过；仍未使用真实 OMP + 活动凭据完成 prompt。 |
| 修复报告 P1-002 | terminal `agent_end` 错误显示为空白回答 | 已修复 | terminal outcome 分类、脱敏 SSE error、诊断中心接线存在；`chat-terminal-stream.test.ts` 与分类测试通过。 |
| 修复报告 P1-003 | 非法项目配置覆盖有效配置 | 已修复 | 写路径用 `checkProjectConfig*` 在 `saveProjectConfig()` 前拒绝；非法 JSON/空文本/非对象及文件字节、mtime 哨兵测试通过。 |
| 修复报告 P2-004 | 8 个近 1 MB 文件导致高延迟/高内存 | 部分修复 | 只挂载活动 `FileViewer`；草稿/视图状态外置；关闭后的回写竞态已改为提交后 `pruneViewerStates()`。但性能门槛本身两次挂死，未取得 P95/峰值/回落数据。 |
| 修复报告 P3-006 | 300 px 任务面板按钮逐字换行 | 已修复 | 实际浏览器把任务行约束到 300 px；“上次输出”“运行”均为 `white-space: nowrap`、`flex-shrink: 0`，各只有一个文本 rect。 |
| 修复报告 P3-007 | 首次工作区请求失败被渲染成 0/8 空态 | 已修复 | 实际浏览器注入四次 503，请求约发生于 10/215/721/1933 ms；最终显示“工作区 · 无法读取”和错误，不显示加载中/空态。 |
| 补充报告 P1 | 重启后前端永久保留 route 恢复前空状态 | 已修复 | 服务端暴露 `restoring` 并发 `state_changed`；前端 1 秒轮询兜底。浏览器首帧 `route:null/restoring:true`，约 1.05 秒后二次 state 收敛到 group/model/thinking，输入框启用。 |
| 补充报告 P1 | 手动 rollback 只改链接，不做热切换事务 | 基本修复 | `/api/omp/rollback` 调用 `rollbackVerified()`；失败切回原版本并再次 healthProbe。回滚与恢复测试通过；本轮没有使用两个真实 OMP 版本和真实 prompt 做破坏性实测。 |
| 补充报告 P1 | Docker amd64/arm64 HTTP 健康但 OMP 不可用 | 部分修复 | amd64 当前镜像自动安装 v18.0.4 后 `running:true/protocolError:null`；`HOME=/data/home`。arm64 正确 musl 资产 SHA256 为 `438a…217`，二进制可运行并最终发 ready，但服务端 10 秒握手窗口先超时，status 仍 `running:false`。 |
| 补充报告 P3 | Windows 发布产物使用 Electron 默认图标 | 未修复 | 图标生成脚本存在，但生成物不存在且发布脚本不调用它。实际构建明确使用默认 Electron 图标并失败。 |
| 补充报告 P3 | Git 冲突时提交错误原因优先级错误 | 已修复 | `commitStaged()` 先检查 `conflictedCount` 再检查空暂存区；真实临时 Git 冲突测试通过。 |

## 修复报告“残余风险”复查

1. **真实活动路由 E2E**：新增 `omp-route-contract.test.ts`，覆盖真实 JSONL/RPC 线协议、provider 映射、状态校验和 prompt 接受；但被测进程仍是假 OMP，真实二进制 + 真实凭据链路仍缺。
2. **SSE/诊断集成**：已新增 `chat-terminal-stream.test.ts`，本轮通过；此项可关闭。
3. **关闭标签回写竞态**：已改为父 effect 中按已提交标签集合清扫，状态测试通过；报告中的确定性竞态已修复。组件级 React DOM close/closeOthers/closeAll 时序测试仍未引入，但当前算法不再依赖点击与 cleanup 的先后。
4. **8 × 1 MB 性能数据**：仓库已有门槛和阈值，但执行器存在无界 `requestAnimationFrame` 等待；本轮两次无结果，不能关闭。
5. **WorkspaceBar 失败文案**：已引入统一 `workspaceStatus` 三态；浏览器实测关闭。

## 验证证据

### 自动化

- 针对性 Server：8 文件 / 143 测试，通过。
- 针对性 Web：2 文件 / 14 测试，通过。
- 完整 `npm test`：Server 39 文件 / 528 测试；Web 15 文件 / 263 测试；合计 54 文件 / 791 测试，全部通过。
- `npm run build`：Web TypeScript + Vite、Server TypeScript，通过；生产 JS 332.60 kB，gzip 104.48 kB。
- `npm run dist:desktop`：失败；默认 Electron 图标 + 缺失 `build/icon.ico`。

### 实际表面/运行时

- 浏览器：启动 route 收敛、300 px 任务按钮、工作区 503 退避与失败态均实测。
- Docker amd64：镜像构建、受限容器启动、自动安装 OMP、RPC status 与 `omp/18.0.4` 版本实测。
- Docker arm64：QEMU 镜像构建/启动、musl 资产摘要、`omp --version`、手动 RPC ready、服务端握手失败均实测。
- 编辑器性能：两次执行均挂起；第二次已停止其他重负载后独占复测，结果相同。

## 新增问题与根因

### Windows 图标发布链路

问题：配置引用 `build/icon.ico`，但文件既未入库也未由 `dist` 生成。

决定：不能按“代码里有 icon 配置”判定修复；必须以干净发布命令和 PE/安装器资源为准。

预防：让发布脚本确定性生成图标或提交生成物；门禁拒绝 `default Electron icon`，并检查主 exe、Portable、Setup、卸载器。

### arm64 QEMU 握手预算

问题：资产兼容性已修复，但 QEMU 冷启动慢于 `OmpRpcClient.handshake()` 的 10 秒固定窗口。

决定：Docker 原 P1 不能关闭。需要依据 spawn→ready 实测分位数设置可控的模拟/冷启动预算；`get_state` 保持独立超时。

预防：多架构门禁必须断言 `/api/omp/status.running:true/protocolError:null`，不能停在 `--version` 或 `/health`。

### 性能门槛无界等待

问题：DOM `waitFor` 有 deadline，但 `nextFrame()` 和 main 进程的整段 `executeJavaScript` 没有总 watchdog；frame callback 不再投递时永久等待。

决定：当前无法用这条门槛证明 P2-004 的性能目标。

预防：每个异步原语可超时/取消；总时限短于 CI timeout；失败路径也写阶段化结构结果并清理。

## 清理

- 两个测试容器、测试卷、测试镜像已删除。
- Docker Desktop 已恢复为停止状态。
- 浏览器、Vite、Electron 性能进程和临时性能数据已退出/清理。
- 发现的问题已追加到 `ISSUES_LOG.md`。

## 关联 Artifact

- 核验计划：`local://botcf-fix-verification-plan.md`
