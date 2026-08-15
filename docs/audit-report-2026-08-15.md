# BotCF 本地控制台审计报告

日期:2026-08-15
范围:`apps/server`,`apps/web`,`apps/desktop`,`docker`,根清单与验证脚本;排除生成目录、账户结果和用户数据。

## 结论

P0–P4 代码与交付链路已完成。安全审计最初发现 2 个高危、1 个中危、1 个低危问题;本轮已修复可在仓库内闭环的入口、完整性、代理授权和镜像固定问题。仍有一项上游依赖风险:OMP 官方 Release 当前只提供同发布方 SHA256,没有可供本应用固定身份验证的独立签名/证明;因此只能强制官方仓库、HTTPS、完整摘要和安装后冒烟,不能声称抵御官方仓库凭据被攻破。

## 八项代码质量审计

### 1. 可读性

- 正向:路由、BotCF 适配器、OMP RPC、更新器、能力库边界明确;关键状态与安全不变量有注释。
- 已修复:删除 7 个只有 `export {}` 的废弃占位文件,避免误导入口。
- 后续建议:TopBar/Chat 仍包含较多内联 JSX 样式;不影响正确性,但后续视觉迭代宜提取现有样式对象,不要引入第二套组件体系。

### 2. 模块化与可维护性

- 正向:凭据代理是唯一真实 Key 注入边界;`appState.applyActiveRouteToOmp` 统一启动、切换会话和恢复路径。
- 已修复:生成应用自有 OMP provider 配置,会话恢复不再依赖进程内偶然状态。
- 风险:更新器路径仍来自进程级 config,隔离集成测试需要子进程;当前坏二进制验收已用临时数据目录覆盖。

### 3. 性能

- 流式代理逐块转发,文件 SHA256 使用流式哈希,未整文件复制。
- 用量刷新采用生成中 30s、空闲 2min,每轮额外 2s/15s 收敛;没有轮询风暴。
- 生成模型目录按 `(provider,model)` Map 去重,避免重复定义。

### 4. 错误处理与鲁棒性

- 已修复:OMP 安装后执行 handshake + set_model + prompt;失败回滚后再次探测旧版本。
- 已修复:坏二进制注入得到探针 `[false,true]`,状态恢复 `currentVersion=good`。
- 已修复:页面刷新、会话切换和新建会话均恢复路由与历史;错误通过 SSE/界面可见。
- 已记录:`ISSUES_LOG.md` 包含症状、根因、解决方案、失败尝试和预防措施。

### 5. 安全性

#### BOTCF-SEC-001 控制面未认证(初始:高危;当前:显著缓解)

根因:把回环监听和进程全局 BotCF 登录误当作 HTTP 调用者授权。

修复:
- 主服务拒绝非 `127.0.0.1`/`localhost`/`::1` Host。
- 有 Origin 的请求必须与 Host 完全同源,阻断 DNS rebinding 与浏览器 CSRF。
- HTTP 接口不能再选择任意更新源;仅允许 `can1357/oh-my-pi` 官方仓库。

残余:同一操作系统用户的恶意本地进程仍可调用 7788。该进程通常也能读取用户数据目录/执行同权限程序;若未来支持 LAN 暴露,必须先增加每安装高熵控制令牌和逐请求授权。

#### BOTCF-SEC-002 更新真实性(初始:高危;当前:完整性已修复,签名残余)

修复:
- 强制合法版本标签,拒绝路径穿越。
- 强制 64 位 SHA256;缺失或格式错误不安装。
- 下载文件与已有缓存二进制均重新流式计算 SHA256。
- 固定官方仓库;安装后真实 prompt 冒烟。

残余:摘要和二进制来自同一 GitHub Release,不能抵御官方发布凭据整体失陷。上游提供 Sigstore/固定公钥签名后应立即接入。

#### BOTCF-SEC-003 凭据代理无客户端授权/模型未绑定(初始:中危;已修复)

修复:
- 每次服务启动生成 256-bit 随机代理 capability。
- OMP provider/env 使用该 capability;代理常量时间验证 Bearer 或 x-api-key。
- 请求 `body.model` 必须等于当前路由模型,否则 409。
- 无 capability 的本地请求实测返回 401;授权 OMP prompt 正常完成。

#### BOTCF-SEC-004 容器基础镜像可变(初始:低危;已修复)

两阶段 `node:22-alpine` 均固定到多架构 digest `sha256:ab07539e0988b63558ff621f5fbe1077054c39d9809112974fb79993949d41cd`。

已验证的其他控制:AES-256-GCM + 随机 96-bit IV,master.key 0600 尝试,SQL 参数化,日志凭据脱敏,Electron `contextIsolation=true/nodeIntegration=false/sandbox=true`,Docker 非 root/read-only/no-new-privileges/cap_drop ALL,React 无 `dangerouslySetInnerHTML`,OMP spawn `shell:false`。

### 6. 测试覆盖率

- 74 个 Vitest 测试通过(8 个文件)。
- 新增覆盖:OMP `SessionStats.tokens`,自定义 provider capability,官方仓库限制,版本路径穿越,SHA256 必填,Host/Origin,代理 capability 和模型解析。
- 手工/实机覆盖:真实 BotCF 请求、OMP 工具调用、会话恢复、计费补刷、坏二进制回滚、Electron 打包运行、Docker hardened runtime、amd64/arm64 构建。
- 未覆盖风险:没有浏览器自动化测试套件;本轮以真实 Chromium 验收代替。上游 BotCF/OMP 契约变化仍需集成冒烟发现。

### 7. 一致性与风格

- TypeScript 构建通过;Vite 8 React 插件已升级到兼容版本,移除 web 中 fastify/@fastify/static 错误依赖。
- 根脚本统一 workspace build/test/dist;Docker 改用 lockfile 驱动的 `npm ci`。
- 建议后续加入单一 formatter 配置;当前不为纯格式引入工具或大范围 diff。

### 8. 文档完整性

- README 已包含桌面、Docker、OMP 更新通道、SmartScreen 校验与多架构构建。
- `docs/next-phase-plan.md` 已改为本轮实测结果与完成清单。
- `ISSUES_LOG.md` 已记录调试闭环。
- 唯一外部待办:账户持有人自行轮换旧脚本曾暴露的 BotCF 密码;应用不保存明文密码,无法安全代操作。

## 验收证据

- `npm run build`:web + server 成功。
- `npm test -w apps/server`:8 files / 74 tests passed。
- `npm audit --omit=dev`:0 vulnerabilities。
- OMP 安装冒烟:`{"started":true,"handshake":true,"setModelAndPrompt":true}`。
- OMP 坏二进制回滚:`{"currentVersion":"good","previousVersion":"bad"}`,probes `[false,true]`。
- 浏览器真实工具任务:`read · 完成 · 读取目标文件第一行`。
- 每轮 Token:输入 15,792 / 输出 10;上下文 15,792/400,000。
- 计费补刷示例:`上次请求 $0.0048 (15791+9 tok)`。
- 恶意 Origin:`403`;无代理 capability:`401`;授权 OMP prompt 成功。
- Docker `/health`:`{"status":"ok"}`;inspect:`user=1001:1001 readonly=true caps=["ALL"] security=["no-new-privileges:true"] port=127.0.0.1`。
- 多架构 OCI manifest:linux/amd64 + linux/arm64 构建成功。
- 最终 Electron unpacked 应用启动后标题、更新通道、会话和工作目录控件均可见。

## 最终交付物

- Windows:`apps/desktop/release/BotCF-Local Setup 0.1.0.exe`
  - SHA256:`1666cfe58b0f80ea505e153a484909a5ee29b26d563a9172a87c277454846dbc`
- 多架构 OCI:`D:/do/botcf-dist/botcf-local-0.1.0-multiarch.tar`
  - 平台:`linux/amd64`,`linux/arm64`
  - manifest:`sha256:9ad1b03f9b9a4ce2a5ce45e75c3eafc3b832f7528a4c1e05cc3cb986f760fb0e`
  - 文件 SHA256:`595d4035bbf55b6e3dea45fc2ecabf15207dd5711682090d24d3f847890eeb5b`

## Lessons learned / 预防规则

1. 回环地址是暴露面限制,不是调用者身份;浏览器控制面至少校验 Host/Origin,LAN 模式必须逐请求认证。
2. 能执行的更新产物必须先验证路径、固定来源、强制摘要并在切换后完成真实业务冒烟;握手不等于可用。
3. 本地凭据代理也需要 capability;`127.0.0.1` 不是进程隔离边界。
4. 第一次出现的完整 API Key 必须立即密封;掩码绝不能进入代理。
5. 发布验收必须从干净 lockfile 构建 Docker,并实际运行 read-only/non-root 配置。
6. 桌面冒烟结束必须终止整个 Electron 进程树,否则下一次打包会因文件锁失败。
