/**
 * catalog-refresh.js — DSH 国际模型目录独立刷新模块
 *
 * 解决启动—刷新死锁：本模块不依赖 DSH 插件运行时，可在 worker 启动前
 * 作为独立前置步骤运行。只读 /v3/config 获取目录和价格，不发送 prompt。
 *
 * 安全约束（来自 DSH_RECOVERY_HANDOFF_2026-10-16.md）：
 * - 不得绕过免费门禁，不得手动改缓存时间戳
 * - 不得回退国内/SG/其他模型
 * - 刷新失败 → 标记 blocked，不启动 worker
 * - 真实 API 调用需用户明确授权（本模块只提供能力，不自动执行）
 */

import { promises as fs } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

export const CATALOG_CACHE_PATH = path.join(os.homedir(), ".dsh", ".workbuddy-ai-catalog.json");
export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 小时
export const CONFIG_ENDPOINT = "/v3/config";

export const REFRESH_OK = "refreshed_eligible";
export const REFRESH_NOT_FREE = "refreshed_not_free";
export const REFRESH_FAILED = "refresh_blocked";

/**
 * 默认的 HTTPS fetcher：只做 GET，不发送 prompt。
 * 可注入 fake fetcher 做离线测试。
 */
export function defaultFetcher({ host, endpoint, apiKey, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        path: endpoint,
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`catalog fetch failed: HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`catalog response not JSON: ${e.message}`));
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("catalog fetch timed out"));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * 从目录响应中提取指定模型的免费资格。
 * 返回 { eligible: boolean, reason: string, model: object|null }
 */
export function checkModelFreeEligible(catalog, modelId) {
  if (!catalog || typeof catalog !== "object") {
    return { eligible: false, reason: "catalog_empty", model: null };
  }
  const models = catalog.models ?? catalog.data ?? [];
  const model = models.find((m) => m.id === modelId || m.model === modelId);
  if (!model) {
    return { eligible: false, reason: "model_not_found", model: null };
  }
  const billing = model.billing ?? {};
  const isFree = billing.free === true;
  // credits 可能是 "x0.00" / 0 / "0.00" 等形式
  const credits = String(billing.credits ?? model.credits ?? "");
  const isZeroPrice = credits === "0" || credits === "0.00" || credits === "x0.00" || credits === "";

  if (!isFree) {
    return { eligible: false, reason: "model_not_free", model };
  }
  if (!isZeroPrice) {
    return { eligible: false, reason: "model_not_zero_price", model };
  }
  return { eligible: true, reason: "ok", model };
}

/**
 * 独立刷新目录。全部依赖可注入，支持完全离线测试。
 *
 * @param {object} opts
 * @param {string} opts.host - WorkBuddy 国际站 host
 * @param {string} opts.apiKey - 隔离的 ai-team-intl 凭据
 * @param {string} opts.modelId - 目标模型 ID（如 deepseek-v4.1-flash）
 * @param {string} [opts.cachePath] - 缓存文件路径（默认 ~/.dsh/.workbuddy-ai-catalog.json）
 * @param {function} [opts.fetcher] - 注入的 fetch 函数（默认 defaultFetcher）
 * @param {function} [opts.now] - 注入的时钟（默认 Date.now）
 * @param {function} [opts.writeFile] - 注入的文件写入（默认 fs.writeFile）
 * @returns {Promise<{status: string, reason: string, fetchedAtMs: number|null}>}
 */
export async function refreshCatalog({
  host,
  apiKey,
  modelId,
  cachePath = CATALOG_CACHE_PATH,
  fetcher = defaultFetcher,
  now = Date.now,
  writeFile = fs.writeFile,
} = {}) {
  if (!host || !apiKey || !modelId) {
    return { status: REFRESH_FAILED, reason: "missing_config", fetchedAtMs: null };
  }

  let catalog;
  try {
    catalog = await fetcher({ host, endpoint: CONFIG_ENDPOINT, apiKey });
  } catch (error) {
    return { status: REFRESH_FAILED, reason: `fetch_error:${error.message}`, fetchedAtMs: null };
  }

  const { eligible, reason } = checkModelFreeEligible(catalog, modelId);
  const fetchedAtMs = now();

  if (!eligible) {
    // 即使模型不免费，也写缓存（带时间戳），让门禁读到"新鲜但不合格"而非"过期"
    // 门禁会拒绝启动，这是正确的 fail-closed 行为
    const snapshot = { fetchedAtMs, models: catalog.models ?? catalog.data ?? [], eligibility: { modelId, eligible, reason } };
    try {
      await writeFile(cachePath, JSON.stringify(snapshot, null, 2), "utf-8");
    } catch {
      // 写缓存失败不掩盖"不免费"的结论
    }
    return { status: REFRESH_NOT_FREE, reason, fetchedAtMs };
  }

  const snapshot = {
    fetchedAtMs,
    models: catalog.models ?? catalog.data ?? [],
    eligibility: { modelId, eligible: true, reason: "ok" },
  };
  try {
    await writeFile(cachePath, JSON.stringify(snapshot, null, 2), "utf-8");
  } catch (error) {
    return { status: REFRESH_FAILED, reason: `cache_write_error:${error.message}`, fetchedAtMs: null };
  }
  return { status: REFRESH_OK, reason: "ok", fetchedAtMs };
}

/**
 * 检查本地缓存是否新鲜（24h 内）。供调用方决定是否需要刷新。
 */
export async function isCacheFresh({ cachePath = CATALOG_CACHE_PATH, now = Date.now, readFile = fs.readFile } = {}) {
  try {
    const raw = await readFile(cachePath, "utf-8");
    const snapshot = JSON.parse(raw);
    const age = now() - (snapshot.fetchedAtMs ?? 0);
    return { fresh: age >= 0 && age < CATALOG_MAX_AGE_MS, ageMs: age, fetchedAtMs: snapshot.fetchedAtMs ?? null };
  } catch {
    return { fresh: false, ageMs: Infinity, fetchedAtMs: null };
  }
}
