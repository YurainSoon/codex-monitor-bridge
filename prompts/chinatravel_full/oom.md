后台监控事件：ChinaTravel 全量实验疑似发生 OOM。

请检查远程日志尾部，优先判断是哪一个 vLLM 实例或 runner 触发 OOM。不要改动 agent 策略逻辑；优先考虑降低 runner 并行度、降低 vLLM `max-num-seqs`，或临时移除故障端口。

事件信息：

```json
{{event_json}}
```
