# BotCF 本地控制台 · 下一阶段计划

> 生成日期:2026-08-15
> 当前状态基线:桌面版日常可用;OMP RPC 模式已确认运行(顶部显示「运行中 v17.3.4」),
> 即登录、分组专用 Key、模型路由、OMP 结构化对话、上下文占用展示、自动跟版全链路已实机验证。

---

## 一、已完成(经实机验证)

| 方案条目 | 状态 |
|---------|------|
| 本地控制服务 + BotCF 适配器 + 凭据代理 + SQLite 加密存储 | ✅ |
| 密码登录(实测无验证码)+ 管理 Token 保底 + 会话加密持久化 | ✅ |
| 分组专用 Key `omp-local-{设备}-{分组}` 查找/复用/创建,不碰共享 Key | ✅ |
| 分组→接口路由(codex→Responses、claude→Messages、Max 禁用、生图/视频隐藏)+ 模型按家族过滤 | ✅ |
| 上下文能力库(declared/verified/effective + 置信度)+ 分级标签 + 超限自动降级 + 压缩阈值公式 | ✅ |
| 余额美元换算(quota_per_unit)、30s/2min 同步、失败可见、路由重启自动恢复 | ✅ |
| OMP RPC 真协议:ready 握手、prompt 事件流、set_model、上下文占用、中止 | ✅ 运行中 v17.3.4 |
| OMP 自动跟版:检测→下载→SHA256→空闲切换,协议不兼容自动降级直连 | ✅ |
| 安全基线:密码不落盘、AES-256-GCM、master.key 0600、日志脱敏(带单测)、仅回环监听 | ✅ |
| 独立桌面软件(Electron,零原生依赖)+ 54 个单元测试 + BotCF 接口契约文档 + README | ✅ |

## 二、原方案中尚未完成的部分

### A. 工程根基缺口(最紧急、最容易)
1. **项目没有 git 仓库**——全部代码无版本控制,当前最大工程风险
2. 安装包 `dist:desktop`(electronVersion 修复后)的构建结果未确认;Docker 镜像从未实际构建运行(compose 中非 root / cap_drop / 只读 rootfs 等安全项因此未实测)
3. 7 个 `export {}` 占位文件待物理删除

### B. 原阶段 3「完整 OMP 结构化界面」只完成了一半
4. **工具执行确认对话框未实现**:OMP 的 `extension_ui_request`(confirm/select/input)当前不应答,超时走默认值——工具执行实际上无人审批,与「确认操作」设计意图不符,兼具安全属性
5. 工具调用只显示一行名称,缺参数、输出、文件 diff 的结构化展示
6. **会话管理未接**:界面刷新消息即丢;OMP 侧有会话文件与 `get_messages_page` / `new_session` / `switch_session`,但无历史恢复与会话列表 UI
7. 流式中不能追加消息(OMP 支持 steer / follow_up,当前输入框直接禁用)
8. **OMP 无工作目录概念**:spawn 未设 cwd,原方案 `/workspaces`「用户选择项目目录」在桌面版没有等价物

### C. 用量与升级链路收尾
9. 回答完成后 2s/15s 补刷未做;单次请求实际扣费(`/api/log/self`)未展示;OMP 模式缺 per-turn token(可接 `get_session_stats`)
10. 升级的「CI 兼容测试 + 签名清单」是弱化版(现状:直接装上游 Release,靠握手探测降级);回滚从未实测
11. 更新通道(fast/stable/experimental)切换无 UI

### D. 已知风险项
- OMP 对 BotCF 自定义模型名(如 `gpt-5.6-terra-openai-compact`)的 `set_model` 接受度未逐一验证,个别模型可能报 Model not found(有降级兜底,但体验是静默回直连)
- OMP 自动压缩使用它自己目录的窗口值,**未必尊重我们的 effective_context**——1M 路由可能被 OMP 按更小窗口提前压缩;需研究 OMP 模型配置文件,把能力库数值注入

## 三、下一阶段计划

### P0:收口与版本控制(半天)
- git init + 首次提交(.gitignore 已就绪)
- 删除 7 个占位文件
- 确认 `npm run dist:desktop` 安装包产物可安装可用
- **验收**:有版本历史;安装包可分发

### P1:OMP 结构化体验补全(4–6 天,核心价值)
- 工具确认对话框(应答 `extension_ui_response`)
- 工具调用 / 文件 diff 结构化渲染
- 会话历史恢复(`get_messages_page`)、会话列表、`new_session`
- 流式中 steer(追加引导消息)
- 工作目录选择器(spawn cwd 指向用户项目目录)
- **验收**:刷新页面会话不丢;工具执行需界面确认;能指定项目目录完成一次真实编码任务

### P2:用量费用完善(1–2 天)
- 响应后 2s / 15s 补刷
- 从 `/api/log/self` 显示单次请求实际扣费
- OMP 模式接 `get_session_stats` 展示 per-turn token
- **验收**:面板数值与 BotCF 控制台可对账

### P3:升级链路加固(2–3 天)
- 安装后自动冒烟(握手 + set_model + 一次 prompt),失败自动回滚——替代完整 CI 的务实方案
- 注入坏二进制实测回滚
- 通道切换 UI
- 研究 OMP 模型配置注入 effective_context(解决 1M 路由压缩线问题)
- **验收**:坏版本发布场景全自动恢复

### P4:发布工程(2–4 天)
- Docker 实测(含安全项验证)+ 多架构镜像(amd64/arm64)
- security-reviewer 全库安全审计
- Windows SmartScreen 未签名提示的应对说明
- **验收**:安装包与 Docker 两种形态均可交付第三方使用

**总量约 2–3 周;建议顺序 P0 → P1,P2–P4 可按使用痛点调序。**

---

## 附:遗留小事项清单

- [ ] BotCF 账户里验证期创建的 `omp-local-verify` Key(500K 额度)可在控制台删除
- [ ] 建议修改曾以明文出现在旧脚本中的 BotCF 密码
- [ ] `botcf_contract_result.txt` 含账户信息,已在 .gitignore,注意不要手动提交
- [ ] web 端 `package.json` 中混入的 fastify/@fastify/static 依赖可清理(无害)
