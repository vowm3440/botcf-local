# -*- coding: utf-8 -*-
"""BotCF (New API) 管理接口契约验证脚本 — 阶段 0

用法:
    python verify_botcf.py                # 只读探测(登录/用户信息/分组/Key列表/用量)
    python verify_botcf.py --create-key   # 额外测试创建一个专用 Key (名称 omp-local-verify)

凭证来源(按优先级): 环境变量 BOTCF_USERNAME / BOTCF_PASSWORD > 运行时交互输入。
密码绝不写入本文件、日志或结果文件。
结果自动保存到 botcf_contract_result.txt 供整理接口文档用。
"""

import getpass
import json
import os
import sys
from datetime import datetime

import requests

BASE_URL = "https://botcf.com"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Referer": BASE_URL + "/",
    "Origin": BASE_URL,
}

SENSITIVE_KEYS = {"key", "token", "access_token", "password", "session"}

result_lines: list[str] = []


def log(msg: str = "") -> None:
    print(msg)
    result_lines.append(msg)


def mask(value: str) -> str:
    if len(value) <= 8:
        return "***"
    return value[:4] + "..." + value[-4:]


def redact(obj):
    """递归遮盖响应中的敏感字段, 只保留首尾便于核对格式。"""
    if isinstance(obj, dict):
        return {
            k: (mask(str(v)) if k.lower() in SENSITIVE_KEYS and v else redact(v))
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [redact(x) for x in obj]
    return obj


def probe(session: requests.Session, method: str, path: str, payload=None, label: str = ""):
    url = BASE_URL + path
    log(f"\n--- {label or path} ---")
    log(f"{method} {path}")
    try:
        resp = session.request(method, url, json=payload, headers=HEADERS, timeout=20)
    except requests.RequestException as exc:
        log(f"  请求失败: {exc}")
        return None
    log(f"  状态码: {resp.status_code} | Content-Type: {resp.headers.get('content-type', '')}")
    set_cookie = resp.headers.get("Set-Cookie")
    if set_cookie:
        log(f"  Set-Cookie: {mask(set_cookie)}")
    try:
        body = resp.json()
        log("  响应: " + json.dumps(redact(body), ensure_ascii=False, indent=2)[:1500])
        return resp, body
    except ValueError:
        text = resp.text[:400].replace("\n", " ")
        log(f"  非 JSON 响应(前400字符): {text}")
        return resp, None


def main() -> int:
    username = os.environ.get("BOTCF_USERNAME") or input("BotCF 用户名: ").strip()
    password = os.environ.get("BOTCF_PASSWORD") or getpass.getpass("BotCF 密码(输入不回显): ")
    create_key = "--create-key" in sys.argv

    log(f"=== BotCF 接口契约验证 {datetime.now().isoformat(timespec='seconds')} ===")
    log(f"用户: {username}")

    session = requests.Session()

    # 1. 未登录时的公开端点 —— 确认站点确实是 New API 架构、是否启用 Turnstile
    log("\n[1] 公开端点探测")
    status = probe(session, "GET", "/api/status", label="站点状态(含 turnstile 开关)")
    if status and status[1]:
        data = status[1].get("data", {})
        turnstile = data.get("turnstile_check")
        log(f"  >>> turnstile_check = {turnstile}")
        if turnstile:
            log("  !!! 登录需要 Turnstile 人机验证, 密码直登路径不可行,")
            log("  !!! 应改用『用户在网页端创建管理 Token 后粘贴给软件』方案。")
    probe(session, "GET", "/api/about", label="关于页")

    # 2. 登录 (New API: JSON body, 成功后返回用户对象含 id)
    log("\n[2] 登录")
    login = probe(
        session, "POST", "/api/user/login",
        payload={"username": username, "password": password},
        label="账号密码登录",
    )
    user_id = None
    if login and login[1] and login[1].get("success"):
        user_id = (login[1].get("data") or {}).get("id")
        log(f"  >>> 登录成功, 用户ID = {user_id}")
        log(f"  >>> 会话 Cookie: {[c.name for c in session.cookies]}")
    else:
        log("  >>> 登录失败或返回格式与 New API 不同, 请检查上方响应。")
        if login and login[1]:
            log(f"  >>> message: {login[1].get('message')}")

    if user_id is None:
        log("\n未取得登录会话, 跳过需鉴权的探测。")
        save()
        return 1

    # New API 新版本要求带 New-Api-User 头
    HEADERS["New-Api-User"] = str(user_id)

    # 3. 用户信息: 余额/额度/所属分组
    log("\n[3] 用户信息与额度")
    probe(session, "GET", "/api/user/self", label="用户信息(quota=剩余额度, group=用户分组)")

    # 4. 可用模型与分组
    log("\n[4] 模型与分组")
    probe(session, "GET", "/api/user/models", label="当前用户可用模型")
    probe(session, "GET", "/api/user/available_models", label="可用模型(备用端点)")
    probe(session, "GET", "/api/group", label="分组列表(部分站点仅管理员可见)")
    probe(session, "GET", "/api/user/group", label="用户可选分组(倍率信息)")

    # 5. Key(Token) 管理
    log("\n[5] API Key 列表")
    probe(session, "GET", "/api/token/?p=0&size=100", label="Key 列表(注意 group 字段绑定方式)")

    if create_key:
        log("\n[5b] 创建测试 Key: omp-local-verify")
        probe(
            session, "POST", "/api/token/",
            payload={
                "name": "omp-local-verify",
                "remain_quota": 500000,
                "expired_time": -1,
                "unlimited_quota": False,
                "model_limits_enabled": False,
                "model_limits": "",
                "group": "",  # 留空=用户默认分组; 填分组名即绑定分组
            },
            label="创建 Key(验证 group 字段是否生效)",
        )
        probe(session, "GET", "/api/token/?p=0&size=100", label="创建后的 Key 列表")

    # 6. 用量
    log("\n[6] 用量与日志")
    probe(session, "GET", "/api/log/self/stat?type=0", label="用量统计")
    probe(session, "GET", "/api/log/self?p=0&page_size=10&type=0", label="调用日志(单条含 token 数/费用)")
    probe(session, "GET", "/api/data/self?default_time=hour", label="用量图表数据(备用端点)")

    save()
    log("\n完成。结果已写入 botcf_contract_result.txt (敏感字段已遮盖)。")
    return 0


def save() -> None:
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "botcf_contract_result.txt")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(result_lines))


if __name__ == "__main__":
    sys.exit(main())
