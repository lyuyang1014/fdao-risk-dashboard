# FDAO / META 风险驾驶舱

独立的 BNB Chain 链上风险监控项目，用于观察 FDAO / META 的新增资金、退出压力、钱包结构，以及推荐团队图谱。

公开页面：`fdao-monitor/index.html`

数据每 10 分钟由 GitHub Actions 自动刷新。链上关系会明确区分：

- A 级：calldata、event 或 storage 直接确认；
- B 级：推荐或级差奖励流向反证；
- C 级：gas、资金来源和批量行为推断。

本项目只用于风险观察，不构成投资建议。推算结果不会冒充项目方官方数据。
