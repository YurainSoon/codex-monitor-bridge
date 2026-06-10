后台监控检测到疑似 OOM。

请用中文说明：当前任务可能因为显存或内存不足失败。请接下来检查日志，并优先通过降低训练 batch size、gradient accumulation、序列长度或并发 worker 数来避免 OOM。不要改动和 OOM 无关的实验逻辑。

事件信息：

```json
{{event_json}}
```
