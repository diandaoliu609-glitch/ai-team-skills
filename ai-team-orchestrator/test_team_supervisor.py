from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from team_supervisor import TEAM_ORDER, TeamSupervisor


class FakeBridge:
    def __init__(self) -> None:
        self._counter = 0
        self._tasks: dict[str, dict] = {}
        self.messages: list[tuple[str, str]] = []
        self.cancellations: list[str] = []

    def agents(self):
        return [
            {
                "agent_id": agent_id,
                "configured": True,
                "available": True,
                "queueable": True,
            }
            for agent_id in TEAM_ORDER
        ]

    def submit(self, *, agent_id, title, prompt, workspace=".", metadata=None):
        self._counter += 1
        task_id = f"task_{self._counter}"
        task = {
            "task_id": task_id,
            "agent_id": agent_id,
            "title": title,
            "prompt": prompt,
            "workspace": workspace,
            "metadata": metadata or {},
            "status": "queued",
            "started": False,
            "started_at": None,
            "finished_at": None,
            "error": None,
        }
        self._tasks[task_id] = task
        return dict(task)

    def task(self, task_id):
        return dict(self._tasks[task_id])

    def message(self, task_id: str, message: str):
        self.messages.append((task_id, message))
        return {"task_id": task_id, "message": message}

    def cancel(self, task_id: str):
        self.cancellations.append(task_id)
        task = self._tasks[task_id]
        task["status"] = "cancelled"
        task["finished_at"] = "2026-01-01T00:00:02+00:00"
        return dict(task)

    def complete(self, task_id: str, filename: str, content: str) -> None:
        task = self._tasks[task_id]
        workspace = Path(task["workspace"])
        workspace.mkdir(parents=True, exist_ok=True)
        (workspace / filename).write_text(content, encoding="utf-8")
        task["status"] = "completed"
        task["started"] = True
        task["started_at"] = "2026-01-01T00:00:00+00:00"
        task["finished_at"] = "2026-01-01T00:00:01+00:00"


class TeamSupervisorTests(unittest.TestCase):
    def test_full_team_primary_review_synthesis_lifecycle(self):
        with tempfile.TemporaryDirectory() as tmp:
            bridge = FakeBridge()
            supervisor = TeamSupervisor(
                bridge,
                state_dir=Path(tmp) / "state",
            )
            run = supervisor.start_run(
                goal="Design a tiny multi-agent validation protocol.",
                workspace=str(Path(tmp) / "work"),
            )

            self.assertEqual(run["participants"], TEAM_ORDER)
            self.assertEqual(run["status"], "primary_running")
            self.assertEqual(len(run["primary"]), 5)
            primary_workspaces = {
                entry["workspace"] for entry in run["primary"].values()
            }
            self.assertEqual(len(primary_workspaces), 5)

            for agent_id, entry in run["primary"].items():
                bridge.complete(
                    entry["task_id"],
                    "primary.md",
                    f"# {agent_id}\nprimary result\n",
                )

            run = supervisor.advance(run["run_id"])
            self.assertEqual(run["status"], "review_running")
            self.assertEqual(len(run["reviews"]), 5)
            pairs = {
                (entry["reviewer"], entry["target"])
                for entry in run["reviews"].values()
            }
            self.assertEqual(
                pairs,
                {
                    ("dsh", "doubao"),
                    ("gemini", "dsh"),
                    ("grok", "gemini"),
                    ("qwen", "grok"),
                    ("doubao", "qwen"),
                },
            )
            for entry in run["reviews"].values():
                inputs = Path(entry["workspace"]) / "inputs"
                self.assertEqual(len(list(inputs.glob("primary-*.md"))), 5)
                bridge.complete(
                    entry["task_id"],
                    "review.md",
                    f"# Review\n{entry['reviewer']} -> {entry['target']}\n",
                )

            run = supervisor.advance(run["run_id"])
            self.assertEqual(run["status"], "synthesis_running")
            self.assertEqual(run["synthesis"]["agent_id"], "gemini")
            synth_inputs = Path(run["synthesis"]["workspace"]) / "inputs"
            self.assertEqual(len(list(synth_inputs.glob("primary-*.md"))), 5)
            self.assertEqual(len(list(synth_inputs.glob("review-*.md"))), 5)

            bridge.complete(
                run["synthesis"]["task_id"],
                "final.md",
                "# Final\nvalidated synthesis\n",
            )
            run = supervisor.advance(run["run_id"])
            self.assertEqual(run["status"], "completed")
            self.assertTrue(Path(run["final_artifact"]).is_file())
            self.assertEqual(
                Path(run["final_artifact"]).read_text(encoding="utf-8"),
                "# Final\nvalidated synthesis\n",
            )

    def test_requested_subset_preserves_team_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            bridge = FakeBridge()
            supervisor = TeamSupervisor(bridge, state_dir=Path(tmp) / "state")
            run = supervisor.start_run(
                goal="Compare two views.",
                workspace=str(Path(tmp) / "work"),
                participants=["doubao", "dsh", "grok"],
            )
            self.assertEqual(run["participants"], ["dsh", "grok", "doubao"])

    def test_missing_primary_artifacts_fail_truthfully(self):
        with tempfile.TemporaryDirectory() as tmp:
            bridge = FakeBridge()
            supervisor = TeamSupervisor(bridge, state_dir=Path(tmp) / "state")
            run = supervisor.start_run(
                goal="Fail when a claimed artifact is absent.",
                workspace=str(Path(tmp) / "work"),
                participants=["dsh", "gemini"],
            )
            for entry in run["primary"].values():
                task = bridge._tasks[entry["task_id"]]
                task["status"] = "completed"
                task["started"] = True
                task["finished_at"] = "2026-01-01T00:00:01+00:00"

            with self.assertRaises(FileNotFoundError):
                supervisor.advance(run["run_id"])

    def test_phase_deadline_nudges_then_degrades(self):
        with tempfile.TemporaryDirectory() as tmp:
            bridge = FakeBridge()
            supervisor = TeamSupervisor(bridge, state_dir=Path(tmp) / "state")
            run = supervisor.start_run(
                goal="Exercise deadline policy.",
                workspace=str(Path(tmp) / "work"),
                participants=["dsh", "gemini", "grok"],
            )
            for agent_id in ("dsh", "gemini"):
                entry = run["primary"][agent_id]
                bridge.complete(entry["task_id"], "primary.md", f"# {agent_id}\n")
            run["phase_started_at"] = "2020-01-01T00:00:00+00:00"
            run["policy"]["primary_soft_timeout_seconds"] = 1
            run["policy"]["primary_hard_timeout_seconds"] = 2
            run["policy"]["min_primary_success"] = 2
            supervisor.runs.save(run)

            advanced = supervisor.advance(run["run_id"])
            self.assertIn("primary", advanced["nudges"])
            self.assertEqual(bridge.messages, [])
            self.assertEqual(len(bridge.cancellations), 1)
            self.assertEqual(advanced["status"], "review_running")
            self.assertEqual(len(advanced["reviews"]), 2)


if __name__ == "__main__":
    unittest.main()
