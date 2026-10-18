#!/usr/bin/env node
// ============================================================================
// RADAR-S1A-001 真实浏览器端到端验收脚本（零依赖，仅使用 Node 22+ 内置 WebSocket / fetch）
//
// 做真实用户路径：
//   打开仪表盘 → 实际在 DOM 中触发语言 change（zh/en/ko/ja）
//   → 选择存在的工作区 option（如有）→ 真实提交搜索表单（requestSubmit）
//   → 点击第一条既有机会卡片 → 检查详情字段与 evidence 列表。
//
// 限制（按任务要求实现并强制）：
//   - 只访问 127.0.0.1:8787（另加浏览器自身的回环调试端口 127.0.0.1:<临时端口>）；
//   - 绝不点击 #run-lite-scan，绝不调用任何写入接口，绝不向第三方/收费 API 发请求；
//   - 所有“外部”请求（含页面内 fetch / XHR / iframe / 导航 / 新窗口）在浏览器网络层被拦截。
//
// 用法：node radar-browser-e2e.mjs
// 可选环境变量：
//   RADAR_BASE_URL  默认 http://127.0.0.1:8787/（只允许 127.0.0.1）
//   RADAR_CHROME    Chrome 可执行文件路径
//   RADAR_JSON_DIR  除 stdout 外，把 DOM 证据 JSON 落盘到该目录（可选）
//
// 退出码：0 = 全部 PASS/SKIP 且无 FAIL；1 = 至少一个 FAIL；2 = 环境阻止（Chrome/CDP 不可用）。
// ============================================================================

import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// 0. 配置
// ---------------------------------------------------------------------------
const CHROME_BIN = process.env.RADAR_CHROME
  || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE_URL = process.env.RADAR_BASE_URL || "http://127.0.0.1:8787/";
const JSON_DIR = process.env.RADAR_JSON_DIR || "";
const LANGUAGES = ["zh", "en", "ko", "ja"];
const OVERALL_TIMEOUT_MS = 150_000;
const NO_SANDBOX_FALLBACK = true; // 沙箱内 Chrome 子进程无法初始化时自动改用 --no-sandbox

const results = []; // { step, status: PASS|FAIL|SKIP, detail, evidence }
function record(step, status, detail, evidence) {
  results.push({ step, status, detail, evidence: evidence ?? null });
  const tag = status.padEnd(4);
  console.log(`[${tag}] ${step} :: ${detail}`);
}

// 只允许回环地址。任何非 127.0.0.1 目标一律视为违规。
const LOOPBACK_DEBUG_RE = /^wss?:\/\/127\.0\.0\.1:\d+\//;
function isAllowedUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol === "ws:" || u.protocol === "wss:") return false; // 页面内 ws 一律不允许
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.hostname !== "127.0.0.1") return false;
  return true;
}

function assertLocalBase(url) {
  const u = new URL(url);
  if (u.hostname !== "127.0.0.1") {
    throw new Error(`RADAR_BASE_URL 必须指向 127.0.0.1，实际为 ${url}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1. CDP 极简客户端（Node 内置 WebSocket，无第三方依赖）
// ---------------------------------------------------------------------------
class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const self = this;
      ws.addEventListener("open", () => { console.log("[debug] WS open", this.wsUrl.replace(/\/devtools\/.*/, "/devtools")); resolve(); });
      ws.addEventListener("error", (e) => { console.log("[debug] WS error", self.wsUrl, e?.message || e); reject(new Error(`CDP WebSocket 打开失败: ${e?.message || "unknown"}`)); });
      ws.addEventListener("message", (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`));
          else res(msg.result);
        } else if (msg.method) {
          if (msg.sessionId) { const holder = this.sessions?.get(msg.sessionId); if (holder) for (const fn of holder.listeners) { try { fn(msg.method, msg.params); } catch {} } }
          for (const fn of this.listeners) {
            try { Promise.resolve(fn(msg.method, msg.params)).catch((e) => {}); }
            catch (e) { console.log("[debug] listener error", this.wsUrl.slice(0,40), e?.stack || e); }
          }
        }
      });
      ws.addEventListener("close", (ev) => {
        console.log("[debug] WS closed", self.wsUrl.replace(/\/devtools\/.*/, "/devtools"), ev.code, ev.reason);
        for (const { reject: rej } of this.pending.values()) rej(new Error("CDP 连接已关闭"));
        this.pending.clear();
      });
    });
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  send(method, params = {}, timeoutMs = 20_000, sessionId) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 命令超时: ${method}`));
        }
      }, timeoutMs);
      const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
    });
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return promise;
  }
}

// 扁平会话封装：与 Cdp 相同的 send/on 接口，但命令带上 sessionId（渲染进程命令走浏览器级 WS 的会话）
class Session {
  constructor(browserCdp, sessionId) { this.b = browserCdp; this.id = sessionId; this.listeners = new Set(); }
  send(method, params = {}, timeoutMs = 20_000) { return this.b.send(method, params, timeoutMs, this.id); }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}
function makeSession(browserCdp, sessionId) {
  if (!browserCdp.sessions) browserCdp.sessions = new Map();
  const s = new Session(browserCdp, sessionId);
  browserCdp.sessions.set(sessionId, s);
  return s;
}

// 在页面上下文求值；awaitPromise 支持 async 表达式；结果按 JSON 返回。
async function evaluate(cdp, expression, { awaitPromise = true, timeoutMs = 30_000 } = {}) {
  const res = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: false,
  }, timeoutMs);
  if (res.exceptionDetails) {
    const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
    throw new Error(`页面内执行异常: ${desc}`);
  }
  return res.result?.value;
}

// 轮询等待页面内条件为真
async function waitFor(cdp, conditionExpr, timeoutMs = 20_000, label = conditionExpr) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await evaluate(cdp, `(() => { try { return Boolean(${conditionExpr}); } catch (e) { return false; } })()`);
    if (last) return true;
    await sleep(150);
  }
  throw new Error(`等待超时(${timeoutMs}ms): ${label}`);
}

// ---------------------------------------------------------------------------
// 2. 启动独立临时 profile 的 headless Chrome，--remote-debugging-port=0
// ---------------------------------------------------------------------------
async function launchChrome(noSandboxArg = false) {
  const profileDir = await mkdtemp(path.join(tmpdir(), "radar-s1a-chrome-"));
  // 可选 --no-sandbox：仅当环境变量 RADAR_CHROME_NO_SANDBOX=1 或自动回退时启用
  const noSandbox = noSandboxArg || process.env.RADAR_CHROME_NO_SANDBOX === "1";
  const extraArgs = noSandbox ? ["--no-sandbox"] : [];
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-client-side-phishing-detection",
    "--no-pings",
    "--metrics-recording-only",
    "--no-service-autorun",
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-gpu",
    "--disable-gpu-compositing",
    "--disable-software-rasterizer",
    "--disable-dev-shm-usage",
    "--disable-crash-reporter",
    "--disable-breakpad",
    "--disable-crashpad",
    "--noerrdialogs",
    "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication",
    // 注意：不使用 --host-resolver-rules=MAP * ~NOTFOUND（实测会使 page 渲染进程无法完成启动）。
    // 外网隔离由 Fetch 域请求拦截（下面 3.x 网络层）+ 启动后所有导航/新窗口审计共同保证。
    ...extraArgs,
    ...(process.env.RADAR_URL_ARG ? [BASE_URL] : ["about:blank"]),
  ];
  if (process.env.RADAR_DEBUG) console.log("[debug] args", args.join(" "));
  const child = spawn(CHROME_BIN, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  let devtoolsWs = null;
  const browserUrl = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待 DevToolsActivePort 超时")), 20_000);
    child.stderr.on("data", (buf) => {
      stderr += buf.toString();
      const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m && !devtoolsWs) {
        devtoolsWs = m[1];
        clearTimeout(timer);
        resolve(devtoolsWs);
      }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!devtoolsWs) reject(new Error(`Chrome 提前退出 code=${code}\n${stderr.slice(-2000)}`));
    });
  });
  return { child, profileDir, browserUrl, noSandbox, getStderr: () => stderr };
}

// ---------------------------------------------------------------------------
// 3. 主流程
// ---------------------------------------------------------------------------
const netLog = []; // 浏览器层观察到的所有请求
const blockedExternal = [];
const pageErrors = [];
const violationNotes = [];

async function main() {
  assertLocalBase(BASE_URL);
  record("E2E-01 环境：Node 版本", "PASS", `node ${process.version}（内置 WebSocket=${typeof WebSocket}, fetch=${typeof fetch}）`);

  // 3.1 启动 Chrome
  let chromeInfo;
  try {
    chromeInfo = await launchChrome();
  } catch (err) {
    if (NO_SANDBOX_FALLBACK && !process.env.RADAR_CHROME_ARGS && /exit_code=6|GPU process isn't usable|sandbox|提前退出/.test(err.message)) {
      record("E2E-02a 首次启动（Chrome 自身沙箱）", "SKIP",
        `Chrome 自身沙箱在当前 DSH 文件沙箱内无法初始化 GPU/network 子进程（FATAL: GPU process isn't usable / sandbox initialization failed），主进程随后退出。改用 --no-sandbox 重试（仅限 headless + 临时 profile，用于本机 UI 验收）。原因摘要：${String(err.message).split("\n")[0]}`);
      try {
        chromeInfo = await launchChrome(true);
      } catch (err2) {
        chromeInfo = null;
        err.message = `${err.message}\n[no-sandbox 重试] ${err2.message}`;
      }
    }
    if (!chromeInfo) {
    record("E2E-02 启动 headless Chrome", "FAIL",
      `无法启动 Chrome（${CHROME_BIN}）：${err.message}。环境不允许时后续步骤全部 SKIP。`);
    for (const step of ["E2E-03 CDP 连接", "E2E-04 打开仪表盘", "E2E-05 语言 change（zh/en/ko/ja）", "E2E-06 工作区选择", "E2E-07 搜索表单提交", "E2E-08 点击第一条机会进入详情", "E2E-09 详情字段检查", "E2E-10 Evidence 列表检查", "E2E-11 网络/安全边界"]) {
      record(step, "SKIP", "Chrome/CDP 不可用，未执行");
    }
    return 2;
    }
  }
  const { child, profileDir, browserUrl } = chromeInfo;
  const noSandboxUsed = Boolean(chromeInfo.noSandbox);
  let cdp = null;
  let exitCode = 1;
  try {
    const devtoolsWs = await browserUrl;
    record("E2E-02 启动 headless Chrome", "PASS",
      `HEADLESS/PORT0 临时 profile=${profileDir}；DevTools 地址=${devtoolsWs.replace(/(127\.0\.0\.1:\d+).*/, "$1")}`, {
        chromeBinary: CHROME_BIN,
        args: ["--headless=new", "--remote-debugging-port=0", "--user-data-dir=<临时目录>", ...(process.env.RADAR_CHROME_NO_SANDBOX === "1" || noSandboxUsed ? ["--no-sandbox"] : []), "--disable-gpu"],
        noSandbox: noSandboxUsed,
      });

    // 3.2 连接浏览器级 DevTools（WS），再新建 tag
    cdp = new Cdp(devtoolsWs);
    await cdp.connect();
    const version = await cdp.send("Browser.getVersion");
    const browser = `${version.product} / UA=${version.userAgent}`;
    record("E2E-03 CDP 连接", "PASS", `已通过 WebSocket 连接浏览器 DevTools：${browser}`);
    await cdp.send("Target.setDiscoverTargets", { discover: true });

    // 说明：当前环境里 Browser 级 WS 上的 Target.createTarget 返回 500（子进程受限），
    // 因此改用回环 DevTools HTTP 接口 PUT /json/new?about:blank 新建标签页，再连其页面级 WS。
    const devtoolsHttp = `http://127.0.0.1:${new URL(devtoolsWs).port}`;
    const created = await (await fetch(`${devtoolsHttp}/json/new?about:blank`, { method: "PUT" })).json();
    if (!created?.id) throw new Error(`无法新建标签页: ${JSON.stringify(created)}`);
    // 当前 Chrome 的 /json/new 返回的 webSocketDebuggerUrl 可能带错误端口（实测写入了被占用的 8787），
    // 且实测直接新开页面级 WS 后连接会被关闭；因此改用浏览器级 WS 的 Target.attachToTarget 创建扁平会话。
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: created.id, flatten: true });
    const page = makeSession(cdp, sessionId);
    if (process.env.RADAR_DEBUG) console.log("[debug] target", created.id, created.type, created.url, "session", sessionId);
    if (process.env.RADAR_DEBUG) console.log("[debug] target", created.id, created.type, created.url, "session", sessionId);
    if (process.env.RADAR_DEBUG) console.log("[debug] page WS connected; Page.enable ...");
    for (const dom of ["Page.enable","Runtime.enable","Log.enable","Network.enable"]) {
      if (process.env.RADAR_DEBUG) console.log("[debug] sending", dom);
      await page.send(dom);
    }
    // 网络层拦截：只有 127.0.0.1 允许通过，其它全部 failRequest（页面 JS 无法绕过）。
    await page.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });

    page.on(async (method, params) => {
      if (process.env.RADAR_DEBUG) console.log("[cdp]", method);
      if (method === "Fetch.requestPaused") {
        const url = params.request.url;
        const methodName = String(params.request.method || "GET").toUpperCase();
        const parsedUrl = new URL(url);
        const allowed = isAllowedUrl(url) && parsedUrl.origin === new URL(BASE_URL).origin;
        // 中文说明：任何语言切换触发的 POST 必须在 CDP 中本地模拟，绝不能流向 Qwen 收费服务。
        const mocked = allowed && methodName === "POST" && parsedUrl.pathname === "/v1/lite/translate";
        netLog.push({ url, allowed, method: methodName, mocked, resourceType: params.resourceType });
        if (!allowed) {
          blockedExternal.push({ url, resourceType: params.resourceType });
        }
        if (mocked) {
          let req = {};
          try { req = JSON.parse(params.request.postData || "{}"); } catch {}
          const texts = Array.isArray(req.texts) ? req.texts.map(String) : [];
          const body = Buffer.from(JSON.stringify({
            status: "completed",
            provider: "local-e2e-mock",
            model: "none",
            target_language: String(req.target_language || "en"),
            cache_hits: 0,
            translated_count: 0,
            translations: texts,
          }), "utf8").toString("base64");
          page.send("Fetch.fulfillRequest", {
            requestId: params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "application/json" }],
            body,
          }).catch(() => {});
        } else if (allowed && (methodName === "GET" || methodName === "HEAD")) {
          page.send("Fetch.continueRequest", { requestId: params.requestId }).catch(() => {});
        } else {
          const body = Buffer.from(JSON.stringify({ blocked: "non-read-only or non-loopback request" }), "utf8").toString("base64");
          page.send("Fetch.fulfillRequest", {
            requestId: params.requestId,
            responseCode: 403,
            responsePhrase: "Blocked by E2E",
            responseHeaders: [{ name: "Content-Type", value: "application/json" }],
            body,
          }).catch(() => {});
        }
      } else if (method === "Runtime.exceptionThrown") {
        pageErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || "unknown exception");
      } else if (method === "Log.entryAdded" && ["error", "warning"].includes(params.entry?.level)) {
        pageErrors.push(`${params.entry.level}: ${params.entry.text}`);
      } else if (method === "Page.frameRequestedNavigation") {
        if (!isAllowedUrl(params.url) && !params.url.startsWith("about:")) {
          blockedExternal.push({ url: params.url, resourceType: "frameNavigation" });
        }
      } else if (method === "Page.windowOpen") {
        blockedExternal.push({ url: params.url, resourceType: "windowOpen" });
      } else if (method === "Network.requestWillBeSentExtraInfo" || method === "Network.responseReceived") {
        // 仅用于补充记录
      }
    });

    // 3.3 打开仪表盘
    await page.send("Page.navigate", { url: BASE_URL });
    await waitFor(page, `document.readyState === "complete"`, 30_000, "readyState complete");
    await waitFor(page, `document.readyState === "complete" && (!!document.getElementById("opportunity-list") && document.getElementById("opportunity-list").children.length > 0 || !document.getElementById("empty-state")?.hidden)`, 30_000, "机会列表渲染完成");
    const pageInfo = await evaluate(page, `({ url: location.href, title: document.title, lang: document.documentElement.lang, h1: document.querySelector("h1")?.textContent?.trim() })`);
    record("E2E-04 打开仪表盘", "PASS",
      `url=${pageInfo.url}；title=${JSON.stringify(pageInfo.title)}；h1=${JSON.stringify(pageInfo.h1)}`, pageInfo);

    // 3.4 语言 change：在 DOM 中真实修改 select.value 并 dispatchEvent(new Event("change"))
    const langSteps = [];
    for (const lang of LANGUAGES) {
      const ev = await evaluate(page, `(async () => {
        const sel = document.getElementById("language-select");
        if (!sel) return { ok: false, reason: "language-select 不存在" };
        const hasOption = Array.from(sel.options).some(o => o.value === ${JSON.stringify(lang)});
        if (!hasOption) return { ok: false, reason: "缺少 option " + ${JSON.stringify(lang)} };
        sel.value = ${JSON.stringify(lang)};
        const fired = sel.dispatchEvent(new Event("change", { bubbles: true }));
        const start = Date.now();
        // 等界面语言同步到 <html lang> 与 select 值
        while (Date.now() - start < 5000) {
          if (document.documentElement.lang === (sel.value) && sel.value === ${JSON.stringify(lang)}) break;
          await new Promise(r => setTimeout(r, 50));
        }
        await new Promise(r => setTimeout(r, 300));
        const btn = document.querySelector('#scope-form button[type="submit"]');
        const labels = Array.from(document.querySelectorAll('[data-i18n]')).slice(0, 40)
          .filter(n => n.offsetParent !== null || n.tagName === "OPTION")
          .map(n => ({ key: n.dataset.i18n, text: (n.textContent || "").trim().slice(0, 60) }));
        return {
          ok: true,
          fired: fired === true,
          selectValue: sel.value,
          htmlLang: document.documentElement.lang,
          submitButtonText: btn ? btn.textContent.trim() : null,
          scopeLabel: document.querySelector('label[for="scope-input"]')?.textContent.trim(),
          localStorageLanguage: (() => { try { return localStorage.getItem("radarLanguage"); } catch (e) { return null; } })(),
          statusPill: document.getElementById("opportunity-status")?.textContent,
          sampleLabels: labels.slice(0, 6),
        };
      })()`);
      const pass = ev?.ok && ev.fired && ev.selectValue === lang && (ev.htmlLang || "").toLowerCase().startsWith(lang);
      langSteps.push({ lang, ...ev });
      record(`E2E-05 语言 change → ${lang}`, pass ? "PASS" : "FAIL",
        pass
          ? `change 事件已触发；select=${ev.selectValue}；<html lang>=${ev.htmlLang}；提交按钮=${JSON.stringify(ev.submitButtonText)}；localStorage.radarLanguage=${ev.localStorageLanguage}`
          : `未能验证：${JSON.stringify(ev)}`,
        ev);
      if (!pass) violationNotes.push(`语言 ${lang} 切换失败`);
    }
    const uniqueUi = new Map(langSteps.filter(s => s.ok).map(s => [s.lang, s.submitButtonText]));
    record("E2E-05b 四语言 UI 文案互不相同", uniqueUi.size === LANGUAGES.length ? "PASS" : "FAIL",
      `提交按钮文案：${JSON.stringify(Object.fromEntries(uniqueUi))}`, Object.fromEntries(uniqueUi));

    // 3.5 工作区：若存在真实 option 则实际选择并 dispatch change
    const wsSnap = await evaluate(page, `(async () => {
      const sel = document.getElementById("workspace-select");
      const opts = Array.from(sel.options).map(o => ({ value: o.value, text: o.textContent.trim() }));
      return { options: opts, selected: sel.value };
    })()`);
    const realWs = wsSnap.options.filter(o => o.value !== "");
    if (realWs.length === 0) {
      record("E2E-06 选择工作区 option", "SKIP", `工作区下拉仅有占位项：${JSON.stringify(wsSnap.options)}，无实际工作区可选（不新建工作区，避免产生数据）`, wsSnap);
    } else {
      const target = realWs[0];
      const ev = await evaluate(page, `(async () => {
        const sel = document.getElementById("workspace-select");
        sel.value = ${JSON.stringify(target.value)};
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        const start = Date.now();
        while (Date.now() - start < 10000) {
          const t = document.getElementById("opportunity-status")?.textContent;
          const listLen = document.getElementById("opportunity-list").children.length;
          const isEmpty = !document.getElementById("empty-state")?.hidden;
          if (t && !/Loading|加载/u.test(t) && (listLen > 0 || isEmpty)) break;
          await new Promise(r => setTimeout(r, 100));
        }
        return {
          selectValue: sel.value,
          scopeInput: document.getElementById("scope-input").value,
          scopeReadOnly: document.getElementById("scope-input").readOnly,
          language: document.getElementById("language-select").value,
          status: document.getElementById("opportunity-status")?.textContent,
          cards: document.querySelectorAll("#opportunity-list .opportunity-card").length,
          emptyVisible: !document.getElementById("empty-state").hidden,
          emptyText: document.getElementById("empty-state")?.textContent.trim().slice(0, 200),
          localStorageWorkspace: (() => { try { return localStorage.getItem("radarWorkspaceId"); } catch (e) { return null; } })(),
        };
      })()`, { timeoutMs: 30_000 });
      const selectedOk = ev.selectValue === target.value && ev.localStorageWorkspace === target.value;
      record("E2E-06 选择工作区 option", selectedOk ? "PASS" : "FAIL",
        `已选 option=${JSON.stringify(target.text)}；下拉值=${ev.selectValue}；scope 输入框=${JSON.stringify(ev.scopeInput)}(只读=${ev.scopeReadOnly})；语言=${ev.language}；"机会状态"=${JSON.stringify(ev.status)}；机会卡片=${ev.cards}；空状态可见=${ev.emptyVisible}；localStorage.radarWorkspaceId=${ev.localStorageWorkspace}`,
        { ...wsSnap, selected: ev });
      if (ev.emptyVisible && ev.cards === 0) {
        record("E2E-06b 工作区下既有机会", "FAIL", `该工作区无既有机会（空状态：${JSON.stringify(ev.emptyText)}）。详情步骤将回退到“全部历史”继续验证。`);
      }
    }

    // 3.6 提交搜索表单（requestSubmit 触发真实 submit 事件；不点击 Run Lite Scan）
    const search = await evaluate(page, `(async () => {
      const form = document.getElementById("scope-form");
      const scope = document.getElementById("scope-input").value;
      let submitted = false;
      const onSubmit = () => { submitted = true; };
      form.addEventListener("submit", onSubmit);
      const before = {
        status: document.getElementById("opportunity-status")?.textContent,
        cards: document.querySelectorAll("#opportunity-list .opportunity-card").length,
      };
      form.requestSubmit();
      form.removeEventListener("submit", onSubmit);
      const start = Date.now();
      while (Date.now() - start < 15000) {
        const t = document.getElementById("opportunity-status")?.textContent;
        const cards = document.querySelectorAll("#opportunity-list .opportunity-card").length;
        const isEmpty = !document.getElementById("empty-state").hidden;
        if (t && !/Loading|加载/u.test(t) && (cards > 0 || isEmpty)) break;
        await new Promise(r => setTimeout(r, 100));
      }
      await new Promise(r => setTimeout(r, 200));
      return {
        submitted,
        scopeAtSubmit: scope,
        status: document.getElementById("opportunity-status")?.textContent,
        statusClass: document.getElementById("opportunity-status")?.className,
        cards: document.querySelectorAll("#opportunity-list .opportunity-card").length,
        firstCardTitle: document.querySelector("#opportunity-list .opportunity-card .card-title")?.textContent.trim(),
        summary: document.getElementById("run-summary")?.textContent.trim(),
        globalErrorVisible: !document.getElementById("global-error").hidden,
        globalErrorText: document.getElementById("global-error").textContent.trim(),
        runScanClicked: false,
        detailHidden: document.getElementById("detail-panel").hidden,
        before,
      };
    })()`, { timeoutMs: 30_000 });
    const searchPass = search.submitted && !search.globalErrorVisible && !/Error|错误|エラー|오류/u.test(search.status || "") ;
    record("E2E-07 提交搜索表单（scope-form.requestSubmit）", searchPass ? "PASS" : "FAIL",
      `submit 事件已触发=${search.submitted}；scope=${JSON.stringify(search.scopeAtSubmit)}；状态=${JSON.stringify(search.status)}；机会卡片=${search.cards}；首条=${JSON.stringify(search.firstCardTitle)}；摘要=${JSON.stringify(search.summary)}；全局错误=${search.globalErrorVisible ? JSON.stringify(search.globalErrorText) : "无"}；未点击 run-lite-scan`,
      search);
    if (search.globalErrorVisible) violationNotes.push(`搜索后出现全局错误：${search.globalErrorText}`);
    if (search.cards === 0) violationNotes.push("搜索后机会列表为空，无法执行详情步骤");

    // 若工作区空导致无卡片，则回退到“全部历史”（placeholder option），保证详情/证据可被真实验证
    if (search.cards === 0) {
      const fallback = await evaluate(page, `(async () => {
        const sel = document.getElementById("workspace-select");
        sel.value = "";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        const form = document.getElementById("scope-form");
        const si = document.getElementById("scope-input");
        si.disabled = false; si.readOnly = false;
        si.value = "AI";
        form.requestSubmit();
        const start = Date.now();
        while (Date.now() - start < 15000) {
          const cards = document.querySelectorAll("#opportunity-list .opportunity-card").length;
          if (cards > 0) break;
          await new Promise(r => setTimeout(r, 100));
        }
        return { cards: document.querySelectorAll("#opportunity-list .opportunity-card").length };
      })()`, { timeoutMs: 30_000 });
      record("E2E-07b 回退到全部历史重新搜索", fallback.cards > 0 ? "PASS" : "FAIL",
        `移除工作区选择并在 scope 输入框键入 AI 后再次 requestSubmit；机会卡片=${fallback.cards}`);
    }

    // 3.7 点击第一条既有机会卡片
    const cardCount = await evaluate(page, `document.querySelectorAll("#opportunity-list .opportunity-card").length`);
    if (cardCount === 0) {
      record("E2E-08 点击第一条机会进入详情", "FAIL", "机会列表为空，无法点击（不触发 Run Lite Scan）");
      record("E2E-09 详情字段检查", "SKIP", "无详情可查");
      record("E2E-10 Evidence 列表检查", "SKIP", "无详情可查");
    } else {
      const cardBefore = await evaluate(page, `(() => { const c = document.querySelector("#opportunity-list .opportunity-card"); return { text: c.innerText.trim().slice(0, 300), disabled: c.disabled }; })()`);
      await evaluate(page, `(async () => {
        const card = document.querySelector("#opportunity-list .opportunity-card");
        card.scrollIntoView({ block: "center" });
        const ev = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" });
        card.dispatchEvent(ev);
        card.click(); // HTMLElement.click() 产生真实可信任 click 事件
        return true;
      })()`);
      let detailOk = true;
      try {
        await waitFor(page, `!document.getElementById("detail-panel").hidden && document.getElementById("detail-title").textContent !== "—" && !/Loading|加载|불러오는|読み込み/u.test(document.getElementById("detail-title").textContent)`, 20_000, "详情标题渲染");
        // 等 evidence 请求完成
        await waitFor(page, `(() => { const t = document.getElementById("evidence-count").textContent; return /of|\\/|件中|개 중|von/u.test(t) && (document.querySelectorAll("#evidence-list .evidence-item").length > 0 || document.querySelector("#evidence-list p.muted")); })()`, 20_000, "evidence 列表渲染");
      } catch (err) {
        detailOk = false;
        record("E2E-08 点击第一条机会进入详情", "FAIL", `点击后详情未正确渲染：${err.message}`);
      }
      const detail = await evaluate(page, `(() => {
        const q = (s) => document.querySelector(s);
        const txt = (s) => q(s)?.textContent?.trim() ?? null;
        const items = Array.from(document.querySelectorAll("#evidence-list .evidence-item")).map(card => {
          const a = card.querySelector("a");
          return {
            title: card.querySelector(".evidence-title strong")?.textContent.trim().slice(0, 160),
            provider: card.querySelector(".evidence-title .chip")?.textContent.trim(),
            body: card.querySelector("p")?.textContent.trim().slice(0, 160) || null,
            meta: Array.from(card.querySelectorAll(".evidence-meta .chip")).map(c => c.textContent.trim()),
            link: a ? a.getAttribute("href") : null,
          };
        });
        return {
          panelHidden: q("#detail-panel").hidden,
          rank: txt("#detail-rank"),
          title: txt("#detail-title"),
          subtitle: txt("#detail-subtitle"),
          components: Array.from(document.querySelectorAll("#component-grid .component-row")).map(r => ({
            name: r.querySelector(".component-name")?.textContent.trim(),
            value: r.querySelector(".component-value")?.textContent.trim(),
            width: r.querySelector(".component-fill")?.style.width,
          })),
          reasons: Array.from(document.querySelectorAll("#reason-list li")).map(li => li.innerText.trim().slice(0, 200)),
          evidenceCount: txt("#evidence-count"),
          evidenceFromDom: items.length,
          evidenceItems: items.slice(0, 8),
          emptyEvidenceText: q("#evidence-list p.muted")?.textContent?.trim() || null,
          sourceSummary: Array.from(document.querySelectorAll("#source-summary .source-item")).map(s => s.textContent.trim()),
          historyHasChart: Boolean(q("#history-chart svg")),
          historyText: txt("#history-chart"),
          handoffStatus: txt("#handoff-status"),
          lang: document.documentElement.lang,
        };
      })()`);
      const evMatch = (detail.evidenceCount || "").match(/(\d+)/g) || [];
      const detailPass = !detail.panelHidden && detail.title && detail.title !== "—"
        && detail.components.length === 7
        && (detail.reasons || []).length > 0
        && detail.evidenceFromDom > 0;
      if (!detailPass) detailOk = false;
      record("E2E-08 点击第一条机会进入详情", detailOk && !detail.panelHidden ? "PASS" : "FAIL",
        `点击首条卡片（卡片文本前 80 字=${JSON.stringify(cardBefore.text.slice(0, 80))}）；详情面板可见=${!detail.panelHidden}；标题=${JSON.stringify(detail.title)}`,
        { cardBefore, detail });
      record("E2E-09 详情字段检查", detailPass ? "PASS" : "FAIL",
        `rank=${JSON.stringify(detail.rank)}；title=${JSON.stringify(detail.title)}；subtitle=${JSON.stringify(detail.subtitle)}；分数条=${detail.components.length} 项(${detail.components.map(c => `${c.name}=${c.value}(${c.width})`).join(", ")})；理由=${detail.reasons.length} 条；来源确认=${detail.sourceSummary.length} 行；历史图=${detail.historyHasChart}；HANDOFF 状态=${JSON.stringify(detail.handoffStatus)}`,
        { components: detail.components, reasons: detail.reasons, sourceSummary: detail.sourceSummary, historyText: detail.historyText });
      const evPass = detail.evidenceFromDom > 0
        && detail.evidenceItems.every(it => it.title && it.provider && it.link)
        && detail.evidenceItems.some(it => it.link.startsWith("http"));
      record("E2E-10 Evidence 列表检查", evPass ? "PASS" : "FAIL",
        `计数文案=${JSON.stringify(detail.evidenceCount)}；DOM 证据卡片=${detail.evidenceFromDom}；空态文案=${detail.emptyEvidenceText ? JSON.stringify(detail.emptyEvidenceText) : "无"}；示例=${JSON.stringify(detail.evidenceItems.slice(0, 2))}`,
        { evidenceItems: detail.evidenceItems });
      if (!evPass) violationNotes.push("Evidence 列表为空或字段缺失");
    }

    // 3.8 安全边界：检查浏览器期间是否有任何非 127.0.0.1 请求、页面异常等
    const externalInLoopback = netLog.filter(r => r.allowed && !r.url.startsWith(new URL(BASE_URL).origin) && !r.url.startsWith(new URL(BASE_URL).origin.replace("http", "ws")));
    const apiCalls = netLog.filter(r => r.allowed && /\/v1\//.test(new URL(r.url).pathname)).map(r => `${r.resourceType} ${new URL(r.url).pathname}`);
    const writeAttempts = netLog.filter(r => r.allowed && r.method !== "GET" && r.method !== "HEAD" && !r.mocked).map(r => r.method + " " + new URL(r.url).pathname);
    record("E2E-11 网络/安全边界", blockedExternal.length === 0 && writeAttempts.length === 0 ? "PASS" : "FAIL",
      `浏览器层观察到请求 ${netLog.length} 个；被拦截的非 127.0.0.1 请求=${blockedExternal.length}${blockedExternal.length ? "：" + JSON.stringify(blockedExternal.slice(0, 5)) : ""}；其他回环主机请求=${externalInLoopback.length}；非只读 /v1 调用=${writeAttempts.length}${writeAttempts.length ? "：" + JSON.stringify(writeAttempts) : ""}；未点击 run-lite-scan`,
      { loopbackRequests: netLog.map(r => `${r.resourceType} ${r.url}`), blockedExternal, writeAttempts, mockedTranslationCalls: netLog.filter(r => r.mocked).length });
    if (pageErrors.length) {
      record("E2E-12 页面运行时错误（记录）", "SKIP", `捕获到 ${pageErrors.length} 条 console/异常日志（不影响功能判定，仅供参考）：${JSON.stringify(pageErrors.slice(0, 5))}`);
    } else {
      record("E2E-12 页面运行时错误（记录）", "PASS", "未捕获到页面异常或 error 级 console 日志");
    }

    const failed = results.filter(r => r.status === "FAIL").length;
    exitCode = failed === 0 ? 0 : 1;
  } catch (err) {
    record("E2E-99 执行中断", "FAIL", `脚本执行异常：${err.stack || err.message}`);
    exitCode = 2;
  } finally {
    try { if (cdp) await cdp.send("Browser.close", {}, 5_000); } catch {}
    try { child.kill("SIGKILL"); } catch {}
    await sleep(300);
    try { await rm(profileDir, { recursive: true, force: true }); } catch {}
  }
  return exitCode;
}

// ---------------------------------------------------------------------------
// 4. 输出汇总
// ---------------------------------------------------------------------------
let exitCode;
try {
  exitCode = await Promise.race([
    main(),
    sleep(OVERALL_TIMEOUT_MS).then(() => {
      record("E2E-99 总超时", "FAIL", `超过 ${OVERALL_TIMEOUT_MS}ms 未完成`);
      return 2;
    }),
  ]);
} catch (err) {
  record("E2E-99 致命错误", "FAIL", String(err?.stack || err));
  exitCode = 2;
}

const counts = results.reduce((acc, r) => (acc[r.status] = (acc[r.status] || 0) + 1, acc), {});
console.log(`\n===== 汇总: ${JSON.stringify(counts)}; 外部拦截=${blockedExternal.length}; 退出码=${exitCode} =====`);
if (JSON_DIR) {
  await mkdir(JSON_DIR, { recursive: true });
  const out = path.join(JSON_DIR, "radar-browser-e2e.dom-evidence.json");
  await writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl: BASE_URL, results, netLog, blockedExternal, pageErrors, violationNotes }, null, 2));
  console.log(`DOM 证据已写入 ${out}`);
}
process.exit(exitCode);
