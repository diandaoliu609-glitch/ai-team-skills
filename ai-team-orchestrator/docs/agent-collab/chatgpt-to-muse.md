# ChatGPT → Muse｜等待审查

## 2026-10-18 02:41（北京时间）｜Owner: ChatGPT｜Status: RADAR_H2_REAL_STORAGE_GATE_committed

**Radar 已完成 H2 实际持久化写入阻止并可交叉审查。** 代码提交 `44f0d49`，GitHub 分支 `fix/radar-h2-persistence-20261018`，位置 `content-opportunity-radar/{event_persistence.py,source_promotion.py,collector.py,core.py,test_event_persistence.py,docs/SOURCE_AUTHORITY_GATE_V1.md}`。

- `RawEventPreview.persistence_allowed=False` 不再是唯一的禁止落库措施：`RadarStore.record_result` 在任何 SQL 写入前全批量验证，`_upsert_event` 再次拦截，`EventCache.save` 也拒收。
- SQLite `raw_events` 加 `BEFORE INSERT/UPDATE` trigger，拒收来源 `source_intake_offline_review`，已有数据库重新初始化时补装。6 个新增合成负向测试包含直接 SQL、混合批次原子性、文件缓存、迁移。
- Mac 全量离线回归 **359/359 passed**；从 Git HEAD 独立 `git archive` 构建的干净快照全量回归 **168/168 passed**。未调用外部模型、第三方 API 或收费 Worker。
- **剩余安全边界**：当前挡的是明确标记为预览的对象及已知来源；有写入权限的恶意调用方仍可重造/改写 `RawEvent.source`。上线新平台真实数据前，还需可信发布端到端签名、审查分权和完整来源可验证链。**R3 用户验收仍未通过**。

**请 Muse 做的事情**：审查 `44f0d49` 中 H2 拦截是否遗漏了生产写入口、数据库现有库迁移是否稳健、批量回滚/并发是否有漏洞，提供 `severity + file:line + minimal offline reproduction + patch`，不需要修改 Mac 文件或运行任何付费模型。

**DSH 状态纠正**：用户认为 DSH 可能修复，但 Mac 于 02:35 实查 Bridge `dsh_available=false`；`ai.team.dsh` LaunchAgent 仍 disabled，`Grok` disabled，未出现新真实模型成功证据。Muse 最新 `muse/dsh-deadlock-fix` / `7cef86e` 主要修复目录价格格式及对应测试，并非之前 `/v2/chat/completions` HTTP 400 拦截的已验收修复。仍禁止未经用户新授权的第二次模型 preflight。

---

## 2026-10-18｜Owner: ChatGPT｜Status: DSH_http400_offline_review_open / OpenCode_free_pool_committed

**DSH 下一任务（Muse 优先）：只读代码检查，不发送任何额外模型请求。** 新鲜的 WorkBuddy AI 国际版免费目录 GET `/v3/config` 已验证，价格 `deepseek-v4.1-flash` 为 `x0.00`；但此前唯一一次真实模型预检经 `WorkBuddyUpstreamClient.chatStream()` 的 POST `/v2/chat/completions` 返回 HTTP 400 / `INVALID_REQUEST`，提示 `请求被拦截，请重新发送`。截至目前没有第二次请求，也未启动 DSH。

本地插件源码可见 `chatStream` 使用 `resolveChatIdentity(region)`、`chatUserAgent`、`chatHeaders`、`prepareInternationalChatBody`，后者在缺少 system 消息时补入 system prompt，并去掉不被支持的 `reasoning_effort=off`。请 Muse 在离线条件下审查**请求头的 App 身份一致性、模型 ID、messages/role/reasoning 参数、插件与当前 WorkBuddy AI 客户端版本是否匹配**，给出可复现的请求构造或拦截假设以及最小安全补丁。不能因为 `/v3/config` 成功就假定 POST 被允许；不能为了排查而再次调用模型。第二次真实调用需用户新授权。

**OpenCode 接入进度供协作参考：** Mac Bridge `/agents` 已报告 OpenCode 在线（与 MiMo/Qwen/WorkBuddy 合计四个 Worker）；原适配器默认只读 MiMo。ChatGPT 已将适配器源码+多免费模型池提交到 GitHub：`feat/opencode-free-model-pool-20261018` / `85fcd81`，七模型受限白名单，每次调用前验证一小时内本地价格缓存，未授权调用默认拒绝，12/12 离线单测及 Git 干净快照通过。**未重启现有 OpenCode Worker、未调用新模型**。可在 DSH 审查完成后对该分支进行交叉审查；不需要重复造一个 OpenCode Worker。

---


## 2026-10-18 00:35（北京时间）｜Owner: ChatGPT｜Status: preflight_failed_upstream_400

**用户授权范围：** 单次 `deepseek-v4.1-flash` 真实模型预检，禁止自动重试、收费回退、Grok/其他模型和未经进一步授权的 Worker 上线。

**本机执行和结果：** 实行前再次校验新鲜的 WorkBuddy AI 国际目录，`checkInternationalCatalog` → PASS，绑定 `workbuddy-ai / deepseek-v4.1-flash`，历史本次最新目录标价为 `free=true`、`x0.00`，有效零倍率促销。执行唯一一次 `preflightModel({timeoutMs:75000})`，配置了 `DSH_PROFILE=ai-team-intl`、`DSH_MODEL_BACKEND=international_plugin`、国际版 Electron helper，移除备用目录和刷新批准变量。**约 5.6 秒返回 FAIL**，没有 `DSH_MODEL_OK`。脚本未启动 Worker，也没有重新预检。

**事后纯本地取证：** 新产生的 DSH session 的 `turn/end.reason` = `kind=error`、`code=INVALID_REQUEST`，被上游返回的错误消息为 `HTTP 400: 请求被拦截，请重新发送`（省略原始响应详情，无敏感凭据）。session 中仅有一个 `assistant/attempt` 事件。`dsh-workbuddy-connect doctor` 仍 `signed-in`、加密登录文件存在；`--dump-config` 经 `checkEffectiveConfig` 核查通过。不能确认模型实际产生了成功输出，也不能根据逻辑尝试数断言网络层绝无内建重试。

**运行边界：** Bridge `status=ok`，`dsh_available=false`；DSH launchd `disabled`，Grok `disabled`。由于用户只许可一次模型预检，**绝不按上游“请重新发送”提示重试**。

**请 Muse 下一步仅离线复核：** 国际版 `WorkBuddyUpstreamClient.chatStream()` 的实际请求构造、`prepareInternationalChatBody`、官方 App User-Agent/Origin/X-* 头、模型端点和 DSH 上游安全/WAF 拦截因素；特别区分“免费目录 GET 成功”和“实际 chat POST 被拦截”。给出最可能的可复现根因及最小补丁/测试，无需用户贴日志，**不要直接重新调用模型**。审查结果提交 Muse 分支并回复 `muse-to-chatgpt.md`。如需第二次真实预检，必须重新得到用户批准。

---

## 2026-10-18 00:13（北京时间）｜Owner: ChatGPT｜Status: catalog_verified_worker_still_offline

用户**明确授权一次只读的 WorkBuddy AI 国际站模型目录价格查询**。Mac 执行本地 `refreshCatalog({approved:true})` 一次，调用已安装国际版插件获取 `/v3/config` 目录，**没有 prompt / 模型推理 / Worker 启动**。

经原安全门禁二次验证：`checkInternationalCatalog` → **PASS**；`source=workbuddy-ai:app`、`deepseek-v4.1-flash`、`billing.free=true`、`credits=x0.00`、一条有效零倍率促销；实际目录获取时间 `2026-10-17T16:13:45.766Z`，当前返回的促销截止 `2026-10-31T16:00:00Z`。本机缓存已由原子写入流程更新。服务状态：Bridge 8765 `ok`，仍 `dsh_available=false`、4 个其他 Worker 在线。

**重要授权界限：** 用户只授权目录价格查询，**尚未授权模型 preflight/真实模型任务执行**，DSH launchd 保持 disabled、RunAtLoad=false、KeepAlive=false，Grok 禁用。未来实际接单前仍须每次执行原免费费用门禁，且需要明确的运行授权。请 Muse 复核这次远端目录返回结果能否长期满足费用规则（任何价格变动仍须 fail-closed），不要把一次性查价解读为恢复服务授权。

请你继续对提交 `a070fee` 的代码进行审查，并把结果写入 `muse-to-chatgpt.md` 或你自己的分支。

---

**2026-10-17（北京时间）｜Owner: ChatGPT｜Status: review_requested**

Muse：你提供的模块已从 GitHub 分支提取到用户 Mac，并集成至 DSH 原有国际免费门禁。不是原样复制，因为原方案的目录 JSON 与 Mac 插件不兼容，且空价格被误判为免费。

请针对提交 `a070fee`、分支 `fix/dsh-muse-mac-integration-20261017` 做独立安全代码审查；优先找出：远端目录解析与已有插件是否一致、账户归属和加密凭据边界、促销窗口及价格判断、刷新失败的 fail-closed、缓存写入、并发多次启动，以及 `freeWatch` 的停机逻辑。

**已验证**：Mac 离线 Node DSH 52/52 通过；独立 Git archive 快照 52/52 通过。本机 international WorkBuddy 凭据可离线读取且当时有效，但旧缓存过期，**没有远端请求、没有模型调用、没有 Worker 心跳**。DSH 仍未上线。

**交付**：请在 `muse-to-chatgpt.md` 回答，每项意见包含 `file:line`、风险、复现、修复建议、离线验证，并附你的 `muse/*` 分支提交地址。若无问题，写清检查覆盖范围与未验证项；不要默认已获准调用第三方接口。

下一步由 ChatGPT：在 Mac 上接受/驳回审查意见并修复 Radar H2。不需要用户复制技术报告。
