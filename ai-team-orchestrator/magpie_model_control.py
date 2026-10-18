"""借鉴 yetone/magpie 的统一模型视图：AI Team v0 只读与费用准入模块。

不读 API Key、不改 Agent 配置、不发推理请求、不启动 Magpie 网关。
所有派工结论仅为 DRY-RUN，实际派工仍须原有费用门禁再次确认。
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import re
from typing import Any, Mapping
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


HARD_PAUSED = frozenset({"gemini", "grok"})
MODEL_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,150}$")
MAX_AGE = timedelta(hours=24)
MAX_RESPONSE_SIZE = 1024 * 1024
DEFAULT_BRIDGE = "http://127.0.0.1:8765"
SUPPORTED_POLICY_KEYS = frozenset({"version", "routes"})
ROUTE_KEYS = frozenset({
    "worker", "provider", "model", "billing", "evidence",
    "verified_at", "available_free_requests", "max_attempts", "fallback",
})
CREDENTIAL_FIELDS = frozenset({
    "api_key", "apikey", "token", "password", "authorization", "secret",
    "refresh_token", "access_token", "private_key", "credentials",
})


class PolicyError(ValueError):
    """拒绝缺来源、可计费或未明示的模型路径。"""


def validate_bridge_url(value: str) -> str:
    """禁止把 Bridge 内容误发到公网、DNS、错误路径或带凭据的 URL。"""
    try:
        parsed = urlsplit(value)
        if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
                or parsed.port != 8765 or parsed.username or parsed.password
                or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
            raise ValueError("bridge_loopback_only")
    except (ValueError, TypeError) as exc:
        raise PolicyError("bridge_loopback_only") from exc
    return DEFAULT_BRIDGE


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, url):
        """重定向不许离开本机：直接拒绝所有重定向。"""
        return None


def fetch_bridge_agents(*, bridge_url: str = DEFAULT_BRIDGE) -> list[dict[str, Any]]:
    """GET /agents 只取在线状态，绝不访问 Key、任务派工或配置端点。"""
    base = validate_bridge_url(bridge_url)
    opener = build_opener(ProxyHandler({}), _NoRedirect)
    request = Request(base + "/agents", headers={"Accept": "application/json"}, method="GET")
    with opener.open(request, timeout=3) as response:
        raw = response.read(MAX_RESPONSE_SIZE + 1)
    if len(raw) > MAX_RESPONSE_SIZE:
        raise PolicyError("bridge_response_too_large")
    payload = json.loads(raw)
    if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
        raise PolicyError("bridge_shape_invalid")
    if len(payload["items"]) > 128:
        raise PolicyError("bridge_agent_count_invalid")
    result = []
    for item in payload["items"]:
        if not isinstance(item, dict) or not isinstance(item.get("agent_id"), str):
            raise PolicyError("bridge_agent_invalid")
        worker = item["agent_id"]
        if not MODEL_ID.fullmatch(worker):
            raise PolicyError("bridge_agent_id_invalid")
        result.append({
            "worker": worker,
            "online": (
                item.get("configured") is True
                and item.get("available") is True
                and item.get("queueable") is True
            ),
            "paused": worker.lower() in HARD_PAUSED,
        })
    return result


def _contains_credentials(value: Any) -> bool:
    """无论嵌套多深都不能把凭据写进模型路由清单。"""
    if isinstance(value, Mapping):
        for name, child in value.items():
            if str(name).lower() in CREDENTIAL_FIELDS or _contains_credentials(child):
                return True
    if isinstance(value, list):
        return any(_contains_credentials(item) for item in value)
    return False


def validate_manifest(policy: Mapping[str, Any]) -> tuple[dict[str, Any], ...]:
    """拒绝 auto/fallback/带密钥/未知字段，避免旁路原有零费用门禁。"""
    if not isinstance(policy, Mapping):
        raise PolicyError("policy_schema_invalid")
    if _contains_credentials(policy):
        raise PolicyError("credentials_not_permitted")
    if set(policy) != SUPPORTED_POLICY_KEYS:
        raise PolicyError("policy_schema_invalid")
    if type(policy["version"]) is not int or policy["version"] != 1:
        raise PolicyError("policy_version_invalid")
    routes = policy["routes"]
    if not isinstance(routes, list) or len(routes) > 64:
        raise PolicyError("routes_invalid")
    output = []
    pair_seen: set[tuple[str, str, str]] = set()
    for route in routes:
        if not isinstance(route, dict) or set(route) != ROUTE_KEYS:
            raise PolicyError("route_schema_invalid")
        for name in ("worker", "provider", "model"):
            value = route.get(name)
            if not isinstance(value, str) or not MODEL_ID.fullmatch(value):
                raise PolicyError(f"{name}_invalid")
            if value.lower() in ("auto", "fallback", "any", "all"):
                raise PolicyError("automatic_route_disallowed")
        if route["worker"].lower() in HARD_PAUSED:
            raise PolicyError("paused_worker_disallowed")
        if route["billing"] != "verified_free":
            raise PolicyError("unverified_or_paid_route_disallowed")
        # “有官方价格”与“当前账号有剩余额度”是不同证明，都必须给出。
        evidence = route["evidence"]
        if (not isinstance(evidence, dict)
                or set(evidence) != {"provider_terms_url", "account_quota_checked"}
                or not isinstance(evidence["provider_terms_url"], str)
                or evidence["account_quota_checked"] is not True):
            raise PolicyError("free_quota_evidence_missing")
        terms_url = urlsplit(evidence["provider_terms_url"])
        if (terms_url.scheme != "https" or not terms_url.hostname
                or terms_url.username or terms_url.password
                or terms_url.query or terms_url.fragment):
            raise PolicyError("unsafe_terms_evidence_url")
        if (type(route["available_free_requests"]) is not int
                or route["available_free_requests"] < 1):
            raise PolicyError("free_remaining_not_verified")
        if type(route["max_attempts"]) is not int or route["max_attempts"] != 1:
            raise PolicyError("retries_must_be_one")
        if route["fallback"] != []:
            raise PolicyError("fallback_must_be_empty")
        try:
            if not isinstance(route["verified_at"], str):
                raise ValueError("timestamp must be text")
            checked = datetime.fromisoformat(
                route["verified_at"].replace("Z", "+00:00")
            )
            if checked.tzinfo is None:
                raise ValueError("naive date")
        except (TypeError, ValueError) as exc:
            raise PolicyError("verification_date_invalid") from exc
        key = (route["worker"], route["provider"], route["model"])
        if key in pair_seen:
            raise PolicyError("duplicate_route")
        pair_seen.add(key)
        output.append(route)
    return tuple(output)


def plan_model_access(
    roster: list[dict[str, Any]],
    policy: Mapping[str, Any],
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """只输出人工审查建议。即使各条件满足也不允许直接派工。"""
    routes = validate_manifest(policy)
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        raise PolicyError("now_timezone_invalid")
    current = current.astimezone(timezone.utc)
    if not isinstance(roster, list) or len(roster) > 128:
        raise PolicyError("roster_invalid")
    eligible = []
    for agent in roster:
        if (not isinstance(agent, dict)
                or set(agent) != {"worker", "online", "paused"}
                or not isinstance(agent["worker"], str)
                or not MODEL_ID.fullmatch(agent["worker"])
                or type(agent["online"]) is not bool
                or type(agent["paused"]) is not bool):
            raise PolicyError("roster_entry_invalid")
        worker = agent["worker"]
        # 防止编程式传入的 roster 假称暂停的 Worker 已恢复。
        paused = agent["paused"] or worker.lower() in HARD_PAUSED
        active = agent["online"] and not paused
        matches = []
        for route in routes:
            if route["worker"] != worker:
                continue
            checked = datetime.fromisoformat(route["verified_at"].replace("Z", "+00:00"))
            age = current - checked.astimezone(timezone.utc)
            if active and timedelta(0) <= age <= MAX_AGE:
                matches.append(f"{route['provider']}/{route['model']}")
        eligible.append({
            "worker": worker,
            "online": agent["online"],
            "paused": paused,
            "free_routes_pending_runtime_check": matches,
            # 离线配置证据无法保证上游真实账单。二次实时校验前始终不能派工。
            "dispatch_allowed": False,
            "reason": "live_freeguard_required" if matches else
                      ("worker_paused" if paused else
                       "model_evidence_missing_or_worker_offline"),
        })
    return {
        "mode": "read_only",
        "actual_model_calls": 0,
        "actual_config_writes": 0,
        "workers": eligible,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="AI Team Magpie-inspired model review (read-only)")
    parser.add_argument("--bridge", default=DEFAULT_BRIDGE)
    parser.add_argument("--manifest", help="审查显式模型清单，缺省所有路由均未验证")
    args = parser.parse_args()
    try:
        policy: dict[str, Any] = {"version": 1, "routes": []}
        if args.manifest:
            with open(args.manifest, encoding="utf-8") as fh:
                policy = json.load(fh)
        roster = fetch_bridge_agents(bridge_url=args.bridge)
        print(json.dumps(plan_model_access(roster, policy), ensure_ascii=False, indent=2))
        return 0
    except (PolicyError, ValueError, OSError, json.JSONDecodeError) as exc:
        # 不泄露上下游异常 URL 参数、账号身份或响应体。
        print(json.dumps({"status": "blocked", "reason": type(exc).__name__,
                          "dispatch_allowed": False}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
