# pi-harness

[English](README.md) | **简体中文**

一个构建在 [PI Agent](https://www.npmjs.com/package/@earendil-works/pi-agent-core) 之上的
可复用 TypeScript Agent 运行时。

pi-harness 为模型响应补充完整的任务运行能力：上下文管理、工具权限、session、memory 来源、
重试、预算、审查和可观测结果。业务功能通过可组合的 Agent Profile 接入，不需要修改通用内核。

## 核心功能

- 原生 tool calling 和 prompted-JSON 工具调用；
- 按 read、write、destructive、network 等级控制工具执行；
- frozen prefix、活动历史和压缩历史三层上下文；
- provider-aware cache 策略与 token/费用报告；
- JSONL session、checkpoint、重试和 session budget；
- 带来源、信任等级和有效期的 memory；
- worker-reviewer 返修闭环和机器可检查的验收标准；
- 脱敏 event log、receipt、trace 和 cache report；
- 面向编程、研究、数据分析和领域产品的可插拔 Agent Profile。

## 快速开始

需要 Node.js 22.19 或更高版本。

```bash
npm install
npm run check
npm test
npx pi-harness
```

执行一次非交互任务：

```bash
node --experimental-strip-types examples/one-shot.ts "Say exactly: ok"
```

输入 TaskContract 并获得 NormalizedResult：

```bash
node --experimental-strip-types src/adapter-run.ts --task-file task.json
```

## Agent Profile

内置 `coding`、`research` 和 `data-analysis`。领域产品可以注册自己的 prompt、工具、
context builder 和 policy，而不修改通用 runtime。

```bash
npm run new-agent -- <name>
```

## 当前可用范围

当前有 500+ 行为测试，并包含驱动真实 PI `AgentHarness` 的 integration tier。JSONL session
已经持久化。默认用户 memory store 仍是进程内实现；持久用户 memory、MCP、运行中持久恢复、
OpenTelemetry 导出、流式事件和通用并行 plan executor 不作为已交付功能介绍。

## 公开仓库内容

公开仓库包含 runtime 源代码、测试、公开文档、示例和不含密钥的配置样例。session、用户 memory、
provider 原始响应、raw trace、conformance 运行输出、费用日志、cache、worktree、凭据和内部
实施计划全部保留在本地。

## 许可证

[MIT](./LICENSE)
