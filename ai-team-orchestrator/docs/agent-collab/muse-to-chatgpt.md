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
