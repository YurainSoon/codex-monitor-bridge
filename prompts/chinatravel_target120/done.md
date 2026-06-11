后台监控事件：ChinaTravel DAV/DDR target120 小批量实验进程已经结束。

请用中文继续完成收尾：检查远端进程是否正常退出，读取 master 日志尾部，确认 `SUMMARY_PATH` 和 `SCORE_PATH`，读取对应 summary JSON 和 score JSON，并和基线 selection JSON 对比，总结 hard constraints、overall score、完成数量、DAV、DDR、ATT，以及相较旧 904 结果中这 120 个样例的改善情况。如果日志显示失败或结果不完整，先定位原因，再给出下一步处理方案。

事件信息：

```json
{{event_json}}
```
