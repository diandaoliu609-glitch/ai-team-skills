import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildGrokArgs,
  collectArtifacts,
  createTaskHandler,
  grokProgressFromEvent,
  preflightModel,
  promptArtifacts,
  requiredArtifacts,
  runGrokPrompt,
} from "../src/index.js";
import {
  BOOTSTRAP_TOKEN_REQUIRED,
  READINESS_TOKEN,
  requireBootstrapToken,
  startGrokWorker,
} from "../src/readiness.js";

async function tempWorkspace() {
  return mkdtemp(join(tmpdir(), "grok-worker-"));
}

test("artifact discovery uses explicit metadata and prompt paths", () => {
  assert.deepEqual(promptArtifacts("write report/a.md and proof.json"), ["report/a.md", "proof.json"]);
  assert.deepEqual(requiredArtifacts({ metadata: { expected_artifacts: ["proof.txt"] } }), ["proof.txt"]);
});

test("Grok args are bounded headless automation args", () => {
  const previous = process.env.GROK_ALWAYS_APPROVE;
  process.env.GROK_ALWAYS_APPROVE = "1";
  try {
    const args = buildGrokArgs({ prompt: "hello", workspace: "/tmp/work", outputFormat: "streaming-json" });
    assert.ok(args.includes("--no-auto-update"));
    assert.ok(args.includes("--no-alt-screen"));
    assert.ok(args.includes("--no-plan"));
    assert.ok(args.includes("--no-subagents"));
    assert.ok(args.includes("--cwd"));
    assert.ok(args.includes("/tmp/work"));
    assert.ok(args.includes("-p"));
    assert.ok(args.includes("hello"));
    assert.ok(args.includes("--output-format"));
    assert.ok(args.includes("streaming-json"));
    assert.ok(args.includes("--always-approve"));
  } finally {
    if (previous === undefined) delete process.env.GROK_ALWAYS_APPROVE;
    else process.env.GROK_ALWAYS_APPROVE = previous;
  }
});

test("fake Grok CLI streams ACP-like events", async () => {
  const root = await tempWorkspace();
  const fake = join(root, "fake-grok");
  try {
    await writeFile(fake, `#!/usr/bin/env node
const args = process.argv.slice(2);
console.log(JSON.stringify({method:"session/update",params:{update:{sessionUpdate:"agent_message_chunk",content:{text:"working"},args}}}));
console.log(JSON.stringify({method:"session/update",params:{update:{sessionUpdate:"tool_call",title:"write_file"}}}));
`, "utf8");
    await chmod(fake, 0o755);
    const seen = [];
    const result = await runGrokPrompt({
      task: { task_id: "task_fake", title: "Fake", workspace: root, prompt: "do it" },
      prompt: "hello",
      grokBin: fake,
      onEvent: async (event) => seen.push(event),
      timeoutMs: 5_000,
    });
    assert.equal(seen.length, 2);
    assert.match(result.stdout, /session\/update/);
    const args = seen[0].params.update.args;
    assert.ok(args.includes("--cwd"));
    assert.ok(args.includes(root));
    assert.ok(args.includes("streaming-json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ACP events map to model and tool progress", () => {
  assert.deepEqual(
    grokProgressFromEvent({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk" } } }),
    { stage: "model_session", message: "Grok session is active", current: 2, total: 4 },
  );
  assert.deepEqual(
    grokProgressFromEvent({ method: "session/update", params: { update: { sessionUpdate: "tool_call", title: "write_file" } } }),
    { stage: "tool_use", message: "Grok is using write_file" },
  );
});

test("preflight requires exact Grok token", async () => {
  const result = await preflightModel({
    runPrompt: async () => ({ stdout: READINESS_TOKEN + "\n", events: [] }),
  });
  assert.equal(result.token, READINESS_TOKEN);
  await assert.rejects(
    () => preflightModel({ runPrompt: async () => ({ stdout: "almost " + READINESS_TOKEN, events: [] }) }),
    (error) => error.code === "readiness_token_mismatch",
  );
});

test("missing bootstrap token fails before registration", async () => {
  assert.throws(() => requireBootstrapToken(""), (error) => error.code === BOOTSTRAP_TOKEN_REQUIRED);
  let factoryCalls = 0;
  await assert.rejects(
    () => startGrokWorker({
      client: { reportReadiness: async () => {} },
      bootstrapToken: "",
      preflight: async () => {},
      workerFactory: () => {
        factoryCalls += 1;
        return { start: async () => {} };
      },
    }),
    (error) => error.code === BOOTSTRAP_TOKEN_REQUIRED,
  );
  assert.equal(factoryCalls, 0);
});

test("task handler reports progress and validates artifact", async () => {
  const root = await tempWorkspace();
  try {
    const progress = [];
    const handler = createTaskHandler({
      runPrompt: async ({ onEvent }) => {
        await writeFile(join(root, "grok-proof.txt"), "GROK_WORKER_ONLINE\n", "utf8");
        await onEvent({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk" } } });
        await onEvent({ method: "session/update", params: { update: { sessionUpdate: "tool_call", title: "write_file" } } });
        return { stdout: "", stderr: "", events: [] };
      },
    });
    const ctx = {
      task: {
        task_id: "task_grok_1",
        title: "Grok smoke",
        workspace: root,
        prompt: "Create grok-proof.txt",
        metadata: { expected_artifacts: ["grok-proof.txt"] },
      },
      signal: new AbortController().signal,
      getMessages: () => [],
      refreshMessages: async () => [],
      onMessage: () => () => {},
      reportProgress: async (event) => progress.push(event),
    };
    const result = await handler(ctx);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].path, "grok-proof.txt");
    assert.deepEqual(progress.filter((event) => event.current).map((event) => event.current), [1, 2, 3, 4]);
    assert.ok(progress.some((event) => event.stage === "tool_use"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing required Grok artifact fails", async () => {
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
