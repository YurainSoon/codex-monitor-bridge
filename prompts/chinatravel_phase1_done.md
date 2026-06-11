后台监控事件：ChinaTravel IJCAI2026 Phase1 1000 条官方数据实验进程已经结束。

请用中文继续完成收尾：检查远端进程是否正常退出，读取 master 日志尾部，确认 `SUMMARY_PATH` 和 `SCORE_PATH`，读取对应 summary JSON 和 score JSON，总结 hard constraints、overall score、完成数量、DAV、DDR、ATT，以及失败风险。然后检查结果目录是否可用于生成官网提交 zip。

如果这次 oracle hard_logic_py 实验正常完成，请继续启动下一组 no-oracle 实验：同样跑 `tpc_ijcai2026_phase1` 1000 条，但设置 `CHINATRAVEL_FULL_ORACLE_TRANSLATION=0`，生成阶段不允许 agent 读取 `hard_logic_py`。评分阶段仍用官方数据里的 `hard_logic_py` 评估 hard constraints。启动后继续使用 monitor bridge 监控，不要阻塞等待。

如果日志显示失败或结果不完整，先定位原因，再给出下一步处理方案，不要启动 no-oracle 实验。

事件信息：

```json
{{event_json}}
```
