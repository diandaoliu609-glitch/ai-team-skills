# AI Team / Radar｜Muse × ChatGPT 协作工作板

更新时间：2026-10-18。共享 GitHub 是异步信箱，不是自动互聊。

## 当前目标
**停用 Gemini；保留 5 个已在线 Worker；停止重复修复 DSH/H2；集中实现 Radar 真正可操作，推进 R3 真实验收。**

| 模块 | 当前事实 | 下一关 |
|---|---|---|
| Gemini | 已暂停；Bridge configured=false、queueable=false、available=false | 不再登录/请求模型 |
| Grok | 已禁用 | 维持 |
| DSH 0.7.6 | Muse 独立审查通过；真实任务已完成；持续在线 | 受控参与 Radar P0 |
| Radar H2 | 44f0d49 防落库代码与负面测试 PASS | 当前服务是否部署尚待确认 |
| Radar 页面 8787 | HTTP 200 | 实际浏览器可操作性尚未通过 |
| Radar R3 | 0/4 真实关通过，准备状态完成 | 真人标注、GSC 授权真实数据、伙伴体验、原生/实验对照 |

**详情与验收标准见 NEXT_SPRINT_2026-10-18.md。**
**最新交接读取 chatgpt-to-muse.md 与 muse-to-chatgpt.md。**

## 分工
Muse：优先审查 GSC 第一方证据门禁、Dashboard UI 合同，输出具体风险行号与离线负面测试；回复 muse-to-chatgpt.md。
ChatGPT：Mac 真实浏览器交互、H2 服务版本验证、DSH 小步派工与集成复测。
DSH：只做限定范围内可证明的修复，仍每轮检查免费价格。
Gemini/Grok：不派任务、不调用 API。

## 协作纪律
- Muse 仅更新 muse-to-chatgpt.md 或独立 muse/* 分支；ChatGPT 更新 chatgpt-to-muse.md、计划与工作板。先 fetch，再合并，禁止强推。
- 所有结论附 Owner、时间、Changed files、Tests、Evidence、Blocker、Next owner；未证实写 NOT VERIFIED。
- GitHub 更新本身不会唤醒 Muse；只有 Muse 下次被调用并亲自读取/回复后才算收到确认。
- 禁止向 GitHub 上传 API Key、OAuth、用户数据和 Mac 本地凭据。
