# BotCF 本地控制台

以 BotCF(botcf.com)为远端账户/分组/模型/计费中心的本地 AI 工作台:
浏览器或桌面窗口打开即用,凭据只存在本机加密库中,OMP 执行引擎可独立热更新。

## 功能

- **BotCF 账户接入**:账号密码或管理 Token 登录;余额/用量实时同步(按站点 `quota_per_unit` 换算美元)
- **分组专用 Key**:为所选分组自动查找/创建 `omp-local-<设备ID>-<分组>` 专用 Key,绝不改动已有共享 Key
- **动态模型目录**:分组、模型全部实时来自 BotCF,按分组家族过滤;图像/视频分组自动隐藏
- **诚实的上下文能力库**:每条「分组+模型+接口」路由独立记录 declared/verified/effective 三层上下文与置信度(已验证/文档确认/推断),上游报 context 超限自动降级
- **多接口路由**:codex 分组走 OpenAI Responses,claude 分组走 Anthropic Messages,其余走 Chat Completions;思考等级取三方交集
- **凭据代理**:OMP/前端永远只接触 `127.0.0.1:7789` 本地代理,真实 Key 由代理注入;日志全量脱敏
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

### Docker

```bash
cd docker
docker compose up -d   # 仅绑定 127.0.0.1:7788
```

容器非 root、`cap_drop: ALL`、只读根文件系统(仅 /data、/tmp 可写)。
项目目录需要显式添加 volume 才会进入容器。

## OMP 配置

界面顶部 OMP 区域点击「配置仓库」粘贴 OMP 的 GitHub 仓库(`owner/repo`),
或设置环境变量 `OMP_GITHUB_REPO`。配置后更新器每 10 分钟检查上游 Release:

| 通道 | 行为 |
|------|------|
| fast(默认) | 发布约 15 分钟后自动安装 |
| stable | 延迟 24 小时 |
| experimental | 立即安装 |

版本布局:`/data/omp/versions/<tag>/`,`current`/`previous` 链接切换,
`update-state.json` 记录状态;健康检查失败自动回滚 previous。

## 安全设计

- 密码只用于单次登录请求,不落盘、不写日志
- 会话/Key 密文存 SQLite(AES-256-GCM),密钥在 `data/secrets/master.key`(0600)
- 日志自动遮盖密码、Cookie、Authorization、`sk-` Key
- 所有监听仅绑定 127.0.0.1;Docker 端口映射同样只绑回环
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
npm test   # vitest:脱敏、能力解析、路由分类、updater 状态机、SSE 解析
```

## 故障排查

| 现象 | 处理 |
|------|------|
| 登录报 502 | 看服务端日志(已脱敏);BotCF 会话过期需重新登录 |
| 端口被占 | 7788/7789 被旧进程占用,关闭后重启 |
| ExperimentalWarning: SQLite | Node 22 下的正常提示,Node 24+ 无此警告 |
| 桌面版启动即退 | 开发模式需系统 Node 22+ 在 PATH;安装包版无此要求 |
