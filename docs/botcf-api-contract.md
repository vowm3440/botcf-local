# BotCF 管理接口契约(实测验证)

验证日期:2026-08-14 · 验证方式:`verify_botcf.py` 对 botcf.com 真实调用 · 架构:New API

## 结论摘要

| 待确认项 | 结果 |
|---------|------|
| 登录方式 | `POST /api/user/login`,JSON body `{username, password}`,返回 `session` Cookie |
| 验证码/Turnstile | **无**(`/api/status` 返回 `turnstile_check: false`),密码直登可行 |
| 鉴权头 | 后续请求需带 session Cookie + `New-Api-User: <用户ID>` 头 |
| 分组列表 | `/api/group`、`/api/user/group` 对普通用户 **401**;只能从 `user.group` + 已有 Key 的 `group` 字段聚合 |
| Key 管理 | `GET/POST /api/token/` 可用;创建时 `group` 传空串会得到无分组 Key,**必须传真实分组名** |
| 用量 | `GET /api/log/self/stat?type=0`(总量)、`GET /api/log/self`(单条日志含 token 数) |
| 会话刷新 | 未观察到显式刷新端点;session Cookie 过期后需重新登录 |

## 端点明细

### 公开(无需登录)

- `GET /api/status` — 站点配置;关键字段 `turnstile_check`(布尔)、公告、模块开关。
- `GET /api/about` — 关于页文本。

### 登录

- `POST /api/user/login`,Content-Type `application/json`,body `{username, password}`。
  - 成功:`{success: true, data: {id, username, display_name, group, role, status}}`,响应带 `Set-Cookie: session=...`。
  - 登录事件会写入用户日志(type=7,含来源 IP 与 UA)。

### 需鉴权(Cookie + New-Api-User 头)

- `GET /api/user/self` — `quota`(剩余额度)、`used_quota`、`request_count`、`group`(用户默认分组)、aff 字段等。
- `GET /api/user/models` — 扁平模型 id 数组(实测 50+ 项,含 image/embedding 类,需前端过滤)。
- `GET /api/user/available_models` — **401**(权限不足),不可用。
- `GET /api/token/?p=<page>&size=<n>` — Key 分页列表。字段:`id, name, key(无 sk- 前缀), status, group(逗号分隔可多分组), remain_quota, unlimited_quota, used_quota, expired_time, cross_group_retry, max_group_ratio`。
- `POST /api/token/` — 创建 Key。body 参考:`{name, group, remain_quota, unlimited_quota, expired_time: -1, model_limits_enabled: false, model_limits: "", cross_group_retry: false}`。响应只有 `{success}`,需重新拉列表取 key 值。
- `GET /api/log/self/stat?type=0` — `{quota, rpm, tpm}`。
- `GET /api/log/self?p=0&page_size=N&type=0` — 调用日志,单条含 `model_name, prompt_tokens, completion_tokens, quota, use_time, is_stream, token_name, group`。
- `GET /api/data/self?default_time=hour` — 图表数据(实测返回空数组,可能需要其他参数)。

## 推理端点(与管理接口分离)

- OpenAI 兼容(chat/completions、responses):`https://botcf.com/v1`,`Authorization: Bearer sk-<key>`。
- Anthropic 兼容:`https://botcf.com/v1/messages`(base URL 用裸域名),`x-api-key: sk-<key>`。
- Key 列表返回的 `key` 值不带 `sk-` 前缀,使用时需自行拼接。

## 已知约束

1. 分组专用 Key 命名规范:`omp-local-<deviceId>-<groupSlug>`;只查找/创建本软件自己的 Key,绝不修改用户已有共享 Key。
2. `/api/pricing` 已作为分组全集来源接入(取顶层 `usable_group`/`group_ratio` 与每模型 `enable_groups`,信封需整体读取而非仅 `data`)。解析为宽容模式:接口 401/404/形状漂移时自动降级回「默认分组+Key 分组」聚合。实际形状仍待对 BotCF 实测确认。
3. 验证过程中创建的测试 Key `omp-local-verify`(500K 额度)留在账户中,可在控制台删除。
