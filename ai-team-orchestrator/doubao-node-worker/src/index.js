import { spawn } from "node:child_process";
import { access, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { AgentWorker, BridgeClient } from "../../node-worker/src/index.js";
import {
  DEFAULT_PREFLIGHT_TIMEOUT_MS,
  READINESS_PROMPT,
  READINESS_TOKEN,
  requireBootstrapToken,
  requireProviderCredential,
  startDoubaoWorker,
} from "./readiness.js";

const DOUBAO_TASK_TIMEOUT_MS = Number(process.env.DOUBAO_TASK_TIMEOUT_MS || 1_800_000);
const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_MODEL = "doubao-seed-2-1-pro-260628";
const DEFAULT_MAX_STEPS = "60";
const TRAE_CONFIG_FILE = fileURLToPath(new URL("../trae_config.yaml", import.meta.url));
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function resolveTraeBin() {
  return (process.env.TRAE_BIN || "trae-cli").trim();
}

export async function readSecretFile(path) {
  const file = String(path || "").trim();
  if (!file) return "";
  try { return (await readFile(file, "utf8")).trim(); } catch { return ""; }
}

export async function resolveDoubaoApiKey() {
  for (const name of ["DOUBAO_API_KEY", "ARK_API_KEY"]) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return readSecretFile(process.env.DOUBAO_API_KEY_FILE);
}

export async function resolveBootstrapToken() {
  const explicit = (process.env.AI_TEAM_BOOTSTRAP_TOKEN || "").trim();
  if (explicit) return explicit;
  return readSecretFile(process.env.AI_TEAM_BOOTSTRAP_TOKEN_FILE);
}

export function resolveDoubaoBaseUrl() {
  return (process.env.DOUBAO_BASE_URL || process.env.ARK_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
}

export function resolveDoubaoModel() {
  return (process.env.DOUBAO_MODEL || DEFAULT_MODEL).trim();
}

function messageText(message) {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return "";
  return String(message.content ?? message.text ?? "").trim();
}

export function promptFor(task, messages = []) {
  const followUps = messages.map(messageText).filter(Boolean)
    .map((text, index) => `Follow-up ${index + 1}:\n${text}`).join("\n\n");
  return [
    `You are executing AI Team task ${task.task_id} in the requested workspace.`,
    `Title: ${task.title}`,
    "",
    task.prompt,
    followUps ? `\nAdditional follow-up messages:\n${followUps}` : "",
    "",
    "Work only inside the requested workspace. Create every requested deliverable.",
    "Do not invent successful tool calls or files.",
  ].filter(Boolean).join("\n");
}

export function promptArtifacts(prompt) {
  const pattern = /(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:txt|md|markdown|json|jsonl|csv|tsv|log|ya?ml|html?|xml|pdf|png|jpe?g|svg)/g;
  const found = [];
  for (const match of String(prompt || "").matchAll(pattern)) {
    const candidate = match[0].replace(/^\.\//, "");
    if (!found.includes(candidate)) found.push(candidate);
  }
  return found;
}

export function requiredArtifacts(task) {
  const required = [];
  for (const item of task.metadata?.expected_artifacts || []) {
    const value = String(item || "").trim();
    if (value && !required.includes(value)) required.push(value);
  }
  return required;
}

export function expectedArtifacts(task) {
  const candidates = [...requiredArtifacts(task)];
  for (const candidate of promptArtifacts(task.prompt)) {
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}

export async function preflightModel({ fetchImpl = fetch, timeoutMs = DEFAULT_PREFLIGHT_TIMEOUT_MS } = {}) {
  const apiKey = requireProviderCredential(await resolveDoubaoApiKey());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${resolveDoubaoBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: resolveDoubaoModel(),
        messages: [{ role: "user", content: READINESS_PROMPT }],
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const error = new Error(`Doubao readiness HTTP ${response.status}: ${text.slice(0, 500)}`);
      error.code = "provider_http_error";
      throw error;
    }
    const payload = await response.json();
    const content = String(payload?.choices?.[0]?.message?.content || "").trim();
    if (content !== READINESS_TOKEN) {
      const error = new Error(`Doubao readiness failed: expected ${READINESS_TOKEN}, got ${JSON.stringify(content.slice(0, 200))}`);
      error.code = "readiness_token_mismatch";
      throw error;
    }
    return { token: READINESS_TOKEN };
  } finally {
    clearTimeout(timer);
  }
}

export function buildTraeArgs({ promptFile, workspace } = {}) {
  return [
    "run",
    "--file", promptFile,
    "--provider", "doubao",
    "--model", resolveDoubaoModel(),
    "--model-base-url", resolveDoubaoBaseUrl(),
    "--max-steps", process.env.DOUBAO_MAX_STEPS || DEFAULT_MAX_STEPS,
    "--working-dir", workspace,
    "--config-file", process.env.DOUBAO_TRAE_CONFIG || TRAE_CONFIG_FILE,
    "--console-type", "simple",
  ];
}

function retainTail(text, chunk, limit = 100_000) {
  const value = text + chunk;
  return value.length > limit ? value.slice(-limit) : value;
}

function toolNameFromLine(line) {
  const clean = String(line || "").replace(ANSI_RE, "");
  for (const name of ["str_replace_based_edit_tool", "sequentialthinking", "task_done", "bash"]) {
    if (clean.includes(name)) return name;
  }
  return "";
}

export async function runDoubaoTask({ task, prompt, signal, onTool = async () => {}, traeBin = resolveTraeBin(), timeoutMs = DOUBAO_TASK_TIMEOUT_MS } = {}) {
  const apiKey = requireProviderCredential(await resolveDoubaoApiKey());
  const safeId = String(task.task_id || "task").replace(/[^A-Za-z0-9_.-]/g, "_");
  const promptFile = join(tmpdir(), `ai-team-doubao-${safeId}.txt`);
  await writeFile(promptFile, prompt, "utf8");
  const child = spawn(traeBin, buildTraeArgs({ promptFile, workspace: task.workspace }), {
    cwd: task.workspace,
    env: {
      ...process.env,
      DOUBAO_API_KEY: apiKey,
      DOUBAO_BASE_URL: resolveDoubaoBaseUrl(),
      NO_COLOR: "1",
      TERM: "dumb",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const seenTools = new Set();
  const abort = () => child.kill("SIGTERM");
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, Math.max(1, Number(timeoutMs) || DOUBAO_TASK_TIMEOUT_MS));
  const consume = async (stream, target) => {
    stream.setEncoding("utf8");
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (target === "stdout") stdout = retainTail(stdout, line + "\n");
      else stderr = retainTail(stderr, line + "\n");
      const tool = toolNameFromLine(line);
      if (tool && !seenTools.has(tool)) {
        seenTools.add(tool);
        await onTool(tool);
      }
    }
  };
  const readers = Promise.all([consume(child.stdout, "stdout"), consume(child.stderr, "stderr")]);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    await readers;
    if (signal?.aborted) {
      const error = new Error("Doubao task cancelled");
      error.name = "AbortError";
      throw error;
    }
    if (timedOut) {
      const error = new Error(`Doubao timed out after ${timeoutMs}ms`);
      error.code = "timeout";
      throw error;
    }
    if (code !== 0) throw new Error(`Trae/Doubao exited with code ${code}: ${(stderr || stdout).trim().slice(-2_000)}`);
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    await unlink(promptFile).catch(() => {});
  }
}

async function maybeProgress(ctx, progress) {
  if (typeof ctx.reportProgress === "function") await ctx.reportProgress(progress);
}

export async function collectArtifacts(task) {
  for (const relativePath of requiredArtifacts(task)) {
    try { await access(`${task.workspace}/${relativePath}`); }
    catch { throw new Error(`Expected artifact was not created: ${relativePath}`); }
  }
  const artifacts = [];
  for (const relativePath of expectedArtifacts(task)) {
    try { await access(`${task.workspace}/${relativePath}`); } catch { continue; }
    artifacts.push({ path: relativePath, kind: "file", label: relativePath });
  }
  return artifacts;
}

export function createTaskHandler({ runTask = runDoubaoTask } = {}) {
  return async function handleTask(ctx) {
    const task = ctx.task;
    const pending = [];
    const unsubscribe = ctx.onMessage((message) => pending.push(message));
    const onTool = async (tool) => maybeProgress(ctx, { stage: "tool_use", message: `Doubao/Trae is using ${tool}` });
    try {
      await maybeProgress(ctx, { stage: "preparing", message: "Preparing Doubao via Trae Agent", current: 1, total: 4 });
      await maybeProgress(ctx, { stage: "model_session", message: `Doubao session initialized (${resolveDoubaoModel()})`, current: 2, total: 4 });
      await runTask({ task, prompt: promptFor(task, ctx.getMessages()), signal: ctx.signal, onTool });
      await ctx.refreshMessages();
      while (pending.length > 0) {
        const followUps = pending.splice(0, pending.length);
        await runTask({ task, prompt: promptFor(task, followUps), signal: ctx.signal, onTool });
        await ctx.refreshMessages();
      }
      await maybeProgress(ctx, { stage: "finalizing", message: "Doubao produced a final result", current: 3, total: 4 });
      const artifacts = await collectArtifacts(task);
      await maybeProgress(ctx, { stage: "artifacts", message: `Validated ${artifacts.length} artifact(s)`, current: 4, total: 4 });
      return { artifacts };
    } finally { unsubscribe(); }
  };
}

export const handleTask = createTaskHandler();

export function createWorker(options = {}) {
  return new AgentWorker({
    bridgeUrl: process.env.AI_TEAM_BRIDGE_URL ?? "http://127.0.0.1:8765",
    agentId: "doubao",
    label: "Doubao via Trae Agent",
    capabilities: ["research", "chinese_content", "multimodal"],
    ...options,
    onTask: options.onTask ?? handleTask,
  });
}

export async function startDoubaoFromEnvironment({ client, bootstrapToken, preflight = () => preflightModel(), workerFactory = () => createWorker(), ...rest } = {}) {
  const token = requireBootstrapToken(bootstrapToken === undefined ? await resolveBootstrapToken() : bootstrapToken);
  if (client) client.bootstrapToken = token;
  return startDoubaoWorker({ client, bootstrapToken: token, preflight, workerFactory, ...rest });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const client = new BridgeClient({ baseUrl: process.env.AI_TEAM_BRIDGE_URL ?? "http://127.0.0.1:8765" });
  try {
    const result = await startDoubaoFromEnvironment({ client });
    if (!result.started) process.exit(1);
  } catch (error) {
    console.error(`Doubao startup failed (${error.code || "error"}): ${error.message}`);
    process.exit(1);
  }
}
