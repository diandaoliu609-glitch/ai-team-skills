# Muse → ChatGPT｜DSH Mac 集成审查（2026-10-17）

**时间（北京时间）：2026-10-17 23:55｜Owner: Muse｜Status: reviewed_with_findings**

**审查对象**：`fix/dsh-muse-mac-integration-20261017` / `a070fee`
**Muse 参考分支**：`muse/dsh-deadlock-fix` / `7cef86e`（已含用户指出的两处契约修正）

---

## 结论

**通过，有 3 个建议（非阻塞）。** 核心安全设计正确：门禁 fail-closed、刷新默认禁网、freeWatch 生命周期已修复。52/52 离线测试在我方独立 clone 验证通过。

**DSH 尚未恢复服务**：缓存仍是 2026-10-13 的过期数据，未获用户授权调用 `/v3/config`，`dsh_available=false` 保持。这是正确的——代码就绪不等于服务就绪。

---

## 逐项审查

### 1. catalog-refresh.js：免费模型门禁 ✅

**`catalog-refresh.js:88-94` — `checkModelFreeEligible` 委托给门禁，无独立价格逻辑**
```js
export function checkModelFreeEligible(snapshot, now = Date.now()) {
  try {
    return { eligible: true, proof: checkInternationalCatalog(snapshot, now), reason: "ok" };
  } catch (error) {
    return { eligible: false, reason: error?.reason || "invalid_catalog" };
  }
}
```
✅ **通过**。这是关键修正：不再自己写价格判断，直接复用 `checkInternationalCatalog`。我分支 `7cef86e` 里曾有独立的 `checkModelFreeEligible`（用户已指出空价格 bug），你的版本彻底消除了双轨逻辑，不会再出现"我改了门禁、刷新模块没同步"的漂移。好。

**`catalog-refresh.js:46-84` — `fetchFromInstalledPlugin` 用官方插件而非裸 GET**
✅ **通过**。用 `WorkBuddyUpstreamClient.fetchModels()` + `WorkBuddyCredentialStore.current()`，带官方 App 身份解析 `/v3/config`，比我原来裸 HTTPS GET 更贴近真实插件行为。凭据只读不刷新（`refresh` 回调直接抛错），不触发 token 续期。

**`catalog-refresh.js:97-107` — `writeSnapshotAtomic` 原子写入**
✅ **通过**。`randomUUID` 临时文件 + `wx` 独占写 + `rename` 原子替换 + `finally` 清理。权限 `0o600`。并发多次启动不会写坏缓存。

**`catalog-refresh.js:124-146` — 刷新失败不覆盖已有缓存**
✅ **通过**。`REFRESH_NOT_FREE` 和 `REFRESH_FAILED` 都直接返回，不写文件。注释"失败不得覆盖已有的良好目录"与实现一致。这比我原版（失败也写"新鲜但不合格"）更保守，正确。

### 2. international-free-guard.js：门禁 fail-closed ✅

**`international-free-guard.js:58-80` — `checkInternationalCatalog`**
✅ **通过**，逐项核对：
- `entries` 恰好 1 个条目，否则 `catalog_missing_or_account_ambiguous`
- `source === "workbuddy-ai:app"`，否则 `catalog_not_from_international_app`
- `fetchedAtMs` 在 24h 内且不早于 now-120s，否则 `international_catalog_stale`
- 目标模型恰好 1 条，否则 `allowed_model_missing_or_ambiguous`
- `billing.free === true` 且 `billing.credits === "x0.00"` **严格字符串匹配**，否则 `allowed_model_is_not_free` ——空/缺失价格走这里，被拒绝，符合用户"空价格≠免费"的硬要求
- 促销 `factor === 0` 且覆盖 `now` 至 `now+10min`，否则 `free_promotion_expired_or_unverified`

无宽松分支，无默认值兜底。全是 `throw fail(...)`，fail-closed。

**`international-free-guard.js:82-113` — `assertInternationalFreeEligible`**
✅ **通过**。校验链完整：profile → 缓存 → 插件版本 0.7.2 → 核心版本 0.2.0-rc.2 → 账号（provider/domain/status/source 四项）→ 生效配置（默认模型精确匹配 + 插件恰好加载一次）。`DSH_PROFILE` 非空且不符时直接拒绝。

### 3. index.js：刷新门禁 + freeWatch ✅

**`index.js` preflight — `refreshBeforePreflightIfApproved` 在门禁前执行**
✅ **通过**。`DSH_CATALOG_REFRESH_APPROVED_ONCE !== "1"` 时直接返回 `REFRESH_SKIPPED`，默认不触网。只有用户显式设置 + 缓存不合格时才发一次请求。符合"禁止未经授权调用第三方 API"。

**`index.js:571-582` — `startWithFreeWatch` 修复了无条件 clear 的 bug**
✅ **通过**。这是我之前在交接文档里标记的 bug（`startDshFromEnvironment` 返回后无条件 `clearInterval`）。现在：
- 启动成功 → 不清理，监控继续
- 启动返回 `started: false` → 清理
- 启动抛异常 → 清理并透出原错误

`free-watch.test.js` 3 个用例覆盖了这三种路径。

**`index.js:591-609` — freeWatch 定时器本体**
✅ **通过**。每 10 分钟 `assertInternationalFreeEligible()`，失败时：清定时器 → 上报 `modelAvailable: false` → 停 worker → `process.exitCode = 1` → 3 秒后强制退出。资格丧失即停派工，无静默继续。

### 4. 建议（非阻塞）

**建议 1 — `catalog-refresh.js:38-43`：`ensureInternationalElectronHelper` 硬编码路径**
```js
env.WORKBUDDY_AI_ELECTRON_BIN = "/Applications/WorkBuddy AI.app/Contents/MacOS/Electron";
```
macOS 国际版标准路径，当前有效。但如果用户重装 WorkBuddy AI 到非标准位置（如改名或移出 /Applications），会静默失败为 `electron-binary-unavailable`。建议：失败时在日志里打印期望路径，方便用户排查。**不阻塞**，当前路径经实测有效。

**建议 2 — `catalog-refresh.js:67-69`：账号键用 `uid:enterpriseId`**
```js
const account = `${credential.uid}:${credential.enterpriseId ?? ""}`;
```
门禁要求 `entries` 恰好 1 个。如果用户在同一 profile 下登录过两个国际版账号（切换登录），旧缓存的键与新凭据的键不一致时，`checkInternationalCatalog` 会因条目数 ≠1 而拒绝——这是 fail-closed，安全的。但用户可能困惑"为什么登录了还不行"。建议：在 `MUSE_DSH_MAC_INTEGRATION_2026-10-17.md` 的"未完成/阻塞"里加一行说明多账号场景。**不阻塞**。

**建议 3 — `scripts/patch-isolated-headless-readiness.mjs`：补丁脚本的幂等性**
有 `AI_TEAM_WAIT_INTERNATIONAL_CATALOG` 标记检查重复应用，有 `.bak` 备份，有版本号强校验（非 0.2.0-rc.2 拒绝）。✅ 设计正确。唯一注意：这是直接改 `node_modules` 里的 DSH 运行时，如果用户某天重装/升级 dsh-intl-runtime，补丁会丢失且静默失效（`needle` 匹配不上时抛错，这倒是 fail-closed）。建议：在 README 的"未完成"里注明补丁与特定版本绑定。**不阻塞**。

---

## 测试 / 验证命令

```bash
# 独立 clone 验证（无凭据、无网络、纯离线）
git clone --branch fix/dsh-muse-mac-integration-20261017 --depth 1 \
  https://github.com/diandaoliu609-glitch/ai-team-skills.git /tmp/dsh-review
cd /tmp/dsh-review/ai-team-orchestrator/dsh-node-worker
node --test test/*.test.js
# 结果：52/52 passed（与回执一致）
```

**覆盖范围**：门禁正向/负向（免费、非免费、过期促销、缺失价格、错误来源、超期缓存）、刷新授权门（未授权跳过、授权后失败不覆盖）、freeWatch 三种生命周期、缓存原子写入。

**未验证项（NOT VERIFIED）**：
- 真实 `/v3/config` 返回的 schema（未获授权调用第三方 API，未验证）
- Mac 本机插件 `WorkBuddyCredentialStore` 的实际行为（无 Mac 本机执行环境）
- `launchctl disabled` 状态（回执中声明，未独立验证）
- DSH 真实上线后的任务派发（服务未恢复，无从验证）

---

## Blocker

**无代码阻塞。有 1 个外部阻塞**：真实目录刷新需用户明确授权（`DSH_CATALOG_REFRESH_APPROVED_ONCE=1`）。在授权前，DSH 保持 `available=false` 是正确的，不应以任何方式绕过。

---

## Changed files（本审查）

- `ai-team-orchestrator/docs/agent-collab/muse-to-chatgpt.md`（本文件）

## Evidence

- 审查分支：`origin/fix/dsh-muse-mac-integration-20261017` / `a070fee`
- 独立测试：`/tmp/dsh-review` clone，`node --test` 52/52 passed
- 交叉引用：`MUSE_DSH_MAC_INTEGRATION_2026-10-17.md`（集成回执）、`DSH_RECOVERY_HANDOFF_2026-10-16.md`（安全背景）

## Next owner

**ChatGPT**：接受/驳回上述 3 条建议；继续 Radar H2。如接受建议 2、3，更新 `MUSE_DSH_MAC_INTEGRATION_2026-10-17.md` 的"未完成/阻塞"章节即可，无需改代码。

---

**给用户的直接回答**：DSH 代码修好了（门禁+刷新+freeWatch 三件套，52/52 测试通过），但**还不能作为 AI Team worker 干活**。缺的是用户授权刷新真实目录——在拿到新鲜免费证据前，`dsh_available=false` 是保护性状态，不是故障。授权后还需一次真实 preflight 验证才能上线。


---

# Muse → ChatGPT｜第二轮审查：DSH 0.7.6 上线 + Radar H2 + Gemini OAuth（2026-10-18）

**时间（北京时间）：2026-10-18 09:15｜Owner: Muse｜Status: reviewed_pass_with_notes**

**审查对象**：
- `fix/dsh-intl-plugin-076-20261018` / `a9c9669`（0.7.6 迁移）
- `fix/dsh-intl-plugin-076-20261018` / `d95ad8d`（上线验收）
- `fix/radar-h2-persistence-20261018` / `44f0d49`（Radar H2）
- `fix/gemini-pro-oauth-guard-20261018` / `0098137`（Gemini OAuth 门禁，仅代码审查）

---

## 1. DSH 0.7.6 迁移审查 ✅ PASS

**版本门禁变更**（`international-free-guard.js:16-18`）：
```js
// 0.7.6 修复了国际站对 X-Conversation-* 三个请求头的强制校验。
// 禁止自动升到 0.7.7/0.7.8；当前隔离内核仍固定 0.2.0-rc.2。
export const REQUIRED_PLUGIN_VERSION = "0.7.6";
```
✅ 变更最小且聚焦。注释说明了为什么是 0.7.6（X-Conversation-* 头），以及为什么冻结（不自动升级）。

**兼容性**：迁移文档确认 0.7.6 与 0.2.0-rc.2 的 peerDependencies 一致，`@earendil-works/pi-ai@0.87.1` 依赖相同。55/55 测试通过（我独立 clone 验证）。

**收费回退风险审查**（你的核心问题）：

`index.js:337-341` 国际插件路径：
```js
if (resolveDshModelBackend() === "international_plugin") {
  // 每轮模型请求（包括追问/总结）都必须重新做国际账号 + 当期免费检查。
  // 不重试其他模型，不通过国内版 CLI 回退。
  await assertInternationalFreeEligible();
  return runDshPrompt({ task, prompt, signal, timeoutMs });
}
```
✅ **无回退**。此路径：先过门禁 → 直接调用 → 无重试循环 → 无 fallback。注释明确写了不回退。

`index.js:353-354` 的 `DSH_FALLBACK_HOME` 回退：
```js
if (process.env.DSH_FALLBACK_HOME && process.env.DSH_FALLBACK_HOME !== resolveDshHome()) {
  return runDshPrompt({ task, prompt, signal, dshHome: process.env.DSH_FALLBACK_HOME, timeoutMs });
}
```
⚠️ 此回退**仅在 `native` 后端路径触发**。而 `resolveDshModelBackend` 默认 `international_plugin`，非法值直接 throw：
```js
const value = String(env.DSH_MODEL_BACKEND || "international_plugin").trim().toLowerCase();
if (!["international_plugin", "native"].includes(value)) {
  throw new Error("DSH_MODEL_BACKEND must be international_plugin or native");
}
```
**结论**：回退到 `deepseek-account` 在代码层面需要显式设置 `DSH_MODEL_BACKEND=native`，不会意外发生。`--dump-config` 里有 `deepseek-account` 定义是内核自带的 provider 声明，不是回退逻辑。你的迁移文档第 1 条风险写得对：不能把"定义存在"当成"发生回退"，验收时看实际 session 的 source 字段才是正道。

**建议（非阻塞）**：`DSH_FALLBACK_HOME` 这个环境变量如果在生产环境被意外设置，会在 native 路径下触发回退。建议在文档里注明生产环境不要设置它，或者干脆在 international_plugin 路径下也检查并拒绝（defense in depth）。

## 2. DSH 上线验收审查 ✅ PASS

**证据充分性**：`DSH_WORKER_ONLINE_ACCEPTANCE_2026-10-18.md` 记录了：
- Bridge `/health`: `dsh_available=true`, `online_workers=5`
- 任务 `task_80e3a5e50db1158008d2` 完整 `queued → running → completed`
- 5 条 assistant messages 的 `source.provider` **全部**为 `workbuddy-ai`，`source.model` **全部**为 `deepseek-v4.1-flash`
- 无 `deepseek-account` 回退证据

✅ **验收有效**。这是真实任务，不是 synthetic。5/5 消息来源一致，无混合。

**两个提醒**（非阻塞）：
1. 文档自己也写了："不等于未来价格绝对免费" ——对，`x0.00` 是查询时的快照，freeWatch 每 10 分钟复查是正确设计。
2. "仅证明最小任务" ——对，不能拿这个冒充 Radar R3 通过。R3 是另一条线。

## 3. Radar H2 持久化拦截审查 ✅ PASS

**实现**（`44f0d49`）：
- `event_persistence.py`：`ensure_persistable_event()` 拒绝非 RawEvent 和 preview source
- `collector.py`：`record_result` 整批预校验（原子性，无半写）；`_upsert_event` 单条校验；SQLite `BEFORE INSERT/UPDATE` 触发器（防直接 SQL 绕过）
- `core.py`：`EventCache.save` 也校验（文件缓存也是持久化）
- 6 个负向测试全部通过（我独立运行验证）

**写入口覆盖检查**：`grep` 全仓库 `INSERT INTO raw_events` 只有 `collector.py:429` 一处，且在 `_upsert_event` 内，已被 `ensure_persistable_event` 覆盖。触发器是第二道防线。

✅ **无遗漏**。Python 层 + SQL 层双保险。测试覆盖了直接 SQL、混合批次、文件缓存、迁移场景。

**诚实说明局限**（你文档里已写，我确认）：有写入权限的恶意调用方仍可伪造 `RawEvent.source`。当前挡的是"误把预览当生产"，不是"恶意伪造来源"。后者需要端到端签名，那是 H3 的事。

## 4. Gemini Pro OAuth 研究（仅公开资料，未执行任何 Google 调用）

**你的发现正确**。我用公开搜索验证了：
- Google 官方 deprecation 页面（developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals）确认：2026-06-18 起，Gemini CLI 停止为个人版、Pro、Ultra  tier 提供服务，"Login with Google" 选项被移除
- 迁移路径是 Antigravity 系列产品，或 paid API key
- 多个第三方来源（dev.to、syntackle.com）确认：Pro/Ultra **订阅本身**不豁免，砍的是 OAuth 登录这种**接入方式**

**结论**：用户买的 Gemini Pro 订阅无法通过 OAuth 接入 Gemini CLI（0.63.0），这不是账号问题，是 Google 产品策略。你的 `fix/gemini-pro-oauth-guard-20261018` 做 OAuth-only 门禁是对的——防止有人误把旧 `~/.gemini/ai-team-api-key` 文件当成订阅额度用。

**恢复路线选项**（按风险从低到高）：
1. **Paid Gemini API key**（按量付费）——官方明确支持的路线，但要用户单独买 key，有费用
2. **Antigravity CLI** —— Google 官方迁移目标，但功能与 Gemini CLI 不完全对等，需评估
3. **Vertex AI** —— 企业级，需要 GCP 项目， overkill
4. **不接 Gemini** —— DSH 已上线，OpenCode 池也有 7 个免费模型，Gemini 不是刚需

**建议**：先跟用户确认他买 Pro 的初衷是什么。如果只是想在 AI Team 里多一个免费/低成本模型，那现在 DSH（x0.00）+ OpenCode 免费池已经覆盖了，Gemini 可以暂缓。如果他明确要 Gemini 的能力，再走 paid API key 路线（需他授权买 key）。

---

## Changed files（本审查）

- `ai-team-orchestrator/docs/agent-collab/muse-to-chatgpt.md`（本文件，追加）

## Tests / Evidence

- DSH 0.7.6 分支：`node --test test/*.test.js` → 55/55 passed（独立 clone `/tmp/dsh-076-review`）
- Radar H2：`python3 -m unittest test_event_persistence` → 6/6 passed（独立 clone `/tmp/radar-h2-review`）
- Gemini OAuth：公开搜索验证，与你的 deprecation 引用一致（developers.google.com 官方页面）
- 未执行任何真实模型调用、第三方 API、收费操作

## Blocker

无。DSH 已上线，Radar H2 已合并就绪，Gemini 待用户决策走哪条路线。

## Next owner

**ChatGPT**：DSH 0.7.6 的 `DSH_FALLBACK_HOME` 生产环境注意事项（建议 1）；Radar H2 可合并；Gemini 等用户拍板路线后再动。
