# AI Team Gemini Pro OAuth Worker 恢复核验｜2026-10-18

## 现状：代码已具备安全恢复条件，**真实模型预检未通过；Gemini 尚未上线**

- 用户希望重新启用 Gemini Worker，并告知已订阅 Gemini Pro。
- Mac：`gemini --version = 0.63.0`，已有 `gemini-node-worker`，Bridge `agent_id=gemini` 配置为 `registered_pull` 但 **available=false**。
- 原版 Worker：`runGeminiPrompt` 直接继承进程环境，默认 `auto_edit`，`startGeminiWorker` 默认 `maxAttempts=Infinity`，存在旧 API Key 被误用、后台反复预检的费用和配额风险。
- 本轮修复：新增 `src/oauth-guard.js`，只接受 `oauth-personal` 且必须明确设置 `AI_TEAM_GEMINI_OAUTH_APPROVED=1`；每次运行前检查；剔除所有已知 API Key/Vertex 环境；默认改为 `plan`（只读）；就绪预检最多一次，失败不启动 Worker。
- 新增 `test/oauth-guard.test.js`，全部使用合成凭据和假运行器，不访问第三方接口。

## Mac 实际验证（不包含任何密钥）

| 检查 | 结果 |
|---|---|
| 现有 Gemini CLI | `0.63.0` |
| `~/.gemini/settings.json` 所选认证类型 | `oauth-personal` |
| OAuth refresh token | 存在（未输出内容） |
| 当前 Shell 的 `GEMINI_API_KEY` / `GOOGLE_API_KEY` | 未设置 |
| 其他存留的旧 API Key 文件 | 存在，但本项目不读取 |
| OAuth 本地门禁 | PASS，未联网 |
| 唯一一次真实 OAuth 预检 | **FAIL**，约 5.6 秒，简化错误为 `cli_failure` |
| OAuth token 刷新 | 该次请求之后本机 credential 文件更新时间改变、过期时间变为未来约 60 分钟 |
| `GEMINI_MODEL_OK` | 未出现 |
| Worker 注册/心跳 | **未执行**，Bridge 仍显示 Gemini unavailable |
| Gemini API Key 或 Vertex AI 推理 | **未调用** |

**不能从这一结果判断失败的确切上游代码。** 特别不能把 token 刷新成功直接认定为模型调用成功。真实上游失败细节没有留存为受审计、脱敏的日志；已遵循一次调用失败停止的约束。

## 文档矛盾与处理方式

- Gemini CLI 官方 [认证指南](https://geminicli.com/docs/get-started/authentication/) 仍推荐 Google AI Pro/Ultra 用订阅账号 OAuth 登录。
- Google 官方 [个人版 Code Assist 关闭公告](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals) 声称 2026-06-18 起个人订阅停止服务，且影响 Gemini CLI。
- **不要擅自以任一页面断定用户实际账号可用性**；下一步需同一 Google 账号的订阅与 CLI 权限核对，并根据 Google 现行政策选择官方支持的授权方案。

## 下一步

1. 先保留 GitHub 上的 OAuth-only 安全实现；Mac 现有运行中的 DSH、OpenCode、Qwen、MiMo、WorkBuddy Worker 不受影响。
2. 核对用户购买 Pro 的 Google 账号是否与 CLI 登录账号相同，并检查该账号是否仍支持 Gemini CLI 请求；若不支持，推荐通过 Google 官方 Antigravity 路线或其他**有明确订阅覆盖证明**的工具接入，而不是偷用按量计费 API Key。
3. 待授权通路明确后，再做一次**单次**真实模型预检；准确输出 `GEMINI_MODEL_OK` 才能手动启动 Gemini Worker、验证 Bridge 心跳以及真实产物。
4. 不允许以 `gemini.available=false` 的状态伪装成第六个在线 Worker，不可以反复探测消耗额度。
