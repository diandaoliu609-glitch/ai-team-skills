# FreeLLMAPI × AI Team — 隔离接入评估（2026-10-18）

**阶段：官方源码已拉取、已验证只读接入探针；真实服务未启动、上游模型未接入、推理请求数为零。**

## FreeLLMAPI 是什么

官方源码：https://github.com/tashfeenahmed/freellmapi；本轮 Mac 检出提交 d2e2615。
- 它是自托管多模型网关（Gateway），不是向用户提供统一免费 Token 的平台。提供 OpenAI 兼容 /v1 接口、配额跟踪和自动失败转移，支持 OpenCode、Codex CLI、DSH 等客户端。
- 当前项目方宣称目录汇总约 34 家 provider、635 个“免费端点”、每月理论总 7.4B Token。这些是全平台目录汇总，不是用户账户实际免费额度，不能据此判定某个上游零账单。
- MIT 开源、免费自托管。可选 Premium 只影响模型目录更新延迟，官方页面标价 $19/年或 $49 买断；不要求购买。
- 官方明确仅适合个人实验，不保证稳定性和免费层永久有效。第三方模型有自己的条款。
- 项目宣称上游密钥用 AES-256-GCM 加密存于 SQLite，但真正推理仍会把提示词发送给选中的上游。初期不要发送 Radar/GSC 敏感数据。
- 默认自动 failure fallback，可在错误时跨模型尝试多达 20 次：和 AI Team 的失败即停/绝不偷偷扣费原则冲突，不能直接用 auto/fusion/多 provider chain。

## Mac 现状

- Mac arm64，Node 23.5.0（满足项目宣称 >=20.18 且 <25 的要求）；Docker 客户端存在但 Docker daemon 未启动。
- 本机 127.0.0.1:3001 未提供 FreeLLMAPI HTTP 服务。
- 官网源代码以 shallow clone 方式放在 /tmp/ai-team-freellmapi-inspect-20261018/ 供审查；**没有执行远端 curl|bash、npm install、Docker 镜像、API 模型请求，也没有读取或导入已有 API Key。**
- AI Team Bridge 与 5 个已上线 Worker 未修改；Gemini/Grok 继续暂停。

## 本轮实际工程产物

- ai-team-orchestrator/tools/freellmapi-readiness.mjs
- ai-team-orchestrator/test/freellmapi-readiness.test.mjs

本地只读命令：node ai-team-orchestrator/tools/freellmapi-readiness.mjs http://127.0.0.1:3001

上游源码已核实 server/src/app.ts 的免认证 GET /api/ping 返回 status=ok；/api/health 则需要 Dashboard 用户会话，不适合作为免认证探针。

探针只访问 loopback HTTP GET /api/ping。严格拒绝公网 / localhost DNS / URL 参数和凭据 / 非根路径 / 跳转 / 无界超时；完全不调用 /v1/chat/completions、/v1/models 等任何模型路由请求，也不读取本机 API Key。6 项合成 HTTP 单测全部通过。探针的 reachable 只代表 HTTP 服务响应，不代表账单安全、额度可用或 Worker 已上线。

## 下一阶段准入标准（当前未完成）

1. 隔离安装，只绑定 127.0.0.1；不自动导入现有多模型 API Key 或开启 LAN/公网。用户目前不需要新开付费订阅。
2. 服务端应只启用一个有**官方零价依据**的路由，先运行只读健康检查；**仅在确认免费资格后**才允许一个限量真实模型请求。
3. 不允许 model=auto、fusion 或跨服务商备用链；还需审查上游路由器服务器配置与失败重试次数，不能只靠客户端填写固定模型名就自认为“绝对不回退”。
4. 不打开 Gemini/Grok 计费渠道，不重用过往 OpenRouter 或 NVIDIA 可能按量计费的旧 Key。定价不明确时禁止调用。
5. 请求/应答必须记录实际 x-routed-via、fallback attempts、费用归属、token 使用。只传合成低敏内容，真实 GSC 授权信息不得进入免费第三方中继。
6. 先在 AI Team 中作为可选模型网关；不新增第六个 Worker，也不取代既有 DSH FreeGuard；Radar 浏览器整条流程验收仍是 P0。

## 结论

**Conditional GO for isolated study（隔离研究可继续）；NO-GO for production dispatch（暂不允许生产派工）**。

阻塞：Docker daemon 离线；尚未验证单一路由的真实零价资格与禁用回退设置。这些条件满足之前，FreeLLMAPI 不向外发送任何模型推理请求。

参考：
- https://github.com/tashfeenahmed/freellmapi
- https://github.com/tashfeenahmed/freellmapi/blob/main/docs/en/install/01-install.md
- https://github.com/tashfeenahmed/freellmapi/blob/main/docs/en/architecture/00-high-level-index.md
- https://freellmapi.co/pricing


## 2026-10-18 夜间：获准后的隔离部署实测与恢复

- Docker Engine v27.3.1 在用户授权后曾临时启动；创建了专用 internal=true 网络 ai-team-freellmapi-offline，没有容器加入，没有运行 FreeLLMAPI 模型服务。
- 官方 GHCR 镜像共尝试三次拉取，每次在下载大镜像层期间超时，因此镜像未完整到位、3001 端口没有服务，真实推理为 0。
- 已编写 tools/freellmapi-lab.sh（语法检查通过）；只能手动启动、强制已存在官方镜像、内部网络和回环端口、无自动重启、不给模型 Key、非 root 身份与临时数据盘。此脚本尚未经过真实容器启动测试，不可视为可用部署。
- **重要环境副作用**：启动 Docker Desktop 后，原有 Dify 容器随 Docker 引擎恢复启动，部分旧容器公开绑定 0.0.0.0:80/443/5003。发现后使用 AppleScript 对 com.docker.docker 退出，确认后台 docker backend 进程停止、80/5003 不再监听；AI Team Bridge 8765 保持 5 Worker 在线。
- **今后启动 Docker 前先评估旧容器自动恢复行为**；不能以为新 FreeLLMAPI 容器仅监听 loopback 就代表整个 Docker Desktop 没有其他公网端口。无需用户再次批准时不得再启动 Docker daemon 或重新开启旧容器。
- 既有 Git / Radar 文件未覆盖，未导入任何 API Key、未发生付费模型调用；FreeLLMAPI 服务状态仍 NOT RUNNING / NO-GO。
