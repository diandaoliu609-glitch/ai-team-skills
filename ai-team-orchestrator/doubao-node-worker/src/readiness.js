export const READINESS_PROMPT = "Return exactly: DOUBAO_MODEL_OK";
export const READINESS_TOKEN = "DOUBAO_MODEL_OK";
export const MODEL_UNAVAILABLE = "model_unavailable";
export const CREDENTIAL_UNAVAILABLE = "credential_unavailable";
export const DEFAULT_PREFLIGHT_TIMEOUT_MS = 60_000;
export const BOOTSTRAP_TOKEN_REQUIRED = "bootstrap_token_required";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function requireBootstrapToken(value) {
  const token = String(value ?? "").trim();
  if (!token) {
    const error = new Error("Doubao readiness requires AI Team bootstrap credentials");
    error.code = BOOTSTRAP_TOKEN_REQUIRED;
    throw error;
  }
  return token;
}

export function requireProviderCredential(value) {
  const token = String(value ?? "").trim();
  if (!token) {
    const error = new Error("Doubao API credential is missing: set DOUBAO_API_KEY, ARK_API_KEY, or DOUBAO_API_KEY_FILE");
    error.code = CREDENTIAL_UNAVAILABLE;
    throw error;
  }
  return token;
}

export function isReadinessResponse(value) {
  return String(value ?? "").trim() === READINESS_TOKEN;
}

function readinessReason(error) {
  return error?.code === CREDENTIAL_UNAVAILABLE ? CREDENTIAL_UNAVAILABLE : MODEL_UNAVAILABLE;
}

export async function waitForModel({ client, preflight, bootstrapToken, retryIntervalMs = 30_000, maxAttempts = Infinity, sleepImpl = sleep, logger = console } = {}) {
  if (!client || typeof client.reportReadiness !== "function") throw new TypeError("client.reportReadiness is required");
  const token = requireBootstrapToken(bootstrapToken);
  if (typeof preflight !== "function") throw new TypeError("preflight is required");
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      await preflight();
      await client.reportReadiness({ agentId: "doubao", modelAvailable: true, bootstrapToken: token });
      return { ready: true, attempts };
    } catch (error) {
      const reason = readinessReason(error);
      await client.reportReadiness({ agentId: "doubao", modelAvailable: false, reason, bootstrapToken: token }).catch(() => {});
      logger?.error?.(`Doubao readiness: ${reason}: ${error.message}`);
      if (attempts >= maxAttempts) return { ready: false, attempts, error };
      await sleepImpl(retryIntervalMs);
    }
  }
  return { ready: false, attempts };
}

export async function startDoubaoWorker({ client, workerFactory, preflight, bootstrapToken, retryIntervalMs = 30_000, maxAttempts = Infinity, sleepImpl = sleep } = {}) {
  requireBootstrapToken(bootstrapToken);
  const readiness = await waitForModel({ client, preflight, bootstrapToken, retryIntervalMs, maxAttempts, sleepImpl });
  if (!readiness.ready) return { started: false, readiness };
  if (typeof workerFactory !== "function") throw new TypeError("workerFactory is required");
  const worker = workerFactory();
  await worker.start();
  return { started: true, worker, readiness };
}
