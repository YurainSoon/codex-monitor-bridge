后台监控事件：ChinaTravel failed37 1200s 调试进程已经结束。

请用中文继续完成收尾：

1. 检查远端进程是否正常退出，读取 master 日志尾部。
2. 确认日志里的 `SUMMARY_PATH` 和 `SCORE_PATH`；如果存在，读取对应 summary JSON 和 score JSON。
3. 读取 37 个样本对应的结果 JSON 和 timing JSONL，重点区分耗时来源：
   - LLM generate / complete_json / complete_text
   - candidate search / rerank / planner delegate
   - final validation / fallback
   - external timeout
   - scoring 或 hard-constraint 规则问题
4. 总结完成数量、通过数量、失败样本列表、每类失败原因，以及是否还有需要重跑的样本。
5. 如果日志显示失败或结果不完整，先定位原因，再给出下一步处理方案。不要直接开始新的优化，先向用户报告判断结果。

关键路径：

- split: `/root/data1/projects/ChinaTravel/competition_score_worktree/chinatravel/evaluation/default_splits/failed37_1200_debug.txt`
- timing dir: `/root/data1/projects/ChinaTravel/competition_score_worktree/cache/LLMTravelAgent_timing/Qwen3.5-4B_candidate_rerank`

事件信息：

```json
{{event_json}}
```
