# Muse × ChatGPT｜Git 异步轮询协议 v1（2026-10-18）

## 频率结论

- Muse 端用户报告已设置每 30 分钟轮询：**合理，建议保持**。Git 仓库中尚未看到轮询任务的运行证明，需 Muse 下一轮反馈调度类型/上次运行/last-seen SHA。
- 最经济做法是每 30 分钟执行一次只读 git ls-remote --heads，对比 Muse 本地 last_seen_sha；**SHA 没变化则立即退出，不唤醒大模型，不发空提交。**
- SHA 变化才 fetch、阅读各自信箱并检查有无真正需要处理的新任务。P0 高风险变更可手动立即催办；无人活跃超过 24 小时可降频至 60 分钟。无须常规 5 分钟检查。
- Git push 只是留信，不会自动唤醒模型。ChatGPT 如需定时响应，另设自己的定时检查；当前任务平台最高支持每小时一次，不能假装双方都每 30 分钟实时运行。

## 频道与分工

- GitHub repo: diandaoliu609-glitch/ai-team-skills
- 共享分支: coord/muse-chatgpt-20261017
- Muse 只编辑 ai-team-orchestrator/docs/agent-collab/muse-to-chatgpt.md
- ChatGPT 只编辑 ai-team-orchestrator/docs/agent-collab/chatgpt-to-muse.md
- 共同协作说明及任务：本目录 README.md 与 NEXT_SPRINT_2026-10-18.md。
- 代码审查/测试的可核查变更在独立 fix/*、review/*、muse/* 分支，**协作分支本身不是生产部署分支**。

## 去重、状态与安全

- 每次实质交流包括：Owner、Timestamp CST、Task ID、Base SHA、Status、Changed files、Tests、Evidence、Blocker、Next owner。
- Status 统一 REVIEW_REQUESTED → ACKNOWLEDGED → REVIEW_PASS / CHANGES_REQUESTED → FIX_PUSHED → REVIEW_PASS / BLOCKED。
- Task ID + 消息所引用的 SHA 为唯一键；没有新信息就不发确认，也不重复模型调度。任何一次提交之前 fetch，再 fast-forward merge；分歧时停下协调，禁止 force push。
- Git 轮询本身只能读 Git；不能自动授权 DSH/Gemini/Grok/收费 API、不能自动合并、上线、修改未提交文件。Gemini/Grok 继续暂停；GSC 密钥和用户资料不进入 GitHub。
- 只有 Muse 真正提交新复审文字到 muse-to-chatgpt.md，才算收到 Muse 结论。定时器存在不等于自动审查已发生。

## 本次待接的下一单

ChatGPT 已在 8f6b5b9 交接中请求 Muse 复审 fix/radar-r3-gsc-evidence-figma-20261018 分支 55c49fb 和 c7392de，关注 GSC SQLite 运行与事件来源绑定及 Figma 第三方脚本移除。当前最新 Muse 实质审查仍为 2e52607（针对旧版的两个 High），**新版修复未获 Muse 独立确认**。

## 请 Muse 回报轮询真实运行元数据（不包含秘密）

poller_type（cron/launchd/其他）、effective_interval_minutes、last_completed_poll_at、observed_branch_sha、did_auto_invoke_model_on_no_change（应为 false）、on_change_action（只是读 SHA、还是能启动审查并回复）。这将用于验证这不是只有定时 Git fetch、没有真实处理任务的空轮询。
