# AI Team 吸收 Magpie｜统一模型控制 V1（2026-10-18）

**上游项目**：yetone/magpie（Agent 模型配置与网关），不是 sshaipowered/magpie（跨端 Agent 对话）。
- https://github.com/yetone/magpie
- https://github.com/yetone/magpie/blob/main/docs/reference.md
- https://github.com/yetone/magpie/blob/main/docs/integrating.md

GitHub 显示 MIT 许可。本轮借鉴机制和架构边界，独立编写代码，没有复制 Magpie 源码。

## 1. 用户目标与设计原则

用户希望在 DSH、OpenCode、Qwen、MiMo、WorkBuddy 之间统一模型配置、记录配额、选择免费模型，同时绝不重复此前的意外 API 消耗。

必须区分：
- Worker ONLINE 只代表 Bridge 可派任务；
- 模型是否可用需要单独检查；
- 账号是否还有真实免费额度，需要单独检查；
- 模型可以派任务也不等于任务正在运行。

## 2. Magpie 能力及我们吸收的部分

| Magpie 机制 | 当前采用方式 | 当前状态 |
|---|---|---|
| 35+ Agent 统一模型视图 | 先读取 Bridge 实际 Worker 在线状态，模型费用未知标为 UNKNOWN | 完成 V1 只读原型 |
| Local Gateway 同一模型接口 | 不替换现有 Bridge，不导入密钥 | 暂不启用 |
| 配置字段精准编辑、Unwire/Restore 回滚 | 后续做 dry-run diff、备份与撤销测试 | 设计保留 |
| gateway-key models/limit | 显式模型白名单、证据有效期和拒绝计费 fallback | 完成离线准入规则 |
| 多账号/Quota/Usage | 不能把订阅登录误当独立 API 余额；不读取账号明文密钥 | 暂不启用 |
| 自动 provider/group fallback | **反向吸收**：禁止 auto、fallback 和多次重试，必须显式零价 | 离线门禁完成 |
| Skills/MCP Library 跨 Agent 同步 | 保留每技能独立仓库，不能自动覆盖现有 MCP 配置 | 后续 |

来源依据：官方 README、reference、integrating 以及 GitHub internal/agent 的 Set/Unwire/Restore 接口说明。

**源码核查边界**：官方 GitHub 文档与部分源码已浏览；Mac 上的完整 shallow clone 因网络超时未能完成，因此不声称已对 Magpie 全仓做安全审计。

## 3. 本次代码交付与测试

- ai-team-orchestrator/magpie_model_control.py
  - 仅 GET 127.0.0.1:8765/agents，只读取 Agent 状态且过滤多余字段。
  - 明确暂停 Gemini/Grok，不读取任何 Key。
  - 验证显式免费模型清单，要求有官方免费条款 URL、账号 quota 已核实、24 小时内证据、至少一个剩余请求、尝试次数为 1、fallback 空数组。
  - 不接受 unknown / paid / trial / auto / 任意回退 / 凭据字段。
  - 即使离线校验通过，也仅报告 candidate，dispatch_allowed 始终 false，等待真实 Worker 调用侧 FreeGuard 二次确认。
- ai-team-orchestrator/test_magpie_model_control.py
  - 16 项纯离线测试全部通过，含伪额度、暂停模型、带凭据 URL、过期证明和自动回退阻断。
- docs/research/model-routing/magpie-model-policy.example.json
  - routes 为空，默认没有任何已授权模型路线。

Mac 实际 Bridge 只读验证：dsh / opencode / mimo / qwen / workbuddy 五个 ONLINE；gemini / grok 均 PAUSED。新的模型控制模块对所有路径返回 dispatch_allowed=false（不代表原 Bridge 已把原有 Worker 停用）。实际模型调用数 0、配置改写数 0。

用法：

    cd ai-team-orchestrator
    python3 -B magpie_model_control.py
    python3 -B magpie_model_control.py --manifest docs/research/model-routing/magpie-model-policy.example.json
    python3 -B -m unittest test_magpie_model_control -q

## 4. 产品下一阶段

| 阶段 | 交付验收 | 优先级 |
|---|---|---|
| V1 只读统一模型表 | Bridge 真实 roster，缺免费证据即拒绝，16 项测试 | 已完成 |
| V2 Supervisor 派工准入 | 每次调用前现场验证零价资格、剩余额度和成本，禁止跨 provider 回退；限时真实 Worker 测试 | 下一阶段 |
| V3 精准配置与撤销 | 对每个 Agent 单项模型变更可预览 diff、回滚原样，需用户确认 | 延后 |
| V4 状态面板 | 在线/模型资格/任务状态/配额有效期分开显示，不再以在线冒充干活 | 延后 |

**其他主线**：Radar S1-A 的工作区持久化机会、搜索详情及证据查看仍是 P0；Magpie 不取代 Supervisor，也不应拖延 Radar。

## 5. 未解决的问题

1. Bridge 的 /agents 没有可验证的账号真实模型与费用信息，当前只能诚实报告 UNKNOWN。
2. 模型厂商免费额度可能因地域、时段、账号而变化；离线文件的 account_quota_checked=true 只是声明，不是官方收费证明。因此 V1 永远不能直接发真实请求。
3. 未来接 Magpie 网关可能改变 DSH/OpenCode 账号、端点和模型设置，必须先经过独立安全评审与用户批准。
4. 订阅计划不一定允许第三方 API 代理，Gemini/Grok 暂停状态不得被本功能绕过。
5. Magpie 发展迅速，正式接入应锁定具体版本与许可证，不凭营销文案判断安全性。

**阶段结论：Magpie 的模型管理思路已吸收为有真实 Bridge 结果、可复核安全测试的只读原型；未安装 Magpie、未替换现有 Worker、未产生 API 费用。**
