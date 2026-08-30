# BotCF 高风险补充测试报告

日期：2026-08-24

## 结论

本轮 6 项指定测试均已实际执行。认证、第三方真实模型调用、Windows 安装/便携产物、SmartScreen、Docker 构建、多架构 OCI、已推送 Git 回滚与冲突恢复均取得实测证据。

新增发现 3 个 P1、2 个 P3：

1. P1：应用重启后前端永久保留 route 恢复前的空状态。
2. P1：手动 OMP 回滚只改版本链接,不重启/不健康验证；显式 restart 又不重应用 route。
3. P1：Docker amd64/arm64 都能 HTTP healthy,但 OMP 均无法运行。
4. P3：Windows 发布产物使用默认 Electron 图标。
5. P3：Git 回滚冲突时提交错误原因优先级不准确。

## 1. 退出并重新登录

### 结果：通过

- 实际界面点击“退出登录”后：`authenticated:false`,`route:null`,`thirdParty:null`，返回登录页。
- 使用账号密码重新登录：`authenticated:true`,`mode:botcf`,`username:vowm`。
- 页面重载后会话仍有效；密码字段提交后被清空，应用状态和 API 不返回密码。
- 最终恢复为 BotCF 模式，第三方状态已清除。

## 2. 第三方提供商真实凭据

### 结果：调用通过；重启后的界面恢复失败

- 输入用户提供的 Base URL、API Key 和模型。
- Base URL 按设计从带 `/v1` 的形式规范化为 `https://tokenflux.dev`。
- 模型目录只返回 `qwen3.8-27b-nvfp4-262k`，路由为 Chat Completions。
- 首次真实请求返回精确 `TOKENFLUX_OK`，首个可见结果约 4.433 秒。
- 应用重启后，后端成功恢复第三方配置、加密 Key 和 route；再次手动选择模型后真实请求返回 `TOKENFLUX_RESTART_OK`，约 1.972 秒。
- `/api/state` 只返回 Base URL 和模型列表，不返回 API Key。

### 问题：P1 — 后端 route 已恢复，前端仍永久显示未选择路由

应用重启 5 秒后仍为：模型空、思考等级空、消息框 disabled；同时 `/api/state.route` 已完整恢复。

根因：Server 在 `app.listen()` 后异步 `rearmRoute()`；Web `App` 只在首次挂载读取一次 state。首次请求命中 `route:null` 后没有恢复完成事件，也不再轮询。

修复：在 HTTP ready 前完成 workspace/OMP/route 恢复，或广播 route-restored 事件让前端重新读取 state。

## 3. OMP 更新和回滚

### 检查更新：通过

- 检查耗时约 1.022 秒。
- 当前/最新版本：v18.0.3。
- previous：v18.0.0。
- channel：fast。
- `lastError:null`。

### 回滚二进制：部分通过

- `/api/omp/rollback` 返回成功，state 从 v18.0.3/v18.0.0 交换为 v18.0.0/v18.0.3。
- 但回滚后 OMP PID 和启动时间完全不变，说明实际进程仍为旧版本。
- 显式 `/api/omp/restart` 后 PID 改变，`<current>/omp --version` 确认为 `omp/18.0.0`。
- 显式重启后 route 未重应用，第一次第三方 Chat 请求进入默认 Anthropic 模型，409 后显示空白助手消息。
- 手动重新选择模型后，v18.0.0 真实请求返回 `OMP_18_0_0_OK`，约 6.434 秒。
- 再次 rollback + restart 已恢复 v18.0.3；最终状态 current v18.0.3、previous v18.0.0、running true、protocolError null。

### 问题：P1 — 手动回滚没有完成热切换事务

`POST /api/omp/rollback` 只 relink current/previous；没有 stop/start、handshake、route 恢复、真实 prompt 或失败切回。API 报告的 currentVersion 与正在运行的进程版本短时间内不一致。

修复：手动回滚复用自动更新的完整 healthProbe 事务，并在 route/prompt 失败时切回原版本。

## 4. Windows 安装包与 SmartScreen

### 构建结果：通过

- `npm run dist:desktop`：通过，124.61 秒。
- Portable：90,078,699 B。
  - SHA256：`061d7d93fcd738d5e1c25d922d923e4b4ed0a5d8737862454597ac5f10be8b25`
- Setup：90,308,581 B。
  - SHA256：`48176951a2e84a523cc2289e47c8028ee59eccce81b47d3ae4a2b2783b635398`
- PE 版本：FileVersion 3.0.0，ProductVersion 3.0.0.0，ProductName BotCF-Local。

### 安装版：通过

- NSIS 静默安装到隔离目录成功。
- 注册表 DisplayName/DisplayVersion/UninstallString 正确。
- 安装版窗口标题包含 v3.0.0。
- `/health` 正常，内嵌 `resources/server/server.bundle.cjs` 服务进程正常。
- 使用与便携版相同的 `%APPDATA%/botcf-desktop/data`，第三方持久状态可读。
- 隔离卸载成功；测试前已备份原安装目录、注册表和快捷方式，测试后文件 SHA256、注册表与两个快捷方式均恢复。

### 便携版：通过

- Portable 启动成功并解包到 `%TEMP%`。
- `/health` 正常，窗口标题包含 v3.0.0，持久状态与安装版共享。

### SmartScreen：符合文档

- Portable 与 Setup 的 Authenticode 均为 `NotSigned`，SignerCertificate 为空。
- 给 Portable 测试副本添加 ZoneId=3/HostUrl 的 Mark-of-the-Web。
- 通过 Windows Shell 启动时产生新的 `smartscreen.exe`，BotCF 进程未启动，证明 SmartScreen 已拦截并显示警告流程。
- 没有关闭或修改系统 SmartScreen 策略；测试提示已终止，测试副本已删除。

### 问题：P3 — 发布产物使用默认 Electron 图标

构建日志明确输出 `default Electron icon is used`。版本和产品名正确，但 exe、安装器与卸载器缺少产品图标配置。

## 5. Docker 与多架构镜像

### amd64 控制台和容器安全：通过

- Docker Desktop 从停止状态启动成功，测试后已停止。
- Compose 构建/启动成功；`/health` 和 Web 页面正常。
- 容器配置实测：
  - uid/gid：1001:1001
  - read-only rootfs：true
  - cap_drop：ALL
  - no-new-privileges：true
  - 端口仅绑定 127.0.0.1:7788
  - `/app` 写入失败，`/data`、`/tmp` 写入成功
  - Git 2.54.0 可用

### 多架构 OCI：构建通过

- buildx 版本：v0.35.0-desktop.2。
- amd64+arm64 OCI 构建：通过，150.33 秒。
- 文件大小：197,553,152 B。
- SHA256：`e4b4a8f10d41c0c31093d40a989411197ee027c46f34861f82de9f7f35e68090`
- OCI index digest：`sha256:4461a396047d0ab016aff1e0ae1af88d99b65530a3237ea63a35fec48f65e361`。
- 平台：linux/amd64、linux/arm64，另有对应 attestation manifests。
- arm64 镜像已在 x64 主机 QEMU 模拟下实际启动，HTTP 健康通过。

### 问题：P1 — 两个架构的 Docker AI runtime 都不可用

容器 `/health` 为 ok 且 Docker 标记 healthy，但 `/api/omp/status` 均为 available true、running false、RPC 握手超时：

- amd64 Alpine：OMP 需要把 native addon 解压到 `/home/app/.omp`；只读根文件系统导致 EROFS，addon 缺失。
- arm64 Alpine：下载/选择的 OMP 二进制需要 glibc loader，日志为 `Could not open /lib/ld-linux-aarch64.so.1`。

因此当前 Docker 只能证明控制台在线，不能证明 AI 功能可用；README 的 Docker 可用性结论不成立。

修复：给 OMP 配置 `/data` 下的可写 HOME/native 目录；arm64 使用 musl 资产或 glibc 镜像；容器发布验收必须运行 handshake + route + prompt。

## 6. 已推送 Git 分支回滚冲突

### 结果：核心行为通过

使用临时 bare remote 和实际 push：

1. `main` 与 `origin/main` 一致，ahead=0/behind=0。
2. “撤销上一个提交”返回 409：已推送，建议改用反向提交。正确阻止历史改写。
3. 回滚较早的 `feature-change` 产生真实内容冲突，返回 409；status 显示 `conflictedCount:1` 和 `conflict.txt` conflicted。
4. `revert-abort` 返回 200，文件恢复为 `value=current`，仓库回到干净状态。
5. 回滚当前已推送提交成功，生成 `Revert "current-change"`，文件变为 `value=feature`。
6. 反向提交成功 push 到远端。

### 问题：P3 — 冲突期间提交提示错误优先级不准确

回滚冲突明确存在时，提交接口返回“没有已暂存的修改”，而不是“存在冲突，请解决或放弃回滚”。安全性正确，但用户无法从提示获知真实阻塞状态。

## 最终恢复与清理

- 最终账户：BotCF / vowm。
- 第三方配置与加密 Key 已通过退出登录清除；`thirdParty:null`。
- 最终路由：`🥺grok-heavy / grok-4.6 / max / chat`。
- 最终工作区：仅 `D:\do\a.test` 为主目录。
- 最终 OMP：v18.0.3，previous v18.0.0，running true，protocolError null。
- 原安装目录、注册表、桌面/开始菜单快捷方式已恢复并校验。
- Docker 容器、测试镜像、Docker Desktop、OCI 文件已清理/停止。
- Git remote/work、SmartScreen 副本、安装备份、Docker 数据与 4 个 OMP 测试会话已删除。
- 所有 BotCF/Electron 测试进程已退出。
- `ISSUES_LOG.md` 已追加 5 个问题及预防措施。
