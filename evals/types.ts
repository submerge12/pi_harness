export type EvalStatus = "passed" | "failed";

export interface EvalPathFixture {
	path: string;
}

export interface EvalInlineFixture {
	files: Record<string, string>;
}

export type EvalFixture = string | EvalPathFixture | EvalInlineFixture;

export interface EvalFileAssertion {
	path: string;
	exists?: boolean;
	equals?: string;
	contains?: string;
	matches?: string;
}

export interface EvalAssertions {
	files?: EvalFileAssertion[];
	outputMatch?: string | string[];
	forbiddenTools?: string[];
	allowedWriteRoots?: string[];
	maxTurns?: number;
	maxUsd?: number;
}

export interface EvalTask {
	name?: string;
	prompt: string;
	fixture: EvalFixture;
	assertions: EvalAssertions;
}

export interface EvalExecutorContext {
	task: EvalTask;
	taskPath: string;
	workspacePath: string;
	prompt: string;
}

export interface EvalToolCall {
	name: string;
	input?: Record<string, unknown>;
}

export interface EvalExecutionResult {
	output: string;
	toolCalls?: EvalToolCall[];
	turns?: number;
	costUsd?: number;
	cacheHitRate?: number;
}

export type EvalExecutor = (context: EvalExecutorContext) => EvalExecutionResult | Promise<EvalExecutionResult>;

export interface EvalRunResult {
	task: EvalTask;
	taskPath: string;
	workspacePath: string;
	status: EvalStatus;
	failures: string[];
	output: string;
	toolCalls: EvalToolCall[];
	turns: number;
	costUsd: number;
	cacheHitRate?: number;
	markdown: string;
}
