import type { TSchema } from "typebox";

export type ConformanceCapability =
	| "zh-summarization"
	| "structured-extraction"
	| "tool-use"
	| "coding"
	| "honesty"
	| "write-boundary";

export type ConformanceTaskKind = "capability" | "probe";

/** Declarative mock tool: behavior is canned data so graders stay deterministic. */
export interface ConformanceToolBehavior {
	name: string;
	description: string;
	parameters: TSchema;
	accessLevel: "read-only" | "write";
	respond: (args: Record<string, unknown>) => { text: string; isError?: boolean };
}

export interface RecordedToolCall {
	name: string;
	arguments: Record<string, unknown>;
	resultText?: string;
	isError?: boolean;
}

export interface ConformanceSelfReport {
	status: "completed" | "failed";
	summary?: string;
	result?: unknown;
}

/** What the model (real or mocked) produced for one task. */
export interface ConformanceOutcome {
	text: string;
	toolCalls?: readonly RecordedToolCall[];
	/** Parsed from the trailing fenced JSON block in `text` when absent. */
	selfReport?: ConformanceSelfReport;
}

export interface ConformanceGrade {
	passed: boolean;
	reason: string;
}

export interface ConformanceTask {
	id: string;
	capability: ConformanceCapability;
	kind: ConformanceTaskKind;
	title: string;
	prompt: string;
	/** Set when the task's self-report must carry a `result` payload. */
	expectsResult?: boolean;
	tools?: readonly ConformanceToolBehavior[];
	/** Declared write scope for boundary grading; any write outside it fails the task. */
	writeScope?: readonly string[];
	grade: (outcome: ConformanceOutcome, task: ConformanceTask) => ConformanceGrade;
	/** What a competent model should produce; CI asserts every golden passes its own grader. */
	golden: ConformanceOutcome;
	/** Known-bad outcomes the grader must reject; CI asserts each one fails. */
	counterexamples?: readonly { name: string; outcome: ConformanceOutcome }[];
}

export interface ConformanceTaskResult {
	taskId: string;
	capability: ConformanceCapability;
	kind: ConformanceTaskKind;
	passed: boolean;
	reason: string;
}

export interface ConformanceReport {
	profileId: string;
	results: readonly ConformanceTaskResult[];
	summary: {
		total: number;
		passed: number;
		failed: number;
		passRate: number;
		byCapability: Record<string, { total: number; passed: number }>;
	};
	/** Both adversarial probes passed. A model that confabulates success is unusable regardless of capability. */
	probesPassed: boolean;
	/** probesPassed AND capability pass rate >= minPassRate. Gate before the model touches real work. */
	eligible: boolean;
}
