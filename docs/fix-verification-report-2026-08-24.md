# BotCF 修复核验报告（2026-08-24）

## 结论

六项修复的代码均已落地，完整回归与生产构建通过。P1-001、P1-002、P1-003、P3-006、P3-007 的原始故障路径已被当前实现阻断；P2-004 的核心架构修复（只挂载活动查看器、草稿/视图状态外置）通过，但尚不能宣称性能问题完整关闭：本轮没有重跑 8 × 1 MB 桌面性能门槛，且关闭活动标签时视图状态存在清理顺序残余风险。

| 项目 | 判定 | 核验依据 |
|---|---|---|
| P1-001 | 通过（缺真实活动路由 E2E） | `restartRuntime()` 执行 stop → start → handshake → applyRoute；失败再次 stop 并诊断。主根切换、显式重启、更新 healthProbe 三处复用。7 个测试覆盖顺序、无路由、不可用、start/handshake/apply/状态校验失败。 |
| P1-002 | 通过（缺 SSE/诊断集成测试） | terminal `agent_end` 调用 `terminalOutcome()`；error 经过 `redact()` 后写 SSE `type:error` 与诊断中心；length/aborted/normal 分流。当前 `terminalOutcome` 套件 9 个用例。 |
| P1-003 | 通过 | 读路径继续容错；写路径使用 `checkProjectConfig*`，非法 JSON/空文本/非对象根返回 400，拒绝发生在 `saveProjectConfig()` 前。测试验证哨兵、文件字节和 mtime 不变。 |
| P2-004 | 部分通过 | 浏览器实测两个标签切换时始终只有 1 个 textarea/FileViewer；`a → b → a` 后草稿 `edited-a` 保留。未重跑 8 × 1 MB 性能压测；关闭活动标签时 `forgetViewerState()` 先执行、随后 FileViewer unmount cleanup 又执行 `rememberViewerState()`，可能重新留下已关闭标签的轻量视图状态。 |
| P3-006 | 通过 | 300 px 实际浏览器组件面板中，“上次输出”“运行”计算样式均为 `white-space: nowrap`、`flex-shrink: 0`，文本各 1 个 rect，未逐字换行。 |
| P3-007 | 通过（轻微状态文案残余） | 浏览器注入前三次 503、第四次成功；请求发生于约 3/204/716/1919 ms，重试期间显示加载中且不显示空态/错误，成功后显示 1/8。连续失败时第 4 次才显示错误且不显示空态；但 WorkspaceBar 仍显示“读取中…”，失败态标题不够准确。 |

## 自动化与构建证据

- 针对性 Server：3 文件、71 测试通过。
- 针对性 Web：`editorState.test.ts` 7 测试通过。
- 完整 `npm test`：Server 37 文件 / 503 测试；Web 14 文件 / 256 测试；合计 51 文件 / 759 测试，全部通过。
- `npm run build`：Web TypeScript + Vite、Server TypeScript 全部通过；生产 JS 331.84 kB，gzip 104.19 kB。

## 残余风险与建议

1. 为 P1-001 增加真实契约 E2E：选择 chat 路由 → 切换主根 → `get_state` provider/model 一致 → prompt 成功。当前单元测试的 `applyRoute` 是注入 seam，不能替代真实 RPC。
2. 为 P1-002 增加流级测试，直接断言 error `agent_end` 同时产生脱敏 SSE 和诊断记录；当前测试只覆盖分类器。
3. 修正 P2-004 的关闭顺序：让卸载清理识别“标签已关闭”，或把视图状态删除安排在卸载之后；增加组件级 close/closeOthers/closeAll 测试。
4. 用原报告相同的 8 × 1 MB 场景重跑输入 P95、标签切换 P95、renderer 峰值和关闭后回落，建立可判定阈值。没有这组数据，不能证明性能症状达到目标。
5. P3-007 最终失败后将 WorkspaceBar 从“读取中…”切换为明确失败/未知状态；核心“加载未完成不得显示 0/8 空工作区”已经解决。

## Lessons learned

- 纯函数测试能证明分类和事务顺序，不能证明 SSE、诊断、RPC 等真实接线；关键路径需要契约/E2E。
- React 状态清理必须按 effect cleanup 的真实时序验证；直接测试 Map 的 set/delete 会漏掉卸载回写竞争。
- 性能重构只有在原负载、原指标和预先定义的阈值上复测后才能关闭性能问题。
- 加载、失败、空结果必须是互斥的可观察状态；标题和正文应使用同一状态机。
