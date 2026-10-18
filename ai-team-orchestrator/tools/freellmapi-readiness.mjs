/**
 * FreeLLMAPI 隔离只读探针。
 * 仅 GET /api/ping。绝不调用任何 /v1/* 推理端点，
 * 不导入凭据、不启用模型、不重试或切换收费提供商。
 */
import { pathToFileURL } from "node:url";

export function assertLoopbackOrigin(origin) {
  if (typeof origin !== "string" || origin.trim() !== origin) {
    throw new Error("invalid_origin");
  }
  let url;
  try { url = new URL(origin); }
  catch { throw new Error("invalid_origin"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
      !/^\d+$/.test(url.port) || Number(url.port) < 1024 ||
      url.username || url.password || url.pathname !== "/" ||
      url.search || url.hash) {
    throw new Error("loopback_http_only");
  }
  return url.origin;
}

export async function probeFreeLLMAPI({
  origin = "http://127.0.0.1:3001",
  fetchImpl = globalThis.fetch,
  timeoutMs = 2000,
} = {}) {
  const target = assertLoopbackOrigin(origin);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000) {
    throw new Error("invalid_timeout");
  }
  let response;
  try {
    response = await fetchImpl(target + "/api/ping", {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch {
    return { status: "unreachable", address: target, modelCalls: 0 };
  }
  if (response.status !== 200) {
    return { status: "not_ready", address: target, httpStatus: response.status, modelCalls: 0 };
  }
  try {
    const raw = await response.text();
    if (raw.length > 2048) throw new Error("oversize_response");
    const parsed = JSON.parse(raw);
    if (parsed.status !== "ok") throw new Error("unexpected_response");
    return { status: "reachable", address: target, modelCalls: 0 };
  } catch {
    return { status: "invalid_response", address: target, modelCalls: 0 };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origin = process.argv[2] ?? "http://127.0.0.1:3001";
  try {
    const result = await probeFreeLLMAPI({ origin });
    console.log(JSON.stringify(result));
    // reachable 仅说明 HTTP 服务就绪，不代表任何模型资格或计费安全。
    if (result.status !== "reachable") process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ status: "rejected", reason: error.message, modelCalls: 0 }));
    process.exitCode = 2;
  }
}
