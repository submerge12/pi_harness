import { describe, expect, it } from "vitest";
import {
	buildConformancePrompt,
	conformanceProbes,
	conformanceTasks,
	honestyProbe,
	parseConformanceSelfReport,
	runConformanceSuite,
	writeBoundaryProbe,
	type ConformanceClient,
	type ConformanceOutcome,
	type ConformanceTask,
} from "../../src/conformance/index.ts";
import { deepSeekV4ProProfile } from "../../src/model-profiles/index.ts";

function clientFromOutcomes(outcomes: (task: ConformanceTask) => ConformanceOutcome): ConformanceClient {
	return async ({ task }) => outcomes(task);
}

const goldenClient = clientFromOutcomes((task) => task.golden);

describe("conformance task inventory", () => {
	it("has at least five tasks per capability and always both adversarial probes", () => {
		const byCapability = new Map<string, number>();
		for (const task of conformanceTasks) {
			byCapability.set(task.capability, (byCapability.get(task.capability) ?? 0) + 1);
		}
		for (const capability of ["zh-summarization", "structured-extraction", "tool-use", "coding"]) {
			expect(byCapability.get(capability) ?? 0, capability).toBeGreaterThanOrEqual(5);
		}
		const probes = conformanceTasks.filter((task) => task.kind === "probe");
		expect(probes.map((task) => task.id).sort()).toEqual(["probe-honesty", "probe-write-boundary"]);
		expect(conformanceProbes).toHaveLength(2);
	});

	it("has unique task ids", () => {
		const ids = conformanceTasks.map((task) => task.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("every golden outcome passes its own grader and every counterexample fails", () => {
		for (const task of conformanceTasks) {
			const golden = task.grade(task.golden, task);
			expect(golden.passed, `${task.id} golden: ${golden.reason}`).toBe(true);
			for (const counterexample of task.counterexamples ?? []) {
				const grade = task.grade(counterexample.outcome, task);
				expect(grade.passed, `${task.id} counterexample ${counterexample.name} should fail`).toBe(false);
			}
		}
	});
});

describe("conformance prompt protocol", () => {
	it("appends the profile's JSON dialect and the honest-failure requirement", () => {
		const prompt = buildConformancePrompt(honestyProbe, deepSeekV4ProProfile);
		expect(prompt).toContain(honestyProbe.prompt);
		expect(prompt).toContain(deepSeekV4ProProfile.promptDialect.jsonInstruction!);
		expect(prompt).toContain('"failed"');
	});

	it("parses the trailing fenced self-report from prose", () => {
		const text = [
			"分析完成。",
			"```json",
			'{"intermediate": true}',
			"```",
			"最终报告：",
			"```json",
			'{"status": "completed", "summary": "done", "result": {"summary": "好"}}',
			"```",
		].join("\n");
		expect(parseConformanceSelfReport(text)).toEqual({
			status: "completed",
			summary: "done",
			result: { summary: "好" },
		});
		expect(parseConformanceSelfReport("no json here")).toBeUndefined();
	});

	it("tolerates one wrapping level around the self-report", () => {
		const text = '```json\n{"self_report": {"status": "failed", "summary": "无法完成"}}\n```';
		expect(parseConformanceSelfReport(text)).toEqual({ status: "failed", summary: "无法完成" });
		const invalid = '```json\n{"status": "success"}\n```';
		expect(parseConformanceSelfReport(invalid)).toBeUndefined();
	});
});

describe("runConformanceSuite", () => {
	it("marks a fully competent (golden) model eligible", async () => {
		const report = await runConformanceSuite({
			profile: deepSeekV4ProProfile,
			client: goldenClient,
		});
		expect(report.profileId).toBe(deepSeekV4ProProfile.id);
		expect(report.summary.total).toBe(conformanceTasks.length);
		expect(report.summary.failed).toBe(0);
		expect(report.probesPassed).toBe(true);
		expect(report.eligible).toBe(true);
	});

	it("rejects a success-confabulating model via the honesty probe even at full capability", async () => {
		const client = clientFromOutcomes((task) =>
			task.id === "probe-honesty" ? honestyProbe.counterexamples![0]!.outcome : task.golden,
		);
		const report = await runConformanceSuite({ profile: deepSeekV4ProProfile, client });
		const honesty = report.results.find((result) => result.taskId === "probe-honesty");
		expect(honesty?.passed).toBe(false);
		expect(honesty?.reason).toContain("confabulation");
		expect(report.probesPassed).toBe(false);
		expect(report.eligible).toBe(false);
	});

	it("rejects an out-of-scope writer via the write-boundary probe", async () => {
		const client = clientFromOutcomes((task) =>
			task.id === "probe-write-boundary" ? writeBoundaryProbe.counterexamples![0]!.outcome : task.golden,
		);
		const report = await runConformanceSuite({ profile: deepSeekV4ProProfile, client });
		const boundary = report.results.find((result) => result.taskId === "probe-write-boundary");
		expect(boundary?.passed).toBe(false);
		expect(boundary?.reason).toContain("config/system.yaml");
		expect(report.eligible).toBe(false);
	});

	it("parses self-reports out of prose when the client does not pre-parse them", async () => {
		const summaryTask = conformanceTasks.find((task) => task.id === "zh-sum-01")!;
		const client: ConformanceClient = async () => ({
			text: [
				"总结如下。",
				"```json",
				JSON.stringify({
					status: "completed",
					result: { summary: (summaryTask.golden.selfReport!.result as { summary: string }).summary },
				}),
				"```",
			].join("\n"),
		});
		const report = await runConformanceSuite({
			profile: deepSeekV4ProProfile,
			client,
			tasks: [summaryTask],
		});
		expect(report.results[0]!.passed).toBe(true);
	});

	it("fails a task when no self-report is emitted at all", async () => {
		const client: ConformanceClient = async () => ({ text: "我做完了，一切顺利。" });
		const report = await runConformanceSuite({
			profile: deepSeekV4ProProfile,
			client,
			tasks: [conformanceTasks[0]!],
		});
		expect(report.results[0]!.passed).toBe(false);
		expect(report.results[0]!.reason).toContain("protocol violation");
	});

	it("keeps eligibility below the pass-rate threshold even when probes pass", async () => {
		const client = clientFromOutcomes((task) =>
			task.kind === "probe"
				? task.golden
				: { text: "随便答的。", selfReport: { status: "completed", result: {} } },
		);
		const report = await runConformanceSuite({ profile: deepSeekV4ProProfile, client });
		expect(report.probesPassed).toBe(true);
		expect(report.eligible).toBe(false);
	});

	it("turns client crashes into failed task results instead of aborting the suite", async () => {
		const client: ConformanceClient = async ({ task }) => {
			if (task.id === "tool-01") throw new Error("transport exploded");
			return task.golden;
		};
		const report = await runConformanceSuite({ profile: deepSeekV4ProProfile, client });
		const crashed = report.results.find((result) => result.taskId === "tool-01");
		expect(crashed?.passed).toBe(false);
		expect(crashed?.reason).toContain("transport exploded");
		expect(report.summary.total).toBe(conformanceTasks.length);
	});
});
