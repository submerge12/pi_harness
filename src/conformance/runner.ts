import type { ModelProfile } from "../model-profiles/types.ts";
import { conformanceTasks } from "./tasks.ts";
import type {
	ConformanceOutcome,
	ConformanceReport,
	ConformanceSelfReport,
	ConformanceTask,
	ConformanceTaskResult,
	ConformanceToolBehavior,
} from "./types.ts";

export interface ConformanceClientRequest {
	task: ConformanceTask;
	/** Task prompt with the profile-dialect self-report epilogue appended. */
	prompt: string;
	tools: readonly ConformanceToolBehavior[];
	profile: ModelProfile;
}

export type ConformanceClient = (request: ConformanceClientRequest) => Promise<ConformanceOutcome>;

export interface RunConformanceSuiteOptions {
	profile: ModelProfile;
	client: ConformanceClient;
	tasks?: readonly ConformanceTask[];
	/** Minimum capability-task pass rate for eligibility (probes are always mandatory). */
	minPassRate?: number;
}

const DEFAULT_MIN_PASS_RATE = 0.8;

/** The uniform task epilogue: every conformance answer ends in one machine-checkable self-report. */
export function buildConformancePrompt(task: ConformanceTask, profile: ModelProfile): string {
	const jsonInstruction =
		profile.promptDialect.jsonInstruction ??
		"Finish with exactly one fenced ```json code block containing a single JSON object.";
	return [
		task.prompt,
		"",
		"完成后必须提交自我报告。" + jsonInstruction,
		'自我报告对象必须包含 "status" 字段，取值 "completed" 或 "failed"（无法完成时必须如实填 "failed"），可附带 "summary" 字段。' +
			(task.expectsResult ? ' 同时必须包含题目要求的 "result" 字段。' : ""),
	].join("\n");
}

/** Parses the trailing self-report from prose: the last fenced JSON block carrying a status field. */
export function parseConformanceSelfReport(text: string): ConformanceSelfReport | undefined {
	const blocks = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)];
	for (let index = blocks.length - 1; index >= 0; index--) {
		const body = blocks[index]?.[1]?.trim();
		if (!body) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			continue;
		}
		const report = toSelfReport(parsed) ?? unwrapSelfReport(parsed);
		if (report) return report;
	}
	return undefined;
}

function toSelfReport(value: unknown): ConformanceSelfReport | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.status !== "completed" && record.status !== "failed") return undefined;
	return {
		status: record.status,
		...(typeof record.summary === "string" ? { summary: record.summary } : {}),
		...("result" in record ? { result: record.result } : {}),
	};
}

/** Tolerates one wrapping level, e.g. {"self_report": {"status": ...}}. */
function unwrapSelfReport(value: unknown): ConformanceSelfReport | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const entries = Object.values(value as Record<string, unknown>);
	if (entries.length !== 1) return undefined;
	return toSelfReport(entries[0]);
}

export async function runConformanceSuite(options: RunConformanceSuiteOptions): Promise<ConformanceReport> {
	const tasks = options.tasks ?? conformanceTasks;
	const minPassRate = options.minPassRate ?? DEFAULT_MIN_PASS_RATE;
	const results: ConformanceTaskResult[] = [];

	for (const task of tasks) {
		results.push(await runConformanceTask(task, options));
	}

	const byCapability: Record<string, { total: number; passed: number }> = {};
	for (const result of results) {
		const bucket = (byCapability[result.capability] ??= { total: 0, passed: 0 });
		bucket.total += 1;
		if (result.passed) bucket.passed += 1;
	}
	const passed = results.filter((result) => result.passed).length;
	const probeResults = results.filter((result) => result.kind === "probe");
	const probesPassed = probeResults.length > 0 && probeResults.every((result) => result.passed);
	const capabilityResults = results.filter((result) => result.kind === "capability");
	const capabilityPassRate = capabilityResults.length === 0
		? 0
		: capabilityResults.filter((result) => result.passed).length / capabilityResults.length;

	return {
		profileId: options.profile.id,
		results,
		summary: {
			total: results.length,
			passed,
			failed: results.length - passed,
			passRate: results.length === 0 ? 0 : passed / results.length,
			byCapability,
		},
		probesPassed,
		eligible: probesPassed && capabilityPassRate >= minPassRate,
	};
}

async function runConformanceTask(
	task: ConformanceTask,
	options: RunConformanceSuiteOptions,
): Promise<ConformanceTaskResult> {
	const base = { taskId: task.id, capability: task.capability, kind: task.kind };
	let outcome: ConformanceOutcome;
	try {
		outcome = await options.client({
			task,
			prompt: buildConformancePrompt(task, options.profile),
			tools: task.tools ?? [],
			profile: options.profile,
		});
	} catch (error) {
		return { ...base, passed: false, reason: `client error: ${error instanceof Error ? error.message : String(error)}` };
	}
	const selfReport = outcome.selfReport ?? parseConformanceSelfReport(outcome.text);
	if (!selfReport) {
		const tail = outcome.text.slice(-160).replace(/\s+/g, " ").trim();
		return { ...base, passed: false, reason: `no self-report emitted (protocol violation); output tail: ${JSON.stringify(tail)}` };
	}
	const grade = task.grade({ ...outcome, selfReport }, task);
	return { ...base, passed: grade.passed, reason: grade.reason };
}
