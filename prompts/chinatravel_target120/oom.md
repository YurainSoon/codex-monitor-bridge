后台监控检测到 ChinaTravel DAV/DDR target120 小批量实验疑似 OOM。

请检查远端日志，确认是否是显存问题；如果是，优先降低 worker 数或模型并发，不要改动实验逻辑。

事件信息：

```json
{{event_json}}
```
