import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { AgentWorker, BridgeClient } from "../../node-worker/src/index.js";
import {
  DEFAULT_PREFLIGHT_TIMEOUT_MS,
  READINESS_PROMPT,
  requireBootstrapToken,
  requireProviderCredential,
  runModelPreflight,
  startQwenWorker,
} from "./readiness.js";

const QWEN_TASK_TIMEOUT_MS = Number(process.env.QWEN_TASK_TIMEOUT_MS || 1_800_000);
const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen3-coder-plus";

export function resolveQwenBin() {
  return (process.env.QWEN_BIN || "qwen").trim();
}

export async function readSecretFile(path) {
  const file = String(path || "").trim();
  if (!file) return "";
  try { return (await readFile(file, "utf8")).trim(); } catch { return ""; }
}

export async function resolveQwenApiKey() {
  for (const name of ["QWEN_API_KEY", "DASHSCOPE_API_KEY", "BAILIAN_CODING_PLAN_API_KEY", "BAILIAN_TOKEN_PLAN_API_KEY"]) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return readSecretFile(process.env.QWEN_API_KEY_FILE);
}

export async function resolveBootstrapToken() {
  const explicit = (process.env.AI_TEAM_BOOTSTRAP_TOKEN || "").trim();
  if (explicit) return explicit;
  return readSecretFile(process.env.AI_TEAM_BOOTSTRAP_TOKEN_FILE);
}

export function resolveQwenBaseUrl() {
  return (process.env.QWEN_BASE_URL || process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL).trim();
}

export function resolveQwenModel() {
  return (process.env.QWEN_MODEL || process.env.OPENAI_MODEL || DEFAULT_MODEL).trim();
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

export function buildQwenArgs({ prompt, outputFormat = "stream-json", maxToolCalls } = {}) {
  const args = [
    "--bare",
    "--approval-mode", process.env.QWEN_APPROVAL_MODE || "auto",
    "--output-format", outputFormat,
    "--auth-type", "openai",
    "--openai-base-url", resolveQwenBaseUrl(),
    "--model", resolveQwenModel(),
    "--max-wall-time", process.env.QWEN_MAX_WALL_TIME || "30m",
  ];
  if (maxToolCalls !== undefined) args.push("--max-tool-calls", String(maxToolCalls));
  args.push(prompt);
  return args;
}

export async function runQwenPrompt({ task, prompt, signal, outputFormat = "stream-json", onEvent = async () => {}, qwenBin = resolveQwenBin(), timeoutMs = QWEN_TASK_TIMEOUT_MS, maxToolCalls } = {}) {
  const apiKey = requireProviderCredential(await resolveQwenApiKey());
  const child = spawn(qwenBin, buildQwenArgs({ prompt, outputFormat, maxToolCalls }), {
    cwd: task.workspace,
    env: {
      ...process.env,
      OPENAI_API_KEY: apiKey,
      OPENAI_BASE_URL: resolveQwenBaseUrl(),
      OPENAI_MODEL: resolveQwenModel(),
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  let timedOut = false;
  const events = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const abort = () => child.kill("SIGTERM");
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, Math.max(1, Number(timeoutMs) || QWEN_TASK_TIMEOUT_MS));
  const output = (async () => {
    child.stdout.setEncoding("utf8");
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      stdout += line + "\n";
      const trimmed = line.trim();
      if (!trimmed || outputFormat === "text") continue;
      try {
        const event = JSON.parse(trimmed);
        events.push(event);
        await onEvent(event);
      } catch {}
    }
  })();
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    await output;
    if (signal?.aborted) {
      const error = new Error("Qwen task cancelled");
      error.name = "AbortError";
      throw error;
    }
    if (timedOut) {
      const error = new Error(`Qwen timed out after ${timeoutMs}ms`);
      error.code = "timeout";
      throw error;
    }
    if (code !== 0) throw new Error(`Qwen exited with code ${code}: ${(stderr || stdout).trim().slice(-2_000)}`);
    return { stdout, stderr, events };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export function qwenProgressFromEvent(event) {
  if (event?.type === "system" && event?.subtype === "session_start") {
    const model = event?.model || resolveQwenModel();
    return { stage: "model_session", message: `Qwen session initialized (${model})`, current: 2, total: 4 };
  }
  if (event?.type === "assistant") {
    const content = Array.isArray(event?.message?.content) ? event.message.content : [];
    const tool = content.find((item) => item?.type === "tool_use");
    if (tool) return { stage: "tool_use", message: `Qwen is using ${String(tool.name || "tool")}` };
  }
  return null;
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

export function createTaskHandler({ runPrompt = runQwenPrompt } = {}) {
  return async function handleTask(ctx) {
    const task = ctx.task;
    const pending = [];
    let sessionReported = false;
    const unsubscribe = ctx.onMessage((message) => pending.push(message));
    const onEvent = async (event) => {
      const progress = qwenProgressFromEvent(event);
      if (!progress) return;
      if (progress.stage === "model_session") {
        if (sessionReported) return;
        sessionReported = true;
      }
      await maybeProgress(ctx, progress);
    };
    try {
      await maybeProgress(ctx, { stage: "preparing", message: "Preparing Qwen Code headless session", current: 1, total: 4 });
      await runPrompt({ task, prompt: promptFor(task, ctx.getMessages()), signal: ctx.signal, outputFormat: "stream-json", onEvent });
      if (!sessionReported) await maybeProgress(ctx, { stage: "model_session", message: "Qwen session completed model work", current: 2, total: 4 });
      await ctx.refreshMessages();
      while (pending.length > 0) {
        const followUps = pending.splice(0, pending.length);
        await runPrompt({ task, prompt: promptFor(task, followUps), signal: ctx.signal, outputFormat: "stream-json", onEvent });
        await ctx.refreshMessages();
      }
      await maybeProgress(ctx, { stage: "finalizing", message: "Qwen produced a final result", current: 3, total: 4 });
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
    agentId: "qwen",
    label: "Qwen Code",
    capabilities: ["implementation", "research", "long_context"],
    ...options,
    onTask: options.onTask ?? handleTask,
  });
}

export async function preflightModel({ timeoutMs = DEFAULT_PREFLIGHT_TIMEOUT_MS, runPrompt = runQwenPrompt } = {}) {
  requireProviderCredential(await resolveQwenApiKey());
  return runModelPreflight({
    timeoutMs,
    runPrompt: async ({ signal }) => {
      const result = await runPrompt({
        task: { task_id: "qwen-model-preflight", title: "Qwen model preflight", workspace: process.cwd(), prompt: READINESS_PROMPT },
        prompt: READINESS_PROMPT,
        signal,
        outputFormat: "text",
        maxToolCalls: 0,
      });
      return { response: String(result.stdout || "").trim() };
    },
  });
}

export async function startQwenFromEnvironment({ client, bootstrapToken, preflight = () => preflightModel(), workerFactory = () => createWorker(), ...rest } = {}) {
  const token = requireBootstrapToken(bootstrapToken === undefined ? await resolveBootstrapToken() : bootstrapToken);
  if (client) client.bootstrapToken = token;
  return startQwenWorker({ client, bootstrapToken: token, preflight, workerFactory, ...rest });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const client = new BridgeClient({ baseUrl: process.env.AI_TEAM_BRIDGE_URL ?? "http://127.0.0.1:8765" });
  try {
    const result = await startQwenFromEnvironment({ client });
    if (!result.started) process.exit(1);
  } catch (error) {
    console.error(`Qwen startup failed (${error.code || "error"}): ${error.message}`);
    process.exit(1);
  }
}
