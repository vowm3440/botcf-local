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
| 独立桌面软件(Electron,零原生依赖)+ 74 个单元测试 + BotCF 接口契约文档 + README | [OK] |

## 二、本轮执行结果(2026-08-15)

| 阶段 | 实机验收结果 |
|------|--------------|
| P0 收口与版本控制 | [OK] Git 首次提交;7 个占位文件删除;Windows 安装包构建并启动 |
| P1 OMP 结构化体验 | [OK] UI 请求应答、工具卡片/diff、会话恢复/切换/新建、steer、工作目录均接通;在指定目录完成真实 `read` 工具任务 |
| P2 用量费用 | [OK] 2s/15s 补刷;显示最近请求 `$0.0048 (15791+9 tok)`;OMP 每轮 Token 与上下文占用非零 |
| P3 升级链路 | [OK] 握手+set_model+prompt 冒烟;坏二进制探针序列 `[false,true]` 后自动回滚;通道 UI;effective_context 注入 |
| P4 发布工程 | [OK] Docker hardened runtime 实测;amd64/arm64 OCI;SmartScreen 说明;全库审计 |

升级下载现在强制校验合法版本标签和 64 位 SHA256;已有缓存二进制也会重新计算摘要后才切换。
安装包与 Docker 交付物的最终路径和摘要见本轮审计报告。

## 三、执行清单(已验收)

### P0:收口与版本控制
- [x] git init + 首次提交
- [x] 删除 7 个占位文件
- [x] 构建并启动 `BotCF-Local Setup 0.1.0.exe`

### P1:OMP 结构化体验
- [x] `extension_ui_request` / `extension_ui_response`
- [x] 工具调用、输出和文件 diff 结构化渲染
- [x] 会话历史、列表、切换与新建
- [x] 流式 steer
- [x] 工作目录选择器与真实工具任务

### P2:用量费用
- [x] 回答后 2s / 15s 补刷
- [x] 单次请求实际扣费
- [x] OMP `get_session_stats` 每轮 Token

### P3:升级链路
- [x] 安装后握手 + set_model + prompt 冒烟
- [x] 坏二进制自动回滚实测
- [x] fast / stable / experimental 通道 UI
- [x] OMP 自定义 provider 注入 effective_context

### P4:发布工程
- [x] Docker 非 root、cap_drop、只读 rootfs、回环端口实测
- [x] linux/amd64 + linux/arm64 OCI
- [x] 全库安全审计
- [x] Windows SmartScreen 未签名提示说明
- [x] 安装包与 Docker 两种形态启动验收

---

## 附:遗留小事项清单

- [x] 已删除 BotCF 账户验证期 `omp-local-verify` Key(id 22052)
- [ ] 账户持有人轮换曾出现在旧脚本中的 BotCF 密码(软件不保存明文密码,无法代操作)
- [x] `botcf_contract_result.txt` 已由 `.gitignore` 排除,`git check-ignore` 验证通过
- [x] 已删除 web 端无用 fastify/@fastify/static 依赖
