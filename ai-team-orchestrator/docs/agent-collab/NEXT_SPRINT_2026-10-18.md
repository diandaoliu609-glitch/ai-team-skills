# AI Team × Muse｜Radar S1 可用性冲刺（2026-10-18）

## 决策
当前产品主线是 Radar 真正可用与 R3 真实验收，暂停 Gemini 和 Grok。现有 DSH、OpenCode、MiMo、Qwen、WorkBuddy 共 5 个在线 Worker。不得以 Pro 订阅调用旧 Gemini API Key，不得产生未经授权的额外收费推理。

Muse 二轮评审 fa0bd4e：DSH 0.7.6 实际接单 PASS；Radar H2 防预览落库 PASS。H2 提交为 44f0d49；已合入当前 Git HEAD，但当前运行服务是否加载该版本尚未证实。

2026-10-18 本机核验：Radar 8787 首页与工作区 API 是 HTTP 200，不代表真实浏览器操作通过。r3_readiness.build_readiness() 显示 preparation_complete=true、真实 R3=0/4。四关未通过：human_precision（真人标签）、gsc_first_party（GSC 授权工作区与真实数据）、design_partner（真人使用会）、native_vs_experimental（两组真人标签）。

## 分工与可验收交付

| 阶段 | Owner | 工作与产物 | 真正完成的判据 |
|---|---|---|---|
| S1-A P0 页面可用性 | ChatGPT 本机复现，DSH 定向修复 | 浏览器实际交互缺陷清单；必要时小范围代码、测试、前后截图 | 实际浏览器打开 8787；切换工作区、搜索、查看来源、语言 zh/en/ko/ja、刷新操作通过。不以 HTTP200 代替 |
| S1-B P0 GSC 真实性 | Muse 离线审查，ChatGPT 集成 | 检查 r3_gsc_validation.py、r3_readiness.py、workspace.py；file:line、负面测试、最小修复建议 | 合成 JSON 或伪造 healthy/event_count 不能冒充真实第一方 OAuth 证据。无授权保持 PENDING |
| S1-C 来源链与实数验证 | DSH 受控实现，ChatGPT 复验 | 经用户授权的第一方证据链、UI 来源标签和 doctor 结果 | 真实来源可追溯且不泄漏 token；未有真实授权时绝不宣称 GSC 已通过 |
| S1-D R3 真人验收 | ChatGPT 协助用户，Muse 复核 | 四道 R3 结果、真人记录 | 至少 20 个独特主题真实人工标签、Precision@5 ≥0.60，真实目标用户会话，原生/实验对照；缺一项继续 PENDING |
| H3 非当前 P0 | Muse 轻量威胁建模 | 恶意改写 RawEvent.source 的最小可复现风险 | 不替代 H2，不进行未经证明的大重构；优先 S1-A/S1-B |

## 各方下一步
Muse：优先审查 GSC 第一方门禁的合成数据伪 PASS 风险，并检查 Dashboard UI 合同；回复 muse-to-chatgpt.md，附严重度、确切代码行、纯离线复现和最小建议。评估上述优先级并提出有证据的调整。无需调用外部付费 API，不得自称已经在 Mac 浏览器验收。

ChatGPT：本地验证页面实际操作和已运行 H2 的部署状态。将明确复现的 P0 交给在线 DSH 在隔离工作区修补并复测，不等待 Muse 才开始。持续更新交付、进度和障碍。

DSH：严格通过每次免费模型费用门禁；不自动使用收费后备。任务须限时、限范围、产物可独立核查。
Gemini：Mac 已从 Bridge 启动脚本移除 --pull-agent gemini，重启验证 configured=false/queueable=false/available=false；不调用 Pro/OAuth/Key。
Grok：继续 disabled。

## 事实与协作约束
- 不提交账号、Bearer token、Mac 登录凭证或用户实际 GSC 域名。
- 不动主仓库其他 Agent 未提交修改；使用隔离 worktree，不强推。
- GitHub 分支 coord/muse-chatgpt-20261017 只是异步邮箱，不会自动唤醒 Muse。要收到 Muse 正式答复，必须下次由 Muse 运行并推送。
- 下一次报告注明通过的真实门槛数、提交、可复现证据、阻塞、下一步；严格区分离线测试、HTTP 服务健康、浏览器实际可用、真人 R3 PASS。
