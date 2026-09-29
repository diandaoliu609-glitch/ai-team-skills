import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildQwenArgs,
  collectArtifacts,
  createTaskHandler,
  preflightModel,
  qwenProgressFromEvent,
  runQwenPrompt,
} from "../src/index.js";
import {
  BOOTSTRAP_TOKEN_REQUIRED,
  CREDENTIAL_UNAVAILABLE,
  READINESS_TOKEN,
  requireBootstrapToken,
  requireProviderCredential,
  startQwenWorker,
} from "../src/readiness.js";

async function tempWorkspace() {
  return mkdtemp(join(tmpdir(), "qwen-worker-"));
}

test("Qwen args use bounded headless mode without embedding API key", () => {
  const args = buildQwenArgs({ prompt: "hello", outputFormat: "stream-json" });
  assert.ok(args.includes("--bare"));
  assert.ok(args.includes("--approval-mode"));
  assert.ok(args.includes("auto"));
  assert.ok(args.includes("--output-format"));
  assert.ok(args.includes("stream-json"));
  assert.ok(args.includes("--auth-type"));
  assert.ok(args.includes("openai"));
  assert.equal(args.some((v) => v.includes("sk-")), false);
});

test("fake Qwen executable emits stream-json and receives secret only in env", async () => {
  const root = await tempWorkspace();
  const fake = join(root, "fake-qwen");
  const previous = process.env.QWEN_API_KEY;
  process.env.QWEN_API_KEY = "unit-test-secret";
  try {
    await writeFile(fake, `#!/usr/bin/env node
const args=process.argv.slice(2);
if (process.env.OPENAI_API_KEY !== "unit-test-secret") process.exit(41);
console.log(JSON.stringify({type:"system",subtype:"session_start",model:"fake-qwen",args}));
console.log(JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",name:"write_file"}]}}));
console.log(JSON.stringify({type:"result",subtype:"success",result:"done"}));
`, "utf8");
    await chmod(fake, 0o755);
    const seen = [];
    const result = await runQwenPrompt({
      task: { task_id: "fake", title: "fake", workspace: root, prompt: "do" },
      prompt: "hello",
      qwenBin: fake,
      onEvent: async (event) => seen.push(event),
      timeoutMs: 5_000,
    });
    assert.equal(seen.length, 3);
    assert.match(result.stdout, /session_start/);
    assert.equal(seen[0].args.includes("unit-test-secret"), false);
  } finally {
    if (previous === undefined) delete process.env.QWEN_API_KEY;
    else process.env.QWEN_API_KEY = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("Qwen stream events map to model and tool progress", () => {
  assert.deepEqual(
    qwenProgressFromEvent({ type: "system", subtype: "session_start", model: "qwen-test" }),
    { stage: "model_session", message: "Qwen session initialized (qwen-test)", current: 2, total: 4 },
  );
  assert.deepEqual(
    qwenProgressFromEvent({ type: "assistant", message: { content: [{ type: "tool_use", name: "write_file" }] } }),
    { stage: "tool_use", message: "Qwen is using write_file" },
  );
});

test("preflight requires exact Qwen token", async () => {
  const previous = process.env.QWEN_API_KEY;
  process.env.QWEN_API_KEY = "fake";
  try {
    const ok = await preflightModel({ runPrompt: async () => ({ stdout: READINESS_TOKEN + "\n" }) });
    assert.equal(ok.token, READINESS_TOKEN);
    await assert.rejects(
      () => preflightModel({ runPrompt: async () => ({ stdout: "almost " + READINESS_TOKEN }) }),
      (error) => error.code === "readiness_token_mismatch",
    );
  } finally {
    if (previous === undefined) delete process.env.QWEN_API_KEY;
    else process.env.QWEN_API_KEY = previous;
  }
});

test("missing provider credential is explicit", () => {
  assert.throws(() => requireProviderCredential(""), (error) => error.code === CREDENTIAL_UNAVAILABLE);
});

test("missing bootstrap token fails before registration", async () => {
  assert.throws(() => requireBootstrapToken(""), (error) => error.code === BOOTSTRAP_TOKEN_REQUIRED);
  let calls = 0;
  await assert.rejects(
    () => startQwenWorker({
      client: { reportReadiness: async () => {} },
      bootstrapToken: "",
      preflight: async () => {},
      workerFactory: () => { calls += 1; return { start: async () => {} }; },
    }),
    (error) => error.code === BOOTSTRAP_TOKEN_REQUIRED,
  );
  assert.equal(calls, 0);
});

test("task handler reports progress and validates a real artifact", async () => {
  const root = await tempWorkspace();
  try {
    const progress = [];
    const handler = createTaskHandler({
      runPrompt: async ({ onEvent }) => {
        await writeFile(join(root, "qwen-proof.txt"), "QWEN_WORKER_ONLINE\n", "utf8");
        await onEvent({ type: "system", subtype: "session_start", model: "fake" });
        await onEvent({ type: "assistant", message: { content: [{ type: "tool_use", name: "write_file" }] } });
        return { stdout: "", stderr: "", events: [] };
      },
    });
    const result = await handler({
      task: { task_id: "q", title: "q", workspace: root, prompt: "Create qwen-proof.txt", metadata: { expected_artifacts: ["qwen-proof.txt"] } },
      signal: new AbortController().signal,
      getMessages: () => [],
      refreshMessages: async () => [],
      onMessage: () => () => {},
      reportProgress: async (event) => progress.push(event),
    });
    assert.equal(result.artifacts[0].path, "qwen-proof.txt");
    assert.deepEqual(progress.filter((e) => e.current).map((e) => e.current), [1, 2, 3, 4]);
    assert.ok(progress.some((e) => e.stage === "tool_use"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing required Qwen artifact fails", async () => {
  const root = await tempWorkspace();
  try {
    await assert.rejects(
      () => collectArtifacts({ workspace: root, prompt: "", metadata: { expected_artifacts: ["missing.txt"] } }),
      /Expected artifact was not created/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
