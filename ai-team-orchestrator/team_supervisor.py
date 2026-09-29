"""Automatic multi-agent supervisor for AI Team Orchestrator.

Truth remains in the Bridge. This layer only plans task graphs, stages artifacts,
and advances phases after bridge-reported terminal states.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from supervisor import BridgeClient


TEAM_ORDER = ["dsh", "gemini", "grok", "qwen", "doubao"]
SYNTHESIS_PREFERENCE = ["gemini", "qwen", "doubao", "dsh", "grok"]
TERMINAL = {"completed", "failed", "cancelled"}
ACTIVE_RUN_STATUSES = {"primary_running", "review_running", "synthesis_running"}

ROLE_PROFILES: dict[str, dict[str, str]] = {
    "dsh": {
        "label": "Engineering Verifier",
        "brief": (
            "Focus on implementation feasibility, local/runtime validation, interfaces, "
            "tests, failure modes, and concrete engineering steps. Prefer evidence from "
            "the workspace or runnable checks over speculation."
        ),
    },
    "gemini": {
        "label": "Deep Researcher",
        "brief": (
            "Focus on deep research, long-context synthesis, system-level dependencies, "
            "evidence gaps, and a coherent explanatory model. Separate facts from assumptions."
        ),
    },
    "grok": {
        "label": "Trend Scout & Red Team",
        "brief": (
            "Focus on current trends, external reality checks, adversarial analysis, weak "
            "assumptions, missing counter-evidence, and what could invalidate the plan."
        ),
    },
    "qwen": {
        "label": "Implementation Architect",
        "brief": (
            "Focus on structured solution design, implementation alternatives, decomposition, "
            "interfaces, acceptance criteria, and efficient execution paths."
        ),
    },
    "doubao": {
        "label": "China Context Specialist",
        "brief": (
            "Focus on Chinese-language context, domestic platforms/ecosystems, localization, "
            "operational constraints, and whether conclusions survive China-market reality."
        ),
    },
}


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _age_seconds(value: str | None) -> float:
    if not value:
        return 0.0
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return 0.0
    return max(0.0, (datetime.now(timezone.utc) - parsed).total_seconds())


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp_name, path)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def _run_id(goal: str) -> str:
    seed = f"{goal}|{time.time_ns()}|{os.getpid()}".encode("utf-8")
    return "run_" + hashlib.sha256(seed).hexdigest()[:20]


class TeamRunStore:
    def __init__(self, root: str | Path = ".orchestrator/team-runs") -> None:
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def path(self, run_id: str) -> Path:
        return self.root / f"{run_id}.json"

    def save(self, run: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            run["updated_at"] = _utcnow()
            _atomic_json(self.path(run["run_id"]), run)
            return run

    def load(self, run_id: str) -> dict[str, Any]:
        with self._lock:
            path = self.path(run_id)
            if not path.exists():
                raise KeyError(f"unknown team run: {run_id}")
            return json.loads(path.read_text(encoding="utf-8"))

    def list(self, *, active_only: bool = False) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        with self._lock:
            for path in sorted(self.root.glob("run_*.json")):
                try:
                    run = json.loads(path.read_text(encoding="utf-8"))
                except Exception:
                    continue
                if active_only and run.get("status") not in ACTIVE_RUN_STATUSES:
                    continue
                items.append(run)
        items.sort(key=lambda item: item.get("created_at", ""), reverse=True)
        return items


class TeamSupervisor:
    def __init__(
        self,
        bridge: BridgeClient,
        *,
        state_dir: str | Path = ".orchestrator/team-runs",
    ) -> None:
        self.bridge = bridge
        self.runs = TeamRunStore(state_dir)

    def available_agents(self) -> list[str]:
        by_id = {item["agent_id"]: item for item in self.bridge.agents()}
        return [
            agent_id
            for agent_id in TEAM_ORDER
            if by_id.get(agent_id, {}).get("configured")
            and by_id.get(agent_id, {}).get("available")
            and by_id.get(agent_id, {}).get("queueable")
        ]

    def _select_participants(self, requested: list[str] | None) -> list[str]:
        available = self.available_agents()
        if requested:
            unknown = [item for item in requested if item not in TEAM_ORDER]
            if unknown:
                raise ValueError(f"unsupported team agents: {', '.join(unknown)}")
            selected = [item for item in TEAM_ORDER if item in requested and item in available]
        else:
            selected = available
        if len(selected) < 2:
            raise RuntimeError(
                "team run requires at least two available workers; "
                f"available={available!r}, selected={selected!r}"
            )
        return selected

    def _primary_prompt(self, goal: str, agent_id: str) -> str:
        profile = ROLE_PROFILES[agent_id]
        return f"""You are the {profile['label']} in a multi-agent team.

Shared goal:
{goal}

Your independent responsibility:
{profile['brief']}

Deliverable rules:
- Work independently; do not assume other agents agree with you.
- Be concise but evidence-oriented.
- Do not browse/search externally unless the shared goal materially requires current external evidence.
- Once the mandatory artifact is complete and validated, finish the task instead of extending exploration.
- Explicitly list: findings, evidence/assumptions, risks, and recommendations.
- Create `primary.md` in the workspace. That file is mandatory.
- Do not edit anything outside this isolated workspace.
"""

    def start_run(
        self,
        *,
        goal: str,
        workspace: str = ".",
        participants: list[str] | None = None,
    ) -> dict[str, Any]:
        if not goal.strip():
            raise ValueError("team goal is required")
        selected = self._select_participants(participants)
        run_id = _run_id(goal)
        base_workspace = Path(workspace).expanduser().resolve()
        base_workspace.mkdir(parents=True, exist_ok=True)
        run_root = base_workspace / ".ai-team-runs" / run_id
        run_root.mkdir(parents=True, exist_ok=True)
        run: dict[str, Any] = {
            "version": "1.0",
            "run_id": run_id,
            "goal": goal,
            "workspace": str(base_workspace),
            "run_root": str(run_root),
            "status": "primary_running",
            "phase": "primary",
            "participants": selected,
            "created_at": _utcnow(),
            "updated_at": _utcnow(),
            "phase_started_at": _utcnow(),
            "policy": {
                "primary_soft_timeout_seconds": 90,
                "primary_hard_timeout_seconds": 420,
                "review_soft_timeout_seconds": 90,
                "review_hard_timeout_seconds": 300,
                "synthesis_soft_timeout_seconds": 90,
                "synthesis_hard_timeout_seconds": 300,
                "min_primary_success": min(3, len(selected)),
                "min_review_success": min(2, len(selected)),
            },
            "nudges": {},
            "primary": {},
            "reviews": {},
            "synthesis": None,
            "errors": [],
        }
        for agent_id in selected:
            agent_workspace = run_root / "primary" / agent_id
            agent_workspace.mkdir(parents=True, exist_ok=True)
            task = self.bridge.submit(
                agent_id=agent_id,
                title=f"[{run_id}] Primary: {ROLE_PROFILES[agent_id]['label']}",
                prompt=self._primary_prompt(goal, agent_id),
                workspace=str(agent_workspace),
                metadata={
                    "team_run_id": run_id,
                    "team_phase": "primary",
                    "team_role": ROLE_PROFILES[agent_id]["label"],
                    "expected_artifacts": ["primary.md"],
                },
            )
            run["primary"][agent_id] = {
                "task_id": task["task_id"],
                "workspace": str(agent_workspace),
                "status": task["status"],
                "started": bool(task.get("started")),
                "artifact": None,
            }
        self.runs.save(run)
        return run

    def get_run(self, run_id: str, *, refresh: bool = True) -> dict[str, Any]:
        run = self.runs.load(run_id)
        if refresh and run.get("status") in ACTIVE_RUN_STATUSES:
            run = self._refresh_task_views(run)
            self.runs.save(run)
        return run

    def _refresh_task_views(self, run: dict[str, Any]) -> dict[str, Any]:
        for entry in run.get("primary", {}).values():
            self._refresh_entry(entry)
        for entry in run.get("reviews", {}).values():
            self._refresh_entry(entry)
        if run.get("synthesis"):
            self._refresh_entry(run["synthesis"])
        return run

    def _refresh_entry(self, entry: dict[str, Any]) -> None:
        task = self.bridge.task(entry["task_id"])
        entry["status"] = task["status"]
        entry["started"] = bool(task.get("started"))
        entry["started_at"] = task.get("started_at")
        entry["finished_at"] = task.get("finished_at")
        entry["error"] = task.get("error")

    @staticmethod
    def _all_terminal(entries: list[dict[str, Any]]) -> bool:
        return bool(entries) and all(entry.get("status") in TERMINAL for entry in entries)

    @staticmethod
    def _completed(entries: dict[str, dict[str, Any]]) -> list[str]:
        return [key for key, entry in entries.items() if entry.get("status") == "completed"]

    def _resolve_artifact(self, entry: dict[str, Any], filename: str) -> Path:
        path = Path(entry["workspace"]) / filename
        if not path.is_file():
            raise FileNotFoundError(f"expected completed artifact missing: {path}")
        return path

    def _stage_primary_inputs(self, run: dict[str, Any], destination: Path) -> list[str]:
        inputs = destination / "inputs"
        inputs.mkdir(parents=True, exist_ok=True)
        staged: list[str] = []
        for agent_id in self._completed(run["primary"]):
            source = self._resolve_artifact(run["primary"][agent_id], "primary.md")
            target = inputs / f"primary-{agent_id}.md"
            shutil.copy2(source, target)
            staged.append(target.name)
            run["primary"][agent_id]["artifact"] = str(source)
        return staged

    @staticmethod
    def _review_pairs(participants: list[str], successful: list[str]) -> list[tuple[str, str]]:
        active = [agent for agent in participants if agent in successful]
        if len(active) < 2:
            return []
        return [(reviewer, active[index - 1]) for index, reviewer in enumerate(active)]

    def _review_prompt(self, run: dict[str, Any], reviewer: str, target: str) -> str:
        return f"""You are the cross-reviewer in a multi-agent team run.

Shared goal:
{run['goal']}

Primary report you must review:
inputs/primary-{target}.md

Other primary reports in `inputs/` are comparison context.
Audit the target independently for:
1. unsupported claims or missing evidence,
2. contradictions with the other primary reports,
3. implementation/operational risks,
4. important omissions,
5. concrete corrections or validation steps.

Reviewer identity: {reviewer} ({ROLE_PROFILES[reviewer]['label']})
Target identity: {target} ({ROLE_PROFILES[target]['label']})

Create `review.md`. It is mandatory. Do not edit the staged input files.
"""

    def _start_reviews(self, run: dict[str, Any]) -> dict[str, Any]:
        successful = self._completed(run["primary"])
        minimum = int(run.get("policy", {}).get("min_primary_success", min(3, len(run["participants"]))))
        if len(successful) < minimum:
            run["status"] = "failed"
            run["phase"] = "failed"
            run["errors"].append(
                f"only {len(successful)} primary tasks completed; minimum is {minimum}"
            )
            return run
        run_root = Path(run["run_root"])
        for reviewer, target in self._review_pairs(run["participants"], successful):
            review_id = f"{reviewer}-reviews-{target}"
            review_workspace = run_root / "reviews" / review_id
            review_workspace.mkdir(parents=True, exist_ok=True)
            self._stage_primary_inputs(run, review_workspace)
            task = self.bridge.submit(
                agent_id=reviewer,
                title=f"[{run['run_id']}] Review {target} by {reviewer}",
                prompt=self._review_prompt(run, reviewer, target),
                workspace=str(review_workspace),
                metadata={
                    "team_run_id": run["run_id"],
                    "team_phase": "review",
                    "reviewer": reviewer,
                    "target_agent": target,
                    "expected_artifacts": ["review.md"],
                },
            )
            run["reviews"][review_id] = {
                "reviewer": reviewer,
                "target": target,
                "task_id": task["task_id"],
                "workspace": str(review_workspace),
                "status": task["status"],
                "started": bool(task.get("started")),
                "artifact": None,
            }
        run["status"] = "review_running"
        run["phase"] = "review"
        run["phase_started_at"] = _utcnow()
        return run

    def _select_synthesizer(self, run: dict[str, Any]) -> str:
        available = set(self.available_agents())
        successful_primary = set(self._completed(run["primary"]))
        for agent_id in SYNTHESIS_PREFERENCE:
            if (
                agent_id in run["participants"]
                and agent_id in available
                and agent_id in successful_primary
            ):
                return agent_id
        for agent_id in run["participants"]:
            if agent_id in available and agent_id in successful_primary:
                return agent_id
        raise RuntimeError("no successful primary worker is currently available for synthesis")

    def _start_synthesis(self, run: dict[str, Any]) -> dict[str, Any]:
        completed_reviews = self._completed(run["reviews"])
        minimum = int(run.get("policy", {}).get("min_review_success", min(2, len(run["participants"]))))
        if len(completed_reviews) < minimum:
            run["status"] = "failed"
            run["phase"] = "failed"
            run["errors"].append(
                f"only {len(completed_reviews)} reviews completed; minimum is {minimum}"
            )
            return run
        synth_agent = self._select_synthesizer(run)
        synth_workspace = Path(run["run_root"]) / "synthesis"
        synth_workspace.mkdir(parents=True, exist_ok=True)
        staged_primary = self._stage_primary_inputs(run, synth_workspace)
        review_inputs = synth_workspace / "inputs"
        staged_reviews: list[str] = []
        for review_id in completed_reviews:
            entry = run["reviews"][review_id]
            source = self._resolve_artifact(entry, "review.md")
            target = review_inputs / f"review-{review_id}.md"
            shutil.copy2(source, target)
            staged_reviews.append(target.name)
            entry["artifact"] = str(source)
        prompt = f"""You are the synthesis editor for a completed multi-agent run.

Shared goal:
{run['goal']}

The `inputs/` directory contains independent primary reports and cross-reviews.
Primary files: {', '.join(staged_primary)}
Review files: {', '.join(staged_reviews)}

Produce a decision-quality synthesis that:
- identifies agreements and material disagreements,
- distinguishes evidence from assumptions,
- incorporates valid reviewer corrections,
- records unresolved questions instead of hiding them,
- gives concrete prioritized next actions,
- preserves minority/contrarian findings when they are evidence-backed.

Create `final.md`. It is mandatory. Do not edit input files.
"""
        task = self.bridge.submit(
            agent_id=synth_agent,
            title=f"[{run['run_id']}] Final team synthesis",
            prompt=prompt,
            workspace=str(synth_workspace),
            metadata={
                "team_run_id": run["run_id"],
                "team_phase": "synthesis",
                "expected_artifacts": ["final.md"],
            },
        )
        run["synthesis"] = {
            "agent_id": synth_agent,
            "task_id": task["task_id"],
            "workspace": str(synth_workspace),
            "status": task["status"],
            "started": bool(task.get("started")),
            "artifact": None,
        }
        run["status"] = "synthesis_running"
        run["phase"] = "synthesis"
        run["phase_started_at"] = _utcnow()
        return run

    def _apply_phase_deadline(
        self,
        run: dict[str, Any],
        *,
        phase: str,
        entries: list[dict[str, Any]],
    ) -> None:
        policy = run.get("policy", {})
        soft = float(policy.get(f"{phase}_soft_timeout_seconds", 90))
        default_hard = 420 if phase == "primary" else 300
        hard = float(policy.get(f"{phase}_hard_timeout_seconds", default_hard))
        age = _age_seconds(run.get("phase_started_at") or run.get("created_at"))
        active = [entry for entry in entries if entry.get("status") not in TERMINAL]
        if not active:
            return
        nudges = run.setdefault("nudges", {})
        if age >= soft and phase not in nudges:
            nudges[phase] = _utcnow()
            run.setdefault("warnings", []).append(
                f"{phase} soft timeout observed after {int(age)}s; "
                "no follow-up message was injected because worker follow-ups create a new model turn"
            )
        if age >= hard:
            for entry in active:
                try:
                    self.bridge.cancel(entry["task_id"])
                except Exception as exc:
                    run.setdefault("errors", []).append(
                        f"hard-timeout cancellation failed for {entry['task_id']}: {exc}"
                    )
            run.setdefault("errors", []).append(
                f"{phase} hard timeout reached after {int(age)}s; continuing in degraded mode"
            )
            for entry in active:
                self._refresh_entry(entry)

    def advance(self, run_id: str) -> dict[str, Any]:
        run = self.runs.load(run_id)
        if run.get("status") not in ACTIVE_RUN_STATUSES:
            return run
        run = self._refresh_task_views(run)
        if run["status"] == "primary_running":
            entries = list(run["primary"].values())
            self._apply_phase_deadline(run, phase="primary", entries=entries)
            if self._all_terminal(entries):
                run = self._start_reviews(run)
        elif run["status"] == "review_running":
            entries = list(run["reviews"].values())
            self._apply_phase_deadline(run, phase="review", entries=entries)
            if self._all_terminal(entries):
                run = self._start_synthesis(run)
        elif run["status"] == "synthesis_running":
            entry = run.get("synthesis") or {}
            self._apply_phase_deadline(run, phase="synthesis", entries=[entry])
            if entry.get("status") in TERMINAL:
                if entry.get("status") == "completed":
                    try:
                        final_path = self._resolve_artifact(entry, "final.md")
                    except FileNotFoundError as exc:
                        run["status"] = "failed"
                        run["phase"] = "failed"
                        run["errors"].append(str(exc))
                    else:
                        entry["artifact"] = str(final_path)
                        run["status"] = "completed"
                        run["phase"] = "completed"
                        run["final_artifact"] = str(final_path)
                else:
                    run["status"] = "failed"
                    run["phase"] = "failed"
                    run["errors"].append(
                        f"synthesis task ended with {entry.get('status')}: "
                        f"{entry.get('error') or ''}".strip()
                    )
        self.runs.save(run)
        return run

    def advance_all(self) -> list[dict[str, Any]]:
        results = []
        for run in self.runs.list(active_only=True):
            try:
                results.append(self.advance(run["run_id"]))
            except Exception as exc:
                current = self.runs.load(run["run_id"])
                current["status"] = "failed"
                current["phase"] = "failed"
                current.setdefault("errors", []).append(str(exc))
                self.runs.save(current)
                results.append(current)
        return results
