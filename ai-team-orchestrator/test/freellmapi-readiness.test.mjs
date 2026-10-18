/** 全部使用本机临时合成 HTTP 服务；零真实模型 API 请求。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { assertLoopbackOrigin, probeFreeLLMAPI } from "../tools/freellmapi-readiness.mjs";

async function localServer(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("拒绝远程主机、URL 路径、携带凭据与非 HTTP 协议", () => {
  for (const target of [
    "https://127.0.0.1:3001", "http://localhost:3001",
    "http://0.0.0.0:3001", "http://192.168.1.2:3001",
    "http://example.com:3001", "file:///etc/passwd",
    "http://127.0.0.1:3001/v1/chat/completions",
    "http://127.0.0.1:3001?token=secret",
    "http://admin:pw@127.0.0.1:3001",
    "http://127.0.0.1:80", " http://127.0.0.1:3001",
  ]) {
    assert.throws(() => assertLoopbackOrigin(target), Error, target);
  }
  assert.equal(assertLoopbackOrigin("http://127.0.0.1:3001"), "http://127.0.0.1:3001");
});

test("唯一允许的请求是 GET /api/ping，不发送任何凭据", async () => {
  const paths = [];
  const server = await localServer((req, res) => {
    paths.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: "2026-10-18T00:00:00Z" }));
  });
  try {
    assert.deepEqual(await probeFreeLLMAPI({ origin: server.url }), {
      status: "reachable", address: server.url, modelCalls: 0,
    });
    assert.deepEqual(paths, [{ method: "GET", url: "/api/ping", auth: undefined }]);
  } finally { await server.close(); }
});

test("服务端 302 不跟随，避免跳往远程推理端点", async () => {
  const paths = [];
  const server = await localServer((req, res) => {
    paths.push(req.url);
    res.writeHead(302, { Location: "https://example.com/v1/chat/completions" });
    res.end();
  });
  try {
    assert.deepEqual(await probeFreeLLMAPI({ origin: server.url }), {
      status: "not_ready", address: server.url, httpStatus: 302, modelCalls: 0,
    });
    assert.deepEqual(paths, ["/api/ping"]);
  } finally { await server.close(); }
});

test("伪装成 HTTP 200 的错误健康报文被拒绝", async () => {
  const server = await localServer((_req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "not-ready" }));
  });
  try {
    const result = await probeFreeLLMAPI({ origin: server.url });
    assert.equal(result.status, "invalid_response");
    assert.equal(result.modelCalls, 0);
  } finally { await server.close(); }
});

test("离线与 401 不会重试或进行模型回退", async () => {
  const server = await localServer((_req, res) => {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "auth" }));
  });
  try {
    assert.equal((await probeFreeLLMAPI({ origin: server.url })).status, "not_ready");
  } finally { await server.close(); }
  assert.equal((await probeFreeLLMAPI({ origin: server.url, timeoutMs: 300 })).status, "unreachable");
});

test("拒绝无界超时，始终失效即停止", async () => {
  await assert.rejects(probeFreeLLMAPI({ timeoutMs: 0 }), /invalid_timeout/);
  await assert.rejects(probeFreeLLMAPI({ timeoutMs: 999999 }), /invalid_timeout/);
  await assert.rejects(probeFreeLLMAPI({ origin: "http://public.example:3001" }), /loopback_http_only/);
});
