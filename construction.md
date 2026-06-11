# PI Agent LLM Harness 系统架构文档

> **项目名称**: `pi-harness`
> **版本**: 0.1.0
> **运行环境**: Node.js ≥ 22.19 · TypeScript 5.9 · ESM
> **核心依赖**: `@earendil-works/pi-agent-core` · `@earendil-works/pi-ai` · `typebox`

---

## 目录

- [1. 系统概述](#1-系统概述)
- [2. 整体架构](#2-整体架构)
- [3. 项目目录结构](#3-项目目录结构)
- [4. 核心模块详解](#4-核心模块详解)
  - [4.1 Harness 引擎层](#41-harness-引擎层)
  - [4.2 配置系统](#42-配置系统)
  - [4.3 工具系统](#43-工具系统)
  - [4.4 上下文管理](#44-上下文管理)
  - [4.5 缓存策略](#45-缓存策略)
  - [4.6 可观测性 (Observability)](#46-可观测性-observability)
  - [4.7 弹性与容错](#47-弹性与容错)
  - [4.8 会话管理](#48-会话管理)
  - [4.9 Agent 档案系统](#49-agent-档案系统)
  - [4.10 CLI / REPL 交互层](#410-cli--repl-交互层)
  - [4.11 Specializations (遗留层)](#411-specializations-遗留层)
  - [4.12 评估 (Evals) 系统](#412-评估-evals-系统)
- [5. 数据流与生命周期](#5-数据流与生命周期)
- [6. 权限与安全模型](#6-权限与安全模型)
- [7. 技术栈与依赖关系](#7-技术栈与依赖关系)
- [8. 构建与发布](#8-构建与发布)
- [9. 测试体系](#9-测试体系)

---

## 1. 系统概述

`pi-harness` 是一个基于 TypeScript 的轻量级 LLM Agent 运行框架，围绕 **PI Agent** 核心构建。
它为 LLM 会话提供了：

- **Provider 抽象** — 默认使用 DeepSeek（deepseek-v4-pro），支持多 Provider 切换
- **会话持久化** — 以 JSONL 格式存储和恢复会话
- **成本追踪** — 实时统计 token 用量与费用
- **缓存策略** — 通过前缀缓存(prefix cache)优化 API 调用成本
- **工具系统** — 提供文件读写、Shell 执行、网络请求等内置工具，支持沙箱隔离
- **权限控制** — 基于工具访问级别的 allow/ask/deny 权限门控
- **Agent 档案** — 声明式的职业化 Agent 配置（prompt + 工具集 + 策略 + 模型偏好）
- **上下文压缩** — 自动 compaction 以维持上下文窗口利用率
- **弹性机制** — 指数退避重试、优雅中断、崩溃恢复
- **评估框架** — 基于 JSON task 定义的自动化回归测试

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLI / REPL 交互层                           │
│                    (cli/index.ts · repl.ts · renderer.ts)           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐  │
│  │ Agent 档案   │  │ 配置系统      │  │ Specializations (遗留)    │  │
│  │ (profiles)   │──│ (config)     │──│ (specializations)         │  │
│  └──────┬───────┘  └──────┬───────┘  └───────────────────────────┘  │
│         │                 │                                         │
│  ┌──────▼─────────────────▼─────────────────────────────────────┐   │
│  │                 GenericHarness (harness.ts)                   │   │
│  │   ┌────────────────────────────────────────────────────────┐  │   │
│  │   │            PI AgentHarness (@pi-agent-core)            │  │   │
│  │   └────────────────────────────────────────────────────────┘  │   │
│  └──┬──────┬──────────┬───────────┬────────────┬───────────┬────┘   │
│     │      │          │           │            │           │         │
│  ┌──▼──┐┌──▼───┐ ┌────▼────┐ ┌───▼──────┐ ┌──▼─────┐ ┌──▼──────┐  │
│  │工具 ││权限  │ │上下文   │ │可观测性  │ │缓存    │ │弹性     │  │
│  │系统 ││门控  │ │管理     │ │系统      │ │策略    │ │与容错   │  │
│  └──┬──┘└──┬───┘ └────┬────┘ └───┬──────┘ └──┬─────┘ └──┬──────┘  │
│     │      │          │          │            │          │          │
│  ┌──▼──────▼──┐  ┌────▼────┐ ┌───▼──────┐ ┌──▼─────┐ ┌──▼──────┐  │
│  │沙箱       │  │Compac-  │ │Cost/     │ │Cache   │ │Retry/   │  │
│  │(sandbox)  │  │tion     │ │Budget/   │ │Strategy│ │Recovery │  │
│  │           │  │Policy   │ │EventLog  │ │Engine  │ │/Errors  │  │
│  └───────────┘  └─────────┘ └──────────┘ └────────┘ └─────────┘  │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                         会话持久化层                                │
│               (session/factory.ts · recovery.ts · JSONL)            │
├─────────────────────────────────────────────────────────────────────┤
│                    LLM Provider (DeepSeek / 其他)                   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. 项目目录结构

```
G:\pi-harness\
├── src/                          # 核心源代码
│   ├── index.ts                  # 公共 API 导出入口
│   ├── harness.ts                # GenericHarness 核心类 (374 行)
│   ├── config.ts                 # HarnessConfig 类型定义与解析
│   ├── config-file.ts            # 分层配置加载 (项目/用户/CLI)
│   ├── model-resolver.ts         # LLM 模型解析
│   │
│   ├── agents/                   # Agent 档案系统
│   │   ├── profile.ts            # AgentProfile 接口定义
│   │   ├── registry.ts           # 档案注册表
│   │   ├── merge.ts              # 配置合并逻辑
│   │   └── profiles/             # 具体 Agent 档案
│   │       └── _template/        # 新 Agent 脚手架模板
│   │
│   ├── tools/                    # 工具系统
│   │   ├── types.ts              # ToolAccessLevel, PermissionPolicy 等类型
│   │   ├── registry.ts           # ToolRegistry 工具注册表
│   │   ├── permission.ts         # PermissionGate 权限门控
│   │   ├── permission-store.ts   # 权限持久化存储
│   │   ├── sandbox.ts            # 沙箱路径安全 (191 行)
│   │   └── builtin/              # 内置工具集
│   │       ├── index.ts          # createDefaultToolset() 工厂
│   │       ├── read.ts           # 文件读取 (read-only)
│   │       ├── write.ts          # 文件写入 (write)
│   │       ├── edit.ts           # 文件编辑 (write)
│   │       ├── ls.ts             # 目录列表 (read-only)
│   │       ├── grep.ts           # 文本搜索 (read-only)
│   │       ├── glob.ts           # 文件模式匹配 (read-only)
│   │       ├── bash.ts           # Shell 执行 (destructive)
│   │       ├── fetch.ts          # HTTP 请求 (network)
│   │       └── echo.ts           # 测试回显工具
│   │
│   ├── context/                  # 上下文管理
│   │   ├── manager.ts            # ContextManager 上下文修剪
│   │   ├── compaction-policy.ts  # 自动 Compaction 策略
│   │   └── token-budget.ts       # Token 预算分配
│   │
│   ├── cache/                    # 缓存策略
│   │   ├── strategy-engine.ts    # CacheStrategyEngine 决策引擎
│   │   ├── profiles.ts           # 预设缓存配置
│   │   └── types.ts              # 缓存相关类型
│   │
│   ├── observability/            # 可观测性系统
│   │   ├── types.ts              # HarnessEvent, UsageSnapshot 等类型
│   │   ├── cost-tracker.ts       # CostTracker 费用追踪
│   │   ├── budget.ts             # BudgetTracker 预算管控
│   │   ├── event-log.ts          # EventLog JSONL 事件日志
│   │   ├── cache-report.ts       # CacheReportTracker 缓存效果报告
│   │   ├── redact.ts             # 敏感信息脱敏
│   │   └── formatter.ts          # 输出格式化
│   │
│   ├── resilience/               # 弹性与容错
│   │   ├── retry.ts              # withRetry() 指数退避重试
│   │   └── errors.ts             # 错误分类 (fatal vs transient)
│   │
│   ├── session/                  # 会话管理
│   │   ├── factory.ts            # createJsonlSession() 会话工厂
│   │   └── recovery.ts           # JSONL 尾部验证/修复
│   │
│   ├── specializations/          # 遗留 Specialization 层 (已被 agents/ 取代)
│   │   ├── types.ts              # HarnessSpecialization 类型
│   │   └── coding.ts             # Coding Specialization 存根
│   │
│   └── cli/                      # CLI / REPL 层
│       ├── index.ts              # CLI 入口, 参数解析
│       ├── repl.ts               # 交互式 REPL 循环
│       ├── renderer.ts           # 流式输出渲染器
│       ├── signals.ts            # SIGINT 优雅中断
│       ├── cost-display.ts       # 费用展示
│       └── permission-prompt.ts  # 权限交互提示
│
├── test/                         # 单元测试 (11 个测试文件)
│   ├── harness.test.ts
│   ├── tools.test.ts
│   ├── builtin-tools.test.ts
│   ├── context-cache.test.ts
│   ├── resilience.test.ts
│   ├── agents-profile.test.ts
│   ├── agent-profiles-builtins.test.ts
│   ├── session-config-permission.test.ts
│   ├── observability-hardening.test.ts
│   ├── observability-specialization.test.ts
│   └── evals-runner.test.ts
│
├── evals/                        # 评估系统
│   ├── runner.ts                 # 评估运行器 (318 行)
│   ├── types.ts                  # EvalTask, EvalAssertions 类型
│   ├── coding/tasks/             # Coding Agent 评估任务
│   ├── research/tasks/           # Research Agent 评估任务
│   ├── data-analysis/tasks/      # 数据分析 Agent 评估任务
│   └── fixtures/                 # 评估固定工作区
│
├── examples/                     # 使用示例
│   ├── one-shot.ts               # 单次 Prompt 示例
│   └── custom-tool.ts            # 自定义工具示例
│
├── scripts/
│   └── new-agent.mjs             # Agent 档案脚手架生成器
│
├── docs/                         # 文档
│   ├── agent-design-guide.md     # Agent 设计指南
│   └── specialization-guide.md   # Specialization 指南
│
├── dist/                         # 构建输出
├── .github/                      # CI/CD 配置
├── package.json                  # 包描述与脚本
├── tsconfig.json                 # TypeScript 配置 (开发)
├── tsconfig.build.json           # TypeScript 配置 (构建)
├── PLAN.md                       # 生产就绪路线图 (Phase 7-12)
└── PLAN-agents.md                # Agent 定制化路线图 (Phase 13-18)
```

---

## 4. 核心模块详解

### 4.1 Harness 引擎层

**文件**: `src/harness.ts` (374 行 · 系统核心)

`GenericHarness` 是整个系统的中央编排器，封装了 PI Agent 的底层 `AgentHarness`。

```
GenericHarness
├── 封装 AgentHarness (PI Agent Core)
├── 组装各子系统 (工具、权限、上下文、缓存、观测)
├── 管理 prompt 生命周期 (重试 → 预算检查 → 执行 → 后压缩)
└── 暴露模型切换 / Thinking Level 控制 / Compaction 接口
```

**核心职责**:

| 方法 | 职责 |
|------|------|
| `constructor()` | 解析配置、创建内部 `AgentHarness`、注册工具集、安装权限门控、绑定上下文管理器和缓存策略引擎 |
| `prompt(text)` | 执行一次 LLM 对话回合：预算检查 → `withRetry` 包装 → 调用内部 `inner.prompt()` → 错误时回滚 session leaf → 成功后自动 compaction |
| `subscribe()` / `on()` | 事件订阅 (streaming events, tool_call, turn_end 等) |
| `setModel()` | 动态切换 Provider/Model |
| `setThinkingLevel()` | 调整 Reasoning 深度 (off → minimal → low → medium → high → xhigh) |
| `compact()` | 手动触发上下文压缩 |

**辅助工厂**:
- `createGenericHarness(config)` — 创建完整的 Harness 实例（含会话初始化）
- `createGenericHarnessFromSession(config, env, session)` — 从已有会话恢复
- `resolveApiKeyAndHeaders(config)` — API Key 解析（优先配置 → 环境变量）

---

### 4.2 配置系统

**文件**: `src/config.ts` + `src/config-file.ts`

系统采用 **四层配置合并** 策略（优先级从低到高）：

```
内置默认值 < 用户级配置 < 项目级配置 < CLI 参数
     ↓           ↓            ↓          ↓
 (代码硬编码)  (~/.pi-harness  (./pi-harness  (--provider,
              /config.json)    .json)         --model 等)
```

**默认值**:

| 配置项 | 默认值 |
|--------|--------|
| `provider` | `deepseek` |
| `modelId` | `deepseek-v4-pro` |
| `sessionsRoot` | `.pi-harness/sessions` |
| `thinkingLevel` | `off` |
| `read-only` 权限 | `allow` |
| `write` 权限 | `ask` |
| `destructive` 权限 | `ask` |
| `network` 权限 | `ask` |

**配置校验** (config-file.ts):
- 使用 `typebox` 进行 JSON Schema 验证
- **安全策略**: 拒绝任何包含 `apiKey` 字段的配置文件（API Key 只能通过环境变量或 CLI 传入）
- 检测未知字段、嵌套对象校验、清晰的错误路径提示

**`HarnessConfig` 接口涵盖**:

```typescript
{
  cwd, sessionsRoot,            // 工作目录
  provider, modelId, apiKey,    // LLM Provider
  thinkingLevel,                // Reasoning 等级
  systemPrompt,                 // 系统提示词
  tools, activeToolNames,       // 工具配置
  sandbox,                      // 沙箱配置
  policy,                       // 权限策略
  contextWindow, tokenBudgetRatios, compaction,  // 上下文管理
  cache,                        // 缓存策略
  retry,                        // 重试策略
  budget,                       // 费用预算
  eventLog,                     // 事件日志
}
```

---

### 4.3 工具系统

**目录**: `src/tools/`

工具系统由四个层次组成：

```
  ┌──────────────────────────────────────────────┐
  │  ToolRegistry (注册表)                       │
  │  ┌─────────────────────────────────────────┐ │
  │  │ ToolRegistration                        │ │
  │  │  ├── tool: AgentTool (名称/描述/执行器) │ │
  │  │  ├── accessLevel: 访问级别              │ │
  │  │  └── permissionOverride: 权限覆盖       │ │
  │  └─────────────────────────────────────────┘ │
  └──────────────┬───────────────────────────────┘
                 │
  ┌──────────────▼───────────────────────────────┐
  │  PermissionGate (权限门控)                   │
  │  ├── 查找工具注册 → 解析权限级别             │
  │  ├── deny → 直接拒绝                        │
  │  ├── allow → 直接放行                       │
  │  └── ask → 调用 askCallback 询问用户         │
  └──────────────┬───────────────────────────────┘
                 │
  ┌──────────────▼───────────────────────────────┐
  │  Sandbox (沙箱路径安全)                      │
  │  ├── resolveWithinRoot() — 路径限制          │
  │  ├── 处理 Windows 盘符、UNC 路径、../ 逃逸  │
  │  └── 符号链接验证 (canonicalPath)            │
  └──────────────────────────────────────────────┘
```

#### 内置工具集

| 工具 | 访问级别 | 功能 |
|------|----------|------|
| `read` | `read-only` | 读取文件内容，输出自动截断 |
| `ls` | `read-only` | 列出目录内容 |
| `grep` | `read-only` | 在文件中搜索文本 |
| `glob` | `read-only` | 按模式匹配搜索文件 |
| `write` | `write` | 写入文件 |
| `edit` | `write` | 编辑现有文件 |
| `bash` | `destructive` | 执行 Shell 命令 (PowerShell on Windows)，默认超时 120s |
| `fetch` | `network` | HTTP GET 请求，响应大小限制 |
| `echo` | `read-only` | 测试用回显工具 |

**沙箱安全特性**:
- 所有文件操作通过 `ExecutionEnv` 抽象，不直接使用 `node:fs`
- 路径解析防止 `../` 逃逸攻击
- 显式处理 Windows 驱动器号 (`C:\`)、UNC 路径 (`\\server\share`)、驱动器相对路径 (`C:foo`)
- 输出截断防止上下文膨胀（默认 30,000 字符）

---

### 4.4 上下文管理

**目录**: `src/context/`

上下文管理分为两个层次：

#### ContextManager (manager.ts)
- 挂接到 AgentHarness 的 `context` 事件钩子
- 当上下文 token 数超过窗口限制时，执行**消息对级别的修剪**
- 保证 tool_call 和 tool_result 消息对不会被拆分（防止 Provider 400 错误）
- 使用**分块策略** (chunk-based)：将 assistant tool_call + tool results + assistant response 作为原子单元
- 从尾部向头部逆序保留消息，确保最新上下文优先

#### CompactionPolicy (compaction-policy.ts)
- 在每个 turn 结束后检查 token 使用量
- 当超过高水位线时，调用 PI Agent Core 的原生 `compact()` 方法
- 产生摘要条目（Tier 2 "冷"存储），保持 prompt 前缀稳定
- 前缀稳定性 → 有利于 DeepSeek 的前缀缓存命中

#### TokenBudget (token-budget.ts)
- 定义 token 预算分配比例（warm/cold/system/reserve）
- 可由 Agent Profile 按职业定制（如 research agent 可能需要更大的冷存储比例）

---

### 4.5 缓存策略

**目录**: `src/cache/`

```
CacheStrategyEngine
├── 基于 CacheProfile 做每次请求的缓存决策
├── 记录决策 (onDecision callback)
└── 绑定到 AgentHarness 事件流

CacheProfile (profiles.ts)
├── 预设的缓存策略配置
└── 影响 streamOptions.cacheRetention 参数
```

**核心目标**: 利用 DeepSeek 的自动前缀缓存 (automatic prefix cache) 实现 **120 倍的 cacheRead 成本节省**。通过保持 prompt 前缀稳定（不频繁修剪上下文的头部），最大化缓存命中率。

---

### 4.6 可观测性 (Observability)

**目录**: `src/observability/`

| 模块 | 职责 |
|------|------|
| **CostTracker** | 逐 turn 记录 token 用量 (input/output/cacheRead/cacheWrite) 和费用，计算缓存命中率 |
| **BudgetTracker** | 会话级费用预算控制：warn 阈值提示，hard cap 拒绝新 turn |
| **EventLog** | 将所有 Harness 事件以 JSONL 格式追加写入 `.pi-harness/sessions/<id>.events.jsonl` |
| **CacheReportTracker** | 对比缓存策略决策与实际缓存命中率，检测前缀失效回退 |
| **Redact** | 脱敏处理：掩盖匹配 `/key|token|secret|password|authorization/i` 的值和 `Bearer` 令牌 |
| **Formatter** | 将 CostSummary 格式化为人类可读文本 |

**数据流**:
```
AgentHarness Events
    ↓ subscribe()
GenericHarness 内部分发
    ├── → BudgetTracker.handleEvent()
    ├── → CostTracker.handleEvent()
    ├── → CacheReportTracker.recordTurn()
    └── → EventLog.handleEvent()  →  [Redact]  →  JSONL 文件
```

---

### 4.7 弹性与容错

**目录**: `src/resilience/`

#### Retry (retry.ts)
- `withRetry()` 包装器：指数退避 + 全抖动 (full jitter)
- 默认 4 次尝试
- 遵循 `Retry-After` 响应头
- 通过 `onRetry` 回调发送 `retry` 事件（REPL 可显示 "retrying (2/4) in 3.2s…"）

#### Errors (errors.ts)
- **致命错误** (no retry): 401/403/400 → 清晰的错误信息，指向对应 Provider 的环境变量名
- **暂态错误** (retry): 408/429/5xx/网络错误

#### 错误处理流程
```
prompt() 调用
    │
    ├── 保存 session leafId (回滚点)
    │
    ├── withRetry() 包装 ──→ inner.prompt()
    │       │
    │       ├── 成功 → 检查 stopReason
    │       │     ├── "error" → 提取 HTTP status → 判断 fatal/transient
    │       │     └── 正常 → 返回 AssistantMessage
    │       │
    │       └── 异常 → 回滚 session leaf → 抛出/重试
    │
    └── compactAfterTurn() 后压缩检查
```

---

### 4.8 会话管理

**目录**: `src/session/`

| 文件 | 职责 |
|------|------|
| `factory.ts` | `createJsonlSession()` — 创建 JSONL 格式的会话存储，支持 `open` (恢复) 和 `list` (发现) |
| `recovery.ts` | JSONL 尾部验证 — 检测并修复因崩溃导致的截断写入 |

**会话存储位置**: `.pi-harness/sessions/` (可配置)

**会话生命周期**:
```
create  →  prompt/turn_end  →  (crash?) recovery  →  resume (--continue/--resume <id>)
   ↓            ↓                     ↓                    ↓
 新 JSONL    追加消息              修复尾部              重新加载
```

---

### 4.9 Agent 档案系统

**目录**: `src/agents/`

Agent 档案系统是 pi-harness 的**定制化核心**。一个 Agent 是一个**声明式配置**，而不是子类：

```typescript
interface AgentProfile {
  name: string;                           // 档案名称
  description: string;                    // 描述
  systemPrompt: string;                   // 系统提示词
  tools?: AgentToolDefinition[];          // 工具集 (静态定义或工厂函数)
  policy?: PermissionPolicy;              // 权限策略
  model?: { provider, modelId };          // 模型偏好
  thinkingLevel?: ThinkingLevel;          // Reasoning 等级偏好
  context?: {                             // 上下文调优
    ratios?: TokenBudgetRatios;           //   - Token 预算比例
    compactionInstructions?: string;      //   - Compaction 摘要指引
  };
  install?: (harness) => disposer;        // 编程式钩子 (逃生通道)
}
```

**档案注册表** (`registry.ts`):
- `registerProfile(profile)` — 注册（重名抛错）
- `getProfile(name)` — 按名查找
- `listProfiles()` — 列出全部

**配置合并** (`merge.ts`):
- 合并优先级: 内置默认 < Agent Profile < 项目配置文件 < CLI 参数
- 系统提示词使用 `mergeSystemPrompts()` 语义合并

**脚手架生成器** (`scripts/new-agent.mjs`):
```bash
npm run new-agent -- research
# → 拷贝 src/agents/profiles/_template/ 到 src/agents/profiles/research/
# → 打印注册步骤
```

---

### 4.10 CLI / REPL 交互层

**目录**: `src/cli/`

| 文件 | 职责 |
|------|------|
| `index.ts` | CLI 入口：参数解析、`--agent`/`--resume`/`--continue`/`--list-sessions` |
| `repl.ts` | 交互式 REPL 循环 + 斜杠命令处理 |
| `renderer.ts` | 流式输出渲染（streaming text/tool calls） |
| `signals.ts` | SIGINT 优雅处理：第一次 Ctrl+C → abort turn，第二次 → 退出 |
| `cost-display.ts` | 费用展示组件 |
| `permission-prompt.ts` | 工具权限交互提示（y/n/a/d） |

**REPL 斜杠命令**:

| 命令 | 功能 |
|------|------|
| `/cost` | 显示会话费用和缓存命中摘要 |
| `/cache` | 显示缓存策略预期 vs 实际命中率 |
| `/sessions` | 列出持久化会话 |
| `/model [provider/model]` | 查看/切换模型 |
| `/thinking [level]` | 查看/切换 Thinking 等级 |
| `/compact [instructions]` | 手动压缩上下文 |
| `/quit` `/q` `/exit` | 退出 |

---

### 4.11 Specializations (遗留层)

**目录**: `src/specializations/`

> ⚠️ 此层已被 `src/agents/` 的 AgentProfile 系统取代，保留为向后兼容的废弃导出。

- `types.ts` — 定义 `HarnessSpecialization`、`SpecializableHarnessConfig`、`createSpecializedHarness()` 等
- `coding.ts` — Coding Specialization 存根

---

### 4.12 评估 (Evals) 系统

**目录**: `evals/`

评估系统用于 Agent 质量的回归测试和基准测试。

**Task 定义** (JSON):
```json
{
  "name": "task-name",
  "prompt": "要发送给 Agent 的指令",
  "fixture": { "files": { "path": "content" } },
  "assertions": {
    "files": [{ "path": "file.ts", "contains": "expected" }],
    "outputMatch": "正则匹配 Agent 输出",
    "forbiddenTools": ["bash"],
    "maxTurns": 5,
    "maxUsd": 0.50
  }
}
```

**执行流程** (`runner.ts`):
```
loadEvalTask(path)
    ↓
prepareWorkspace()   ← 复制 fixture 到临时目录
    ↓
executor()           ← 用 Agent 执行 prompt
    ↓
collectFailures()    ← 断言检查
    ├── checkOutput()         — 输出正则匹配
    ├── checkForbiddenTools() — 禁止工具使用检查
    ├── checkLimits()         — turn 数 / 费用限制
    └── checkFiles()          — 文件内容断言
    ↓
buildResult() → EvalRunResult (含 markdown 报告)
```

**两级评估策略**:
1. **框架评估** (offline) — 使用 mock transport，CI 上每个 PR 运行
2. **质量评估** (online) — 使用真实 Provider，需要 API Key，夜间运行

---

## 5. 数据流与生命周期

### 一次完整的 Prompt 调用链

```
用户输入
  │
  ▼
CLI/REPL ─── prompt(text) ──→ GenericHarness
                                    │
                        ┌───────────┼───────────────┐
                        ▼           ▼               ▼
                  BudgetTracker  withRetry()    CompactionPolicy
                  预算检查        重试包装        后置压缩
                        │           │
                        │     ┌─────▼─────┐
                        │     │ 保存 leaf  │
                        │     │ (回滚点)   │
                        │     └─────┬─────┘
                        │           ▼
                        │    AgentHarness.prompt()
                        │           │
                        │     ┌─────▼────────────┐
                        │     │ "context" 事件    │──→ ContextManager
                        │     │  上下文修剪       │    (超限时 trim)
                        │     └─────┬────────────┘
                        │           ▼
                        │     ┌─────▼────────────┐
                        │     │ CacheStrategy     │──→ 设置缓存参数
                        │     │  缓存决策         │
                        │     └─────┬────────────┘
                        │           ▼
                        │    ┌──────▼──────────┐
                        │    │  LLM API 调用   │
                        │    │  (DeepSeek 等)   │
                        │    └──────┬──────────┘
                        │           ▼
                        │     ┌─────▼────────────┐
                        │     │ "tool_call" 事件  │──→ PermissionGate
                        │     │  工具调用权限检查  │   (allow/ask/deny)
                        │     └─────┬────────────┘
                        │           ▼
                        │     ┌─────▼────────────┐
                        │     │ 工具执行          │──→ Sandbox 安全检查
                        │     │ (Builtin Tools)   │
                        │     └─────┬────────────┘
                        │           ▼
                        │     ┌─────▼────────────┐
                        │     │ "turn_end" 事件   │
                        │     └─────┬────────────┘
                        │           │
                        ▼           ▼
                  ┌─────────────────────────────────┐
                  │  事件分发                        │
                  │  ├── CostTracker.handleEvent()  │
                  │  ├── BudgetTracker.handleEvent() │
                  │  ├── CacheReport.recordTurn()   │
                  │  └── EventLog.handleEvent()     │
                  └─────────────────────────────────┘
                        │
                        ▼
               CompactionPolicy 检查
               (是否需要 compact？)
                        │
                        ▼
               返回 AssistantMessage
```

---

## 6. 权限与安全模型

### 工具访问级别 (ToolAccessLevel)

```
 最低风险                                  最高风险
    ├─────────────┼──────────────┼──────────────┤
  read-only      network       write       destructive
  (文件读取)    (HTTP 请求)  (文件写入)    (Shell 执行)
```

### 权限决策级别 (PermissionLevel)

| 级别 | 行为 |
|------|------|
| `allow` | 静默放行 |
| `ask` | 运行时询问用户 (y/n/a/d) |
| `deny` | 直接拒绝，返回错误信息给 LLM |

### 权限解析优先级

```
工具级覆盖 (permissionOverride)
    ↓ stricterPermission()
策略配置 (policy.tools[name] ?? policy.defaults[accessLevel])
    ↓
最终决策: allow / ask / deny
```

### 沙箱安全

- 所有路径通过 `resolveWithinRoot()` 验证
- 防御 `../` 目录遍历、绝对路径逃逸、Windows 特殊路径
- 符号链接通过 `canonicalPath` 解析后再次验证
- 工具输出截断防止上下文注入攻击

---

## 7. 技术栈与依赖关系

### 生产依赖

| 包 | 版本 | 用途 |
|----|------|------|
| `@earendil-works/pi-agent-core` | 0.76.0 | PI Agent 核心：AgentHarness、Session、ExecutionEnv、Tool 定义 |
| `@earendil-works/pi-ai` | 0.76.0 | LLM Provider 抽象：模型注册表、API Key 解析、Known Provider 类型 |
| `typebox` | 1.1.38 | JSON Schema 类型定义与运行时校验 |

### 开发依赖

| 包 | 版本 | 用途 |
|----|------|------|
| `typescript` | 5.9.3 | 类型检查与编译 |
| `vitest` | 3.2.4 | 测试框架 |
| `@types/node` | 24.12.4 | Node.js 类型定义 |

### Node.js 特性使用

- `node:readline/promises` — REPL 交互
- `node:path` (win32/posix) — 跨平台路径处理
- `node:fs/promises` — 文件 I/O
- `--experimental-strip-types` — 直接运行 `.ts` 文件

---

## 8. 构建与发布

```bash
# 类型检查
npm run typecheck    # tsc --noEmit

# 构建发布包
npm run build        # tsc -p tsconfig.build.json → dist/

# 运行测试
npm test             # vitest --run

# 完整检查
npm run check        # = npm run typecheck
```

**发布结构**:
```
dist/
├── index.js        # 库入口 (ESM)
├── index.d.ts      # 类型声明
├── cli/
│   ├── index.js    # CLI 入口 (bin: pi-harness)
│   └── index.d.ts
└── ...             # 其他模块
```

**包导出映射**:
```json
{
  ".":     { "import": "./dist/index.js",     "types": "./dist/index.d.ts" },
  "./cli": { "import": "./dist/cli/index.js", "types": "./dist/cli/index.d.ts" }
}
```

---

## 9. 测试体系

### 测试文件概览

| 测试文件 | 覆盖模块 |
|----------|----------|
| `harness.test.ts` | GenericHarness 核心逻辑 |
| `tools.test.ts` | ToolRegistry + PermissionGate |
| `builtin-tools.test.ts` | 内置工具集 + Sandbox |
| `context-cache.test.ts` | ContextManager + CacheStrategy |
| `resilience.test.ts` | Retry + 错误分类 |
| `agents-profile.test.ts` | AgentProfile + 注册表 |
| `agent-profiles-builtins.test.ts` | Agent 内置档案 |
| `session-config-permission.test.ts` | 会话 + 配置 + 权限集成 |
| `observability-hardening.test.ts` | 可观测性强化 |
| `observability-specialization.test.ts` | Specialization 可观测性 |
| `evals-runner.test.ts` | 评估运行器 |

### 测试策略

- **单元测试**: 使用 mock transport (scripted pi-ai transport)，离线运行
- **集成冒烟**: 端到端测试 (需 `DEEPSEEK_API_KEY`)，验证真实 API 调用
- **评估测试**: 基于 fixture 工作区的 Agent 行为回归测试
- **跨平台**: CI 同时在 `windows-latest` 和 `ubuntu-latest` 上运行

---

> 📄 **文档版本**: 2026-06-10 · 基于 pi-harness v0.1.0 源代码分析生成
