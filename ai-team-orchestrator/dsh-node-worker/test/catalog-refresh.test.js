/**
 * catalog-refresh.test.js — 离线测试（零网络、零模型调用）
 *
 * 覆盖场景：stale 触发刷新、刷新成功写缓存、非免费模型拒绝、
 * 网络失败标记 blocked、缺配置拒绝、缓存新鲜度检查。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  refreshCatalog,
  isCacheFresh,
  checkModelFreeEligible,
  REFRESH_OK,
  REFRESH_NOT_FREE,
  REFRESH_FAILED,
  CATALOG_MAX_AGE_MS,
} from "../src/catalog-refresh.js";

const MODEL_ID = "deepseek-v4.1-flash";
const NOW = 1_790_000_000_000;

function validPromo() {
  return { start: NOW - 3600_000, end: NOW + 3600_000, factor: 0 };
}

function freeModel(overrides = {}) {
  return {
    id: MODEL_ID,
    billing: { free: true, credits: "x0.00" },
    promotions: [validPromo()],
    ...overrides,
  };
}

function cacheJson(fetchedAtMs) {
  return JSON.stringify({
    version: 1,
    entries: {
      intl: { source: "workbuddy-ai:app", fetchedAtMs, models: [freeModel()] },
    },
  });
}

describe("checkModelFreeEligible", () => {
  it("免费+零价格 → eligible", () => {
    const r = checkModelFreeEligible({ models: [freeModel()] }, MODEL_ID, NOW);
    assert.equal(r.eligible, true);
    assert.equal(r.reason, "ok");
  });

  it("free=false → 拒绝", () => {
    const r = checkModelFreeEligible({ models: [freeModel({ billing: { free: false, credits: "x0.00" } })] }, MODEL_ID, NOW);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "model_not_free");
  });

  it("有价格 → 拒绝", () => {
    const r = checkModelFreeEligible({ models: [freeModel({ billing: { free: true, credits: "x0.05" } })] }, MODEL_ID, NOW);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "model_not_zero_price");
  });

  it("价格为空 → 拒绝（费用安全：未知价格不得视为免费）", () => {
    const r = checkModelFreeEligible({ models: [freeModel({ billing: { free: true } })] }, MODEL_ID, NOW);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "model_not_zero_price");
  });

  it("价格字段缺失 → 拒绝", () => {
    const m = freeModel();
    delete m.billing;
    const r = checkModelFreeEligible({ models: [m] }, MODEL_ID, NOW);
    assert.equal(r.eligible, false);
  });

  it("促销过期 → 拒绝", () => {
    const expired = { start: NOW - 7200_000, end: NOW - 3600_000, factor: 0 };
    const r = checkModelFreeEligible({ models: [freeModel({ promotions: [expired] })] }, MODEL_ID, NOW);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "free_promotion_expired_or_unverified");
  });

  it("无促销 → 拒绝", () => {
    const r = checkModelFreeEligible({ models: [freeModel({ promotions: [] })] }, MODEL_ID, NOW);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "free_promotion_expired_or_unverified");
  });

  it("模型不在目录 → 拒绝", () => {
    const r = checkModelFreeEligible({ models: [] }, MODEL_ID, NOW);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "model_not_found");
  });

  it("空目录 → 拒绝", () => {
    const r = checkModelFreeEligible(null, MODEL_ID);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "catalog_empty");
  });
});

describe("refreshCatalog", () => {
  const base = { host: "intl.example.com", apiKey: "test-key", modelId: MODEL_ID, now: () => NOW };

  it("刷新成功 → 写门禁兼容格式缓存 + REFRESH_OK", async () => {
    let written = null;
    const fetcher = async () => ({ models: [freeModel()] });
    const r = await refreshCatalog({
      ...base,
      fetcher,
      writeFile: async (p, data) => { written = JSON.parse(data); },
      cachePath: "/tmp/test-catalog.json",
    });
    assert.equal(r.status, REFRESH_OK);
    assert.equal(r.fetchedAtMs, NOW);
    // 验证门禁兼容格式
    assert.equal(written.version, 1);
    assert.equal(written.entries.intl.source, "workbuddy-ai:app");
    assert.equal(written.entries.intl.fetchedAtMs, NOW);
    assert.equal(written.entries.intl.models[0].id, MODEL_ID);
  });

  it("模型不再免费 → REFRESH_NOT_FREE（fail-closed，仍写新鲜缓存）", async () => {
    let written = null;
    const fetcher = async () => ({ models: [freeModel({ billing: { free: false, credits: "x0.10" } })] });
    const r = await refreshCatalog({
      ...base,
      fetcher,
      writeFile: async (p, data) => { written = JSON.parse(data); },
      cachePath: "/tmp/test-catalog.json",
    });
    assert.equal(r.status, REFRESH_NOT_FREE);
    assert.equal(r.reason, "model_not_free");
    // 缓存仍是新鲜的门禁兼容格式，让门禁读到"新鲜但不合格"而非"过期"
    assert.equal(written.version, 1);
    assert.equal(written.entries.intl.fetchedAtMs, NOW);
  });

  it("网络失败 → REFRESH_FAILED（blocked，不写缓存）", async () => {
    let written = false;
    const fetcher = async () => { throw new Error("ECONNREFUSED"); };
    const r = await refreshCatalog({
      ...base,
      fetcher,
      writeFile: async () => { written = true; },
      cachePath: "/tmp/test-catalog.json",
    });
    assert.equal(r.status, REFRESH_FAILED);
    assert.match(r.reason, /fetch_error/);
    assert.equal(written, false);
  });

  it("缺配置 → REFRESH_FAILED", async () => {
    const r = await refreshCatalog({ host: "", apiKey: "", modelId: "" });
    assert.equal(r.status, REFRESH_FAILED);
    assert.equal(r.reason, "missing_config");
  });

  it("响应非 JSON → REFRESH_FAILED", async () => {
    const fetcher = async () => { throw new Error("catalog response not JSON: bad"); };
    const r = await refreshCatalog({ ...base, fetcher, cachePath: "/tmp/t.json" });
    assert.equal(r.status, REFRESH_FAILED);
  });
});

describe("isCacheFresh", () => {
  it("24h 内 → fresh", async () => {
    const readFile = async () => cacheJson(NOW - 3600_000);
    const r = await isCacheFresh({ now: () => NOW, readFile });
    assert.equal(r.fresh, true);
  });

  it("超过 24h → stale（当前 Mac 故障的复现）", async () => {
    // 复现：缓存 2026-10-13 12:03，检查时已过 3 天
    const readFile = async () => cacheJson(NOW - 3 * CATALOG_MAX_AGE_MS);
    const r = await isCacheFresh({ now: () => NOW, readFile });
    assert.equal(r.fresh, false);
  });

  it("缓存文件不存在 → stale", async () => {
    const readFile = async () => { throw new Error("ENOENT"); };
    const r = await isCacheFresh({ now: () => NOW, readFile });
    assert.equal(r.fresh, false);
  });

  it("旧格式缓存（无 entries）→ stale", async () => {
    const readFile = async () => JSON.stringify({ fetchedAtMs: NOW - 1000, models: [] });
    const r = await isCacheFresh({ now: () => NOW, readFile });
    assert.equal(r.fresh, false);
  });
});
