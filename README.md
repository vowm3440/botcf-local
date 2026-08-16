# BotCF 本地控制台

以 BotCF(botcf.com)为远端账户/分组/模型/计费中心的本地 AI 工作台:
浏览器或桌面窗口打开即用,凭据只存在本机加密库中,OMP 执行引擎可独立热更新。

## 功能

- **BotCF 账户接入**:账号密码或管理 Token 登录;余额/用量实时同步(按站点 `quota_per_unit` 换算美元)
- **分组专用 Key**:为所选分组自动查找/创建 `omp-local-<设备ID>-<分组>` 专用 Key,绝不改动已有共享 Key
- **动态模型目录**:分组聚合自默认分组、已有 Key、`/api/user/self/groups` 与公开 pricing 接口——未建过 Key 的分组同样可见;模型优先按 pricing 的 enable_groups 精确过滤,缺数据时回退家族启发式;图像/视频分组自动隐藏;分组每 5 分钟与网站自动同步,「立即同步」即时刷新;`/api/groups/debug` 可诊断各来源实际返回
- **诚实的上下文能力库**:每条「分组+模型+接口」路由独立记录 declared/verified/effective 三层上下文与置信度(已验证/文档确认/推断),上游报 context 超限自动降级
- **多接口路由**:codex 分组走 OpenAI Responses,claude 分组走 Anthropic Messages,其余走 Chat Completions;思考等级取三方交集
- **凭据代理**:OMP/前端永远只接触 `127.0.0.1:7789` 本地代理,真实 Key 由代理注入;日志全量脱敏
- **变更文件可见**:每轮回答结束展示 OMP 修改过的文件;侧栏文件面板浏览工作目录(变更标记、每轮自动刷新),点击任意文件打开只读查看器,变更文件附带 GitHub 风格差异高亮视图
- **OMP Runtime 热更新**:GitHub Releases 自动跟版(快速/稳定/实验三通道)、SHA256 校验、空闲切换、健康检查失败秒级回滚;未安装 OMP 时自动降级为直连模式
- **加密存储**:BotCF 会话与 Key 用 AES-256-GCM 加密落盘,master.key 权限 0600

## 运行方式

### 开发模式

```bash
npm install
npm run dev:server   # 控制服务 127.0.0.1:7788 + 凭据代理 127.0.0.1:7789
npm run dev:web      # Vite 开发服务器(已配置 /api 代理)
```

### 桌面应用(开发)

```bash
npm run desktop      # 构建后以 Electron 窗口运行,需系统 Node 22+
```

### 独立安装包

```bash
npm run dist:desktop # 产出 apps/desktop/release/BotCF-Local Setup x.y.z.exe
```

安装包内置 Electron 运行时并使用 esbuild 单文件服务端 bundle,**最终用户无需安装 Node**。
数据目录:`%APPDATA%/botcf-desktop/data`。

#### Windows SmartScreen(未签名安装包)

当前安装包未使用 EV/OV 代码签名证书,首次下载可能显示「Windows 已保护你的电脑」。
仅从项目发布渠道获取安装包,先用 `Get-FileHash -Algorithm SHA256 "<安装包路径>"` 校验发布页摘要;
摘要一致时可点击「更多信息」→「仍要运行」。不要关闭 SmartScreen 或修改系统安全策略。
面向公众发布前应为安装包和卸载器配置受信任的 Authenticode 签名。

### Docker

```bash
cd docker
docker compose up -d   # 仅绑定 127.0.0.1:7788
```

容器非 root、`cap_drop: ALL`、只读根文件系统(仅 /data、/tmp 可写)。
项目目录需要显式添加 volume 才会进入容器。
多架构离线产物可用 `docker buildx build --platform linux/amd64,linux/arm64 --output type=oci,dest=botcf-local-multiarch.tar -f docker/Dockerfile .` 构建。

## OMP 配置

界面顶部 OMP 区域可配置固定的官方仓库 `can1357/oh-my-pi`,
或设置 `OMP_GITHUB_REPO=can1357/oh-my-pi`。其他仓库会被拒绝。更新器每 10 分钟检查 Release:

| 通道 | 行为 |
|------|------|
| fast(默认) | 发布约 15 分钟后自动安装 |
| stable | 延迟 24 小时 |
| experimental | 立即安装 |

版本布局:`/data/omp/versions/<tag>/`,`current`/`previous` 链接切换。
安装前强制校验版本标签和 64 位 SHA256(含已有缓存),安装后执行握手、set_model、真实 prompt;失败自动回滚并复测 previous。

## 安全设计

- 密码只用于单次登录请求,不落盘、不写日志
- 会话/Key 密文存 SQLite(AES-256-GCM),密钥在 `data/secrets/master.key`(0600)
- 日志自动遮盖密码、Cookie、Authorization、`sk-` Key
- 所有监听仅绑定 127.0.0.1;Docker 端口映射同样只绑回环
- 控制面强制回环 Host 与同源 Origin;凭据代理使用每进程 256-bit capability 并绑定当前模型
- 分组切换记录 `session_routes`,旧会话保留原路由,避免账单混淆

## 目录结构

```
apps/server   控制服务:BotCF 适配器、凭据代理、能力库、OMP RPC/更新器
apps/web      React 前端(登录、顶部路由栏、流式对话)
apps/desktop  Electron 壳(开发用系统 Node;打包用内嵌 Node + 单文件 bundle)
docker/       Dockerfile 与 compose
docs/         BotCF 管理接口契约(实测)
```

## 测试

```bash
npm test   # vitest:123 个测试,覆盖脱敏、代理授权、能力解析、路由、分组目录、updater、SSE/会话解析、变更文件跟踪、文件列表/内容接口
```

## 故障排查

| 现象 | 处理 |
|------|------|
| 登录报 502 | 看服务端日志(已脱敏);BotCF 会话过期需重新登录 |
| 端口被占 | 7788/7789 被旧进程占用,关闭后重启 |
| ExperimentalWarning: SQLite | Node 22 下的正常提示,Node 24+ 无此警告 |
| 桌面版启动即退 | 开发模式需系统 Node 22+ 在 PATH;安装包版无此要求 |
