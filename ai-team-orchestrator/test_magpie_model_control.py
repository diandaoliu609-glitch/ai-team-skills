"""Magpie 启发的模型准入规则：全部合成输入，零真实模型/账号调用。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import unittest
from unittest.mock import patch

from magpie_model_control import (
    PolicyError, fetch_bridge_agents, plan_model_access,
    validate_bridge_url, validate_manifest,
)


NOW = datetime(2026, 10, 18, 16, 0, tzinfo=timezone.utc)
ONLINE = [
    {"worker": "dsh", "online": True, "paused": False},
    {"worker": "opencode", "online": True, "paused": False},
    {"worker": "gemini", "online": False, "paused": True},
    {"worker": "grok", "online": False, "paused": True},
    {"worker": "qwen", "online": False, "paused": False},
]


def good_route() -> dict:
    # 这是假数据，只用于验证准入算法；不能视作某个账号的真实免费额度。
    return {
        "worker": "dsh",
        "provider": "synthetic-provider",
        "model": "synthetic-model",
        "billing": "verified_free",
        "evidence": {
            "provider_terms_url": "https://example.invalid/free-tier",
            "account_quota_checked": True,
        },
        "verified_at": NOW.isoformat(),
        "available_free_requests": 1,
        "max_attempts": 1,
        "fallback": [],
    }


def manifest(route: dict | None = None) -> dict:
    return {"version": 1, "routes": [route] if route is not None else []}


class ModelGuardTests(unittest.TestCase):
    def test_no_verified_models_is_non_dispatching_even_for_online_workers(self):
        result = plan_model_access(ONLINE, manifest(), now=NOW)
        self.assertEqual(result["mode"], "read_only")
        self.assertEqual(result["actual_model_calls"], 0)
        self.assertEqual(result["actual_config_writes"], 0)
        self.assertTrue(all(not w["dispatch_allowed"] for w in result["workers"]))
        self.assertTrue(all(not w["free_routes_pending_runtime_check"] for w in result["workers"]))

    def test_synthetic_positive_is_review_candidate_never_auto_dispatch(self):
        result = plan_model_access(ONLINE, manifest(good_route()), now=NOW)
        dsh = result["workers"][0]
        self.assertEqual(dsh["free_routes_pending_runtime_check"],
                         ["synthetic-provider/synthetic-model"])
        self.assertFalse(dsh["dispatch_allowed"])
        self.assertEqual(dsh["reason"], "live_freeguard_required")

    def test_paused_workers_are_never_part_of_available_routes(self):
        for worker in ("gemini", "grok"):
            route = good_route()
            route["worker"] = worker
            with self.subTest(worker=worker):
                with self.assertRaisesRegex(PolicyError, "paused_worker_disallowed"):
                    validate_manifest(manifest(route))

    def test_any_paid_or_unknown_billing_is_rejected(self):
        for billing in ("paid", "unknown", "trial", "subscription", "free", "auto"):
            route = good_route()
            route["billing"] = billing
            with self.subTest(billing=billing):
                with self.assertRaisesRegex(PolicyError, "unverified_or_paid"):
                    validate_manifest(manifest(route))

    def test_fallback_or_multiretry_are_always_rejected(self):
        r = good_route()
        r["fallback"] = ["paid/model"]
        with self.assertRaisesRegex(PolicyError, "fallback_must_be_empty"):
            validate_manifest(manifest(r))
        r = good_route()
        r["max_attempts"] = 2
        with self.assertRaisesRegex(PolicyError, "retries_must_be_one"):
            validate_manifest(manifest(r))

    def test_automatic_model_alias_is_rejected(self):
        for field, value in (("model", "auto"), ("provider", "fallback"),
                             ("model", "$billing"), ("model", "bad model")):
            r = good_route()
            r[field] = value
            with self.subTest(field=field, value=value):
                with self.assertRaises(PolicyError):
                    validate_manifest(manifest(r))

    def test_free_evidence_must_have_terms_quota_and_positive_allowance(self):
        for wrong in (
            {"evidence": {"provider_terms_url": "https://example.invalid/free-tier",
                          "account_quota_checked": False}},
            {"evidence": {"provider_terms_url": "http://example.invalid",
                          "account_quota_checked": True}},
            {"available_free_requests": 0},
            {"available_free_requests": -1},
            {"available_free_requests": True},
        ):
            r = {**good_route(), **wrong}
            with self.subTest(wrong=wrong):
                with self.assertRaises(PolicyError):
                    validate_manifest(manifest(r))

    def test_secret_in_evidence_url_is_forbidden(self):
        for unsafe in (
            "https://user:pass@provider.invalid/free",
            "https://provider.invalid/free?api_key=fake",
            "https://provider.invalid/free#access_token=fake",
            "http://provider.invalid/free",
        ):
            route = good_route()
            route["evidence"]["provider_terms_url"] = unsafe
            with self.subTest(unsafe=unsafe):
                with self.assertRaises(PolicyError):
                    validate_manifest(manifest(route))

    def test_stale_and_future_quota_proof_cannot_be_used(self):
        for shift in (timedelta(hours=-25), timedelta(minutes=1)):
            r = good_route()
            r["verified_at"] = (NOW + shift).isoformat()
            result = plan_model_access(ONLINE, manifest(r), now=NOW)
            self.assertEqual(result["workers"][0]["free_routes_pending_runtime_check"], [])
            self.assertFalse(result["workers"][0]["dispatch_allowed"])

    def test_offline_worker_cannot_use_still_valid_model(self):
        result = plan_model_access(
            [{**ONLINE[0], "online": False}], manifest(good_route()), now=NOW
        )
        self.assertEqual(result["workers"][0]["free_routes_pending_runtime_check"], [])
        self.assertFalse(result["workers"][0]["dispatch_allowed"])

    def test_missing_or_bad_timestamp_rejected(self):
        for value in ("not-a-date", "2026-10-18T20:00:00", "", None):
            r = good_route()
            r["verified_at"] = value
            with self.subTest(value=value):
                with self.assertRaisesRegex(PolicyError, "verification_date_invalid"):
                    validate_manifest(manifest(r))

    def test_duplicate_routes_unknown_fields_and_wrong_version_rejected(self):
        r = good_route()
        bads = [
            {"version": 1, "routes": [r, r]},
            {"version": 2, "routes": [r]},
            {"version": True, "routes": [r]},
            {"version": 1, "routes": [{**r, "enabled": True}]},
            {"version": 1, "routes": "not-list"},
            {"version": 1, "routes": [], "auto": True},
        ]
        for item in bads:
            with self.subTest(item=item):
                with self.assertRaises(PolicyError):
                    validate_manifest(item)

    def test_credentials_cannot_be_placed_anywhere_in_manifest(self):
        r = good_route()
        r["evidence"] = {**r["evidence"], "api_key": "synthetic-no-secret"}
        with self.assertRaisesRegex(PolicyError, "credentials_not_permitted"):
            validate_manifest(manifest(r))
        with self.assertRaisesRegex(PolicyError, "credentials_not_permitted"):
            validate_manifest({"version": 1, "routes": [], "secret": "synthetic"})

    def test_bridge_origin_must_be_exact_loopback(self):
        self.assertEqual(validate_bridge_url("http://127.0.0.1:8765"),
                         "http://127.0.0.1:8765")
        for url in (
            "http://localhost:8765",
            "http://127.0.0.1:8766",
            "https://127.0.0.1:8765",
            "http://192.168.1.1:8765",
            "http://127.0.0.1:8765/tasks",
            "http://u:p@127.0.0.1:8765/",
            "http://127.0.0.1:8765/?key=anything",
        ):
            with self.subTest(url=url):
                with self.assertRaisesRegex(PolicyError, "bridge_loopback_only"):
                    validate_bridge_url(url)

    def test_bridge_agents_only_exposes_safe_boolean_fields(self):
        class FakeResponse:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, _max):
                return b'{"items":[{"agent_id":"dsh","configured":true,"available":true,"queueable":true,"private_key":"INVISIBLE"},{"agent_id":"gemini","configured":false,"available":false,"queueable":false}]}'

        class FakeOpener:
            def open(self, request, timeout=0):
                self.method = request.get_method()
                self.path = request.full_url
                return FakeResponse()

        fake = FakeOpener()
        with patch("magpie_model_control.build_opener", return_value=fake):
            value = fetch_bridge_agents()
        self.assertEqual(fake.method, "GET")
        self.assertEqual(fake.path, "http://127.0.0.1:8765/agents")
        self.assertEqual(value, [
            {"worker": "dsh", "online": True, "paused": False},
            {"worker": "gemini", "online": False, "paused": True},
        ])
        self.assertNotIn("private_key", str(value))

    def test_malformed_bridge_payload_fails_closed(self):
        class FakeResponse:
            def __init__(self, body): self.body = body
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, _max): return self.body
        class FakeOpener:
            def __init__(self, body): self.body = body
            def open(self, *_args, **_kwargs): return FakeResponse(self.body)
        for body in (b'{}', b'{"items":{}}', b'{"items":[null]}',
                     b'{"items":[{"agent_id":"../evil"}]}'):
            with self.subTest(body=body):
                with patch("magpie_model_control.build_opener", return_value=FakeOpener(body)):
                    with self.assertRaises(PolicyError):
                        fetch_bridge_agents()


if __name__ == "__main__":
    unittest.main()
