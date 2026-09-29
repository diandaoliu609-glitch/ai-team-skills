import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildTraeArgs,
  collectArtifacts,
  createTaskHandler,
  preflightModel,
  runDoubaoTask,
} from "../src/index.js";
import {
  BOOTSTRAP_TOKEN_REQUIRED,
  CREDENTIAL_UNAVAILABLE,
  READINESS_TOKEN,
  requireBootstrapToken,
  requireProviderCredential,
  startDoubaoWorker,
} from "../src/readiness.js";

async function tempWorkspace() {
  return mkdtemp(join(tmpdir(), "doubao-worker-"));
}

test("Trae args use config/provider/model/working-dir without API key", () => {
  const args = buildTraeArgs({ promptFile: "/tmp/prompt.txt", workspace: "/tmp/work" });
  assert.ok(args.includes("--provider"));
  assert.ok(args.includes("doubao"));
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("--working-dir"));
  assert.ok(args.includes("/tmp/work"));
  assert.ok(args.includes("--config-file"));
  assert.equal(args.includes("--api-key"), false);
});

test("Doubao API preflight requires exact token and keeps key in header", async () => {
  const previous = process.env.DOUBAO_API_KEY;
  process.env.DOUBAO_API_KEY = "unit-secret";
  try {
    const result = await preflightModel({
      fetchImpl: async (url, options) => {
        assert.match(String(url), /chat\/completions$/);
        assert.equal(options.headers.authorization, "Bearer unit-secret");
        const body = JSON.parse(options.body);
        assert.equal(body.messages[0].content, "Return exactly: DOUBAO_MODEL_OK");
        return {
          ok: true,
          status: 200,
          async json() { return { choices: [{ message: { content: READINESS_TOKEN } }] }; },
        };
      },
    });
    assert.equal(result.token, READINESS_TOKEN);
    await assert.rejects(
      () => preflightModel({
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          async json() { return { choices: [{ message: { content: "wrong" } }] }; },
        }),
      }),
      (error) => error.code === "readiness_token_mismatch",
    );
  } finally {
    if (previous === undefined) delete process.env.DOUBAO_API_KEY;
    else process.env.DOUBAO_API_KEY = previous;
  }
});

test("fake Trae executable receives Doubao key in env and exposes tool progress", async () => {
  const root = await tempWorkspace();
  const fake = join(root, "fake-trae");
  const previous = process.env.DOUBAO_API_KEY;
  process.env.DOUBAO_API_KEY = "unit-secret";
  try {
    await writeFile(fake, `#!/usr/bin/env node
if (process.env.DOUBAO_API_KEY !== "unit-secret") process.exit(41);
if (process.argv.includes("--api-key")) process.exit(42);
console.log("Tools  bash");
console.log("Final Result done");
`, "utf8");
    await chmod(fake, 0o755);
    const tools = [];
    const result = await runDoubaoTask({
      task: { task_id: "fake", title: "fake", workspace: root, prompt: "x" },
      prompt: "hello",
      traeBin: fake,
      onTool: async (name) => tools.push(name),
      timeoutMs: 5_000,
    });
    assert.deepEqual(tools, ["bash"]);
    assert.match(result.stdout, /Final Result/);
  } finally {
    if (previous === undefined) delete process.env.DOUBAO_API_KEY;
    else process.env.DOUBAO_API_KEY = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("missing provider credential is explicit", () => {
  assert.throws(() => requireProviderCredential(""), (error) => error.code === CREDENTIAL_UNAVAILABLE);
});

test("missing bootstrap token fails before registration", async () => {
  assert.throws(() => requireBootstrapToken(""), (error) => error.code === BOOTSTRAP_TOKEN_REQUIRED);
  let calls = 0;
  await assert.rejects(
    () => startDoubaoWorker({
      client: { reportReadiness: async () => {} },
      bootstrapToken: "",
      preflight: async () => {},
      workerFactory: () => { calls += 1; return { start: async () => {} }; },
    }),
    (error) => error.code === BOOTSTRAP_TOKEN_REQUIRED,
  );
  assert.equal(calls, 0);
});

test("task handler reports progress, tool use, and validates artifact", async () => {
  const root = await tempWorkspace();
  try {
    const progress = [];
    const handler = createTaskHandler({
      runTask: async ({ onTool }) => {
        await writeFile(join(root, "doubao-proof.txt"), "DOUBAO_WORKER_ONLINE\n", "utf8");
        await onTool("str_replace_based_edit_tool");
        return { stdout: "done", stderr: "" };
      },
    });
    const result = await handler({
      task: { task_id: "d", title: "d", workspace: root, prompt: "Create doubao-proof.txt", metadata: { expected_artifacts: ["doubao-proof.txt"] } },
      signal: new AbortController().signal,
      getMessages: () => [],
      refreshMessages: async () => [],
      onMessage: () => () => {},
      reportProgress: async (event) => progress.push(event),
    });
    assert.equal(result.artifacts[0].path, "doubao-proof.txt");
    assert.deepEqual(progress.filter((e) => e.current).map((e) => e.current), [1, 2, 3, 4]);
    assert.ok(progress.some((e) => e.stage === "tool_use"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing required Doubao artifact fails", async () => {
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
