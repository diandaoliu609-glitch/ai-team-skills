"""R3 GSC first-party validation（R3 GSC 第一方验证）."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any, Mapping

from workspace import WorkspaceStore, run_workspace, workspace_collection_plan


SCHEMA_VERSION = "r3-gsc-validation-v1"


def doctor(*, database: str, workspace_id: str, environ: Mapping[str, str] | None = None) -> dict[str, Any]:
    env = os.environ if environ is None else environ
    with WorkspaceStore(database) as store:
        workspace = store.get(workspace_id)
    plan = workspace_collection_plan(workspace, database=database)
    gsc_jobs = [row for row in plan.get("jobs") or [] if row.get("provider") == "gsc"]
    token_present = bool(str(env.get("GSC_ACCESS_TOKEN") or "").strip())
    checks = {
        "workspace_enabled": bool(workspace.enabled),
        "gsc_property_configured": bool(workspace.gsc_site_url),
        "gsc_job_in_plan": len(gsc_jobs) == 1,
        "gsc_access_token_present": token_present,
    }
    # 中文说明：体检结果只返回“凭据是否存在”，绝不返回 token 长度、前缀或内容。
    return {
        "schema_version": SCHEMA_VERSION,
        "workspace_id": workspace.workspace_id,
        "scope": workspace.scope,
        "gsc_site_url": workspace.gsc_site_url,
        "checks": checks,
        "ready": all(checks.values()),
        "credential_value_exposed": False,
        "next_action": (
            "run real GSC validation（运行真实 GSC 验证）"
            if all(checks.values())
            else "configure GSC property + runtime token（配置 GSC 属性和运行时令牌）"
        ),
    }


def validate_result(payload: Mapping[str, Any]) -> dict[str, Any]:
    jobs = list((payload.get("collection") or {}).get("jobs") or [])
    gsc = next((row for row in jobs if row.get("provider") == "gsc"), None)
    event_count = int((gsc or {}).get("event_count") or 0)
    status = str((gsc or {}).get("status") or "missing")
    top = list(payload.get("top_opportunities") or [])
    provider_ok = status in {"healthy", "degraded"} and event_count > 0
    opportunities_ok = len(top) > 0
    return {
        "schema_version": SCHEMA_VERSION,
        "workspace_id": (payload.get("workspace") or {}).get("workspace_id"),
        "gsc_provider_status": status,
        "gsc_event_count": event_count,
        "top_opportunity_count": len(top),
        "provider_evidence_pass": provider_ok,
        "opportunity_output_pass": opportunities_ok,
        "passed": provider_ok and opportunities_ok,
        "top_opportunities": top[:5],
        "warnings": list((gsc or {}).get("warnings") or []),
    }


def render_markdown(result: Mapping[str, Any]) -> str:
    status = "PASS（通过）" if result.get("passed") else "PENDING / FAIL（待完成 / 未通过）"
    lines = [
        "# Radar R3 GSC Validation Report（Radar R3 GSC 第一方验证报告）",
        "",
        f"- Gate status（门槛状态）: **{status}**",
        f"- Workspace（工作区）: `{result.get('workspace_id')}`",
        f"- GSC provider status（GSC 数据源状态）: **{result.get('gsc_provider_status')}**",
        f"- GSC events（GSC 真实事件数）: **{result.get('gsc_event_count', 0)}**",
        f"- Top opportunities（机会数）: **{result.get('top_opportunity_count', 0)}**",
        "",
        "## Top Opportunities（Top 机会）",
        "",
    ]
    for item in result.get("top_opportunities") or []:
        lines.append(
            f"- Rank {item.get('rank')}: **{item.get('topic')}** — rank_score={item.get('rank_score')} / opportunity_score={item.get('opportunity_score')}"
        )
    if not result.get("top_opportunities"):
        lines.append("- None（无）。")
    lines.extend([
        "",
        "## Credential Truth（凭据真相）",
        "",
        "本报告不包含 OAuth token（OAuth 令牌）明文、长度或前缀；凭据只在运行时环境中使用。",
    ])
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Radar R3 GSC first-party validation")
    parser.add_argument("--db", default=".radar/radar.db")
    sub = parser.add_subparsers(dest="command", required=True)
    d = sub.add_parser("doctor")
    d.add_argument("workspace_id")
    r = sub.add_parser("run")
    r.add_argument("workspace_id")
    r.add_argument("--output")
    r.add_argument("--report")
    args = parser.parse_args()
    if args.command == "doctor":
        result = doctor(database=args.db, workspace_id=args.workspace_id)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["ready"] else 3

    preflight = doctor(database=args.db, workspace_id=args.workspace_id)
    if not preflight["ready"]:
        print(json.dumps(preflight, ensure_ascii=False, indent=2))
        return 3
    result = validate_result(run_workspace(args.workspace_id, database=args.db, force_collect=True, top_n=5))
    payload = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        Path(args.output).write_text(payload, encoding="utf-8")
    else:
        print(payload, end="")
    if args.report:
        Path(args.report).write_text(render_markdown(result), encoding="utf-8")
    return 0 if result["passed"] else 4


if __name__ == "__main__":
    raise SystemExit(main())
