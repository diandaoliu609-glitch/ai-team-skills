import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { AgentWorker, BridgeClient } from "../../node-worker/src/index.js";
import {
  DEFAULT_PREFLIGHT_TIMEOUT_MS,
  READINESS_PROMPT,
  requireBootstrapToken,
  runModelPreflight,
  startGrokWorker,
} from "./readiness.js";

const GROK_TASK_TIMEOUT_MS = Number(process.env.GROK_TASK_TIMEOUT_MS || 1_800_000);

export function resolveGrokBin() {
  return (process.env.GROK_BIN || "grok").trim();
}

export async function resolveBootstrapToken() {
  const explicit = (process.env.AI_TEAM_BOOTSTRAP_TOKEN || "").trim();
  if (explicit) return explicit;
  const tokenFile = (process.env.AI_TEAM_BOOTSTRAP_TOKEN_FILE || "").trim();
  if (!tokenFile) return "";
  try { return (await readFile(tokenFile, "utf8")).trim(); } catch { return ""; }
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
    "For research, prefer current primary sources and include source URLs in deliverables.",
    "Do not invent successful tool calls, observations, citations, or files.",
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
  if (Array.isArray(task.metadata?.expected_artifacts)) {
    for (const item of task.metadata.expected_artifacts) {
      const value = String(item || "").trim();
      if (value && !required.includes(value)) required.push(value);
    }
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

export function buildGrokArgs({ prompt, workspace, outputFormat = "streaming-json" }) {
  const args = [
    "--no-auto-update", "--no-alt-screen", "--no-plan", "--no-subagents",
    "--cwd", workspace, "-p", prompt, "--output-format", outputFormat,
  ];
  const model = (process.env.GROK_MODEL || "").trim();
  if (model) args.push("--model", model);
  const effort = (process.env.GROK_REASONING_EFFORT || "").trim();
  if (effort) args.push("--reasoning-effort", effort);
  const permissionMode = (process.env.GROK_PERMISSION_MODE || "auto").trim();
  if (permissionMode) args.push("--permission-mode", permissionMode);
  if (process.env.GROK_ALWAYS_APPROVE === "1") args.push("--always-approve");
  return args;
}

export async function runGrokPrompt({ task, prompt, signal, outputFormat = "streaming-json", onEvent = async () => {}, grokBin = resolveGrokBin(), timeoutMs = GROK_TASK_TIMEOUT_MS } = {}) {
  const child = spawn(grokBin, buildGrokArgs({ prompt, workspace: task.workspace, outputFormat }), {
    cwd: task.workspace,
    env: { ...process.env },
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
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, Math.max(1, Number(timeoutMs) || GROK_TASK_TIMEOUT_MS));
  const output = (async () => {
    child.stdout.setEncoding("utf8");
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      stdout += line + "\n";
      const trimmed = line.trim();
      if (!trimmed || outputFormat === "plain") continue;
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
      const error = new Error("Grok task cancelled");
      error.name = "AbortError";
      throw error;
    }
    if (timedOut) {
      const error = new Error(`Grok timed out after ${timeoutMs}ms`);
      error.code = "timeout";
      throw error;
    }
    if (code !== 0) throw new Error(`Grok exited with code ${code}: ${(stderr || stdout).trim().slice(-2_000)}`);
    return { stdout, stderr, events };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function updateFromEvent(event) {
  return event?.params?.update ?? event?.update ?? event;
}

export function grokProgressFromEvent(event) {
  const update = updateFromEvent(event);
  const kind = String(update?.sessionUpdate ?? event?.type ?? update?.type ?? "").toLowerCase();
  const serialized = JSON.stringify(update || event || {}).toLowerCase();
  const toolish = kind.includes("tool") || serialized.includes("tool_call") || serialized.includes("toolcall");
  if (toolish) {
    const name = update?.toolName ?? update?.tool_name ?? update?.name ?? update?.title ?? update?.toolCall?.name ?? update?.tool_call?.name ?? "tool";
    return { stage: "tool_use", message: `Grok is using ${String(name)}` };
  }
  if (kind.includes("session") || kind.includes("agent_message") || event?.method === "session/update") {
    return { stage: "model_session", message: "Grok session is active", current: 2, total: 4 };
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

export function createTaskHandler({ runPrompt = runGrokPrompt } = {}) {
  return async function handleTask(ctx) {
    const task = ctx.task;
    const pending = [];
    let sessionReported = false;
    const unsubscribe = ctx.onMessage((message) => pending.push(message));
    const onEvent = async (event) => {
      const progress = grokProgressFromEvent(event);
      if (!progress) return;
      if (progress.stage === "model_session") {
        if (sessionReported) return;
        sessionReported = true;
      }
      await maybeProgress(ctx, progress);
    };
    try {
      await maybeProgress(ctx, { stage: "preparing", message: "Preparing Grok headless session", current: 1, total: 4 });
      await runPrompt({ task, prompt: promptFor(task, ctx.getMessages()), signal: ctx.signal, outputFormat: "streaming-json", onEvent });
      if (!sessionReported) {
        sessionReported = true;
        await maybeProgress(ctx, { stage: "model_session", message: "Grok session completed model work", current: 2, total: 4 });
      }
      await ctx.refreshMessages();
      while (pending.length > 0) {
        const followUps = pending.splice(0, pending.length);
        await runPrompt({ task, prompt: promptFor(task, followUps), signal: ctx.signal, outputFormat: "streaming-json", onEvent });
        await ctx.refreshMessages();
      }
      await maybeProgress(ctx, { stage: "finalizing", message: "Grok produced a final result", current: 3, total: 4 });
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
    agentId: "grok",
    label: "Grok Build CLI",
    capabilities: ["research", "trend_analysis", "adversarial_review"],
    ...options,
    onTask: options.onTask ?? handleTask,
  });
}

export async function preflightModel({ timeoutMs = DEFAULT_PREFLIGHT_TIMEOUT_MS, runPrompt = runGrokPrompt } = {}) {
  return runModelPreflight({
    timeoutMs,
    runPrompt: async ({ signal }) => {
      const result = await runPrompt({
        task: { task_id: "grok-model-preflight", title: "Grok model preflight", workspace: process.cwd(), prompt: READINESS_PROMPT },
        prompt: READINESS_PROMPT,
        signal,
        outputFormat: "plain",
      });
      return { stdout: result.stdout, response: String(result.stdout || "").trim() };
    },
  });
}

export async function startGrokFromEnvironment({ client, bootstrapToken, preflight = () => preflightModel(), workerFactory = () => createWorker(), ...rest } = {}) {
  const token = requireBootstrapToken(bootstrapToken === undefined ? await resolveBootstrapToken() : bootstrapToken);
  if (client) client.bootstrapToken = token;
  return startGrokWorker({ client, bootstrapToken: token, preflight, workerFactory, ...rest });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const client = new BridgeClient({ baseUrl: process.env.AI_TEAM_BRIDGE_URL ?? "http://127.0.0.1:8765" });
  try {
    const result = await startGrokFromEnvironment({ client });
    if (!result.started) process.exit(1);
  } catch (error) {
    console.error(`Grok startup failed (${error.code || "error"}): ${error.message}`);
    process.exit(1);
  }
}
