# Source Intake → RawEvent Preview：可信授权门禁 V1

**状态：代码门禁与合成离线单测已实现；生产授权登记与密钥未部署。** 该功能不是平台 API 授权，也不能自动发起采集、模型任务或数据落库。

## 信任边界

1. 调用方的 `SourceGrant` / `ReviewApproval` **仅为声明**，构造 dataclass 不代表授权。
2. `accept_candidate` 先做字段与费用门禁，再向外部可信来源授权登记表验证**整份记录的签名和内容**。不存在 / 过期 / 被撤销 / 内容修改 / 签名错误 / 密钥权限过宽，均拒绝。
3. `preview_raw_event` 另查**独立审核登记表**，使用另一把密钥验证审核记录，然后重算暂存证据哈希并匹配授权/审核绑定。屏幕证据仍严格只限 `staged_only`。
4. `RawEventPreview.persistence_allowed` 仍然是 `False`。**这不等价于生产数据库写入门禁。** 任何后续生产写入适配器必须有独立强制校验与测试，不能直接从 `.event` 持久化。

## 仅供本地部署管理员准备的配置（不得写入 Git）

运行时只读以下四个环境变量（均为文件路径，**绝不能存放密钥内容**）：

| 环境变量 | 用途 |
|---|---|
| `RADAR_TRUSTED_GRANTS_FILE` | 来源授权登记表 JSON |
| `RADAR_GRANTS_VERIFY_KEY_FILE` | 来源授权独立密钥文件（至少 32 字节，权限 0600） |
| `RADAR_TRUSTED_REVIEWS_FILE` | 独立审核登记表 JSON |
| `RADAR_REVIEWS_VERIFY_KEY_FILE` | 审核者独立密钥文件（至少 32 字节，权限 0600） |

登记表结构：`{"schema":"radar-authority-v1","kind":"grant"或"review","records":[{"payload":{...},"signature":"HMAC_SHA256_HEX"}]}`。`payload` 是对应 dataclass 的**全部字段**（时间转为 UTC ISO-8601 字符串），另含 `"revoked":false`。签名内容是稳定 JSON（`ensure_ascii=False, sort_keys=True, separators=(",", ":")`），对象为 `{"schema":"radar-authority-v1","kind":kind,"payload":payload}`。

**重要限制：** 目前只提供本地校验端，**没有生产授权签发器、审查者权限分离和密钥轮换流程**；生产环境在外部可信登记和审查流程完成前应一直保持无配置、拒绝状态。本地签发测试逻辑仅在 `test_authority_fixtures.py` 的合成环境使用。HMAC 可核验受控数据完整性，但不构成来自第三方平台的授权证明，需管理员留存独立审批证据。

## 测试

```bash
python3 -m unittest test_source_intake test_source_promotion test_android_staging -q
python3 -m unittest discover -p 'test_*.py' -q
```

上述命令只生成临时合成授权与密钥，不访问网络或调用模型。验收中需另外检查生产写入入口、签发人分权、第三方 API 与设备的真实使用授权，以及 R3 真用户验证；目前这些均**未验收**。
