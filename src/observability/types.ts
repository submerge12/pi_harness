export interface UsageCostSnapshot {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface UsageSnapshot {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: UsageCostSnapshot;
}

export interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: UsageCostSnapshot;
}

export interface TurnCost {
	turnIndex: number;
	usage: UsageSnapshot;
	cacheHitRate: number;
	toolResultCount: number;
}

export interface CostSummary {
	turnCount: number;
	usage: UsageSnapshot;
	cacheHitRate: number;
}

export interface HarnessEventBase {
	type: string;
	[key: string]: unknown;
}

export interface TurnEndEvent extends HarnessEventBase {
	type: "turn_end";
	message: unknown;
	toolResults?: readonly unknown[];
}

export interface MessageUpdateEvent extends HarnessEventBase {
	type: "message_update";
	message?: unknown;
	assistantMessageEvent?: unknown;
}

export interface ToolExecutionStartEvent extends HarnessEventBase {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args?: unknown;
}

export interface ToolExecutionEndEvent extends HarnessEventBase {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result?: unknown;
	isError?: boolean;
}

export type HarnessEvent =
	| TurnEndEvent
	| MessageUpdateEvent
	| ToolExecutionStartEvent
	| ToolExecutionEndEvent
	| HarnessEventBase;

export interface HarnessEventSource {
	subscribe(listener: (event: HarnessEvent, signal?: AbortSignal) => Promise<void> | void): () => void;
}
