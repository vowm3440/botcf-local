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
