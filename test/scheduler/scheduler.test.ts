import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { resolveHarnessConfig } from "../../src/config.ts";
import { formatCliHelp, parseCliArgs } from "../../src/cli/index.ts";
import { Scheduler, type ScheduledTaskDefinition } from "../../src/scheduler/index.ts";
import type { AgentProfile } from "../../src/agents/profile.ts";

interface NotificationMessage {
	agentName: string;
	title: string;
	body: string;
}

function fakeEnv(): ExecutionEnv {
	return {
		cwd: ".",
		async absolutePath() {
			return { ok: true, value: "." };
		},
		async joinPath(parts: string[]) {
			return { ok: true, value: parts.join("/") };
		},
		async readTextFile() {
			return { ok: true, value: "" };
		},
		async readBinaryFile() {
			return { ok: true, value: new Uint8Array() };
		},
		async writeFile() {
			return { ok: true, value: undefined };
		},
		async appendFile() {
			return { ok: true, value: undefined };
		},
		async listDir() {
			return { ok: true, value: [] };
		},
		async fileInfo() {
			return { ok: true, value: { kind: "directory", name: ".", path: ".", size: 0, mtimeMs: 0 } };
		},
		async canonicalPath() {
			return { ok: true, value: "." };
		},
		async exists() {
			return { ok: true, value: true };
		},
		async createDir() {
			return { ok: true, value: undefined };
		},
		async remove() {
			return { ok: true, value: undefined };
		},
		async createTempDir() {
			return { ok: true, value: "." };
		},
		async createTempFile() {
			return { ok: true, value: "." };
		},
		async readTextLines() {
			return { ok: true, value: [] };
		},
		async exec() {
			return { ok: true, value: { stdout: "", stderr: "", exitCode: 0 } };
		},
		async cleanup() {},
	};
}

function task(overrides: Partial<ScheduledTaskDefinition> = {}): ScheduledTaskDefinition {
	return {
		id: "morning",
		agentProfile: "travel",
		taskType: "proactive_check",
		schedule: { intervalMinutes: 5 },
		enabled: true,
		...overrides,
	};
}

describe("Scheduler", () => {
	it("evaluates interval and cron schedules against the current time", () => {
		const scheduler = new Scheduler({
			config: { tasks: [] },
			context: { env: fakeEnv(), config: resolveHarnessConfig() },
		});
		const now = new Date("2026-06-15T08:30:00.000Z");

		expect(scheduler.isDue(task(), now, new Date("2026-06-15T08:24:59.000Z"))).toBe(true);
		expect(scheduler.isDue(task(), now, new Date("2026-06-15T08:26:00.000Z"))).toBe(false);
		expect(
			scheduler.isDue(task({ schedule: { cron: "30 8 * * 1", timezone: "UTC" } }), now),
		).toBe(true);
		expect(
			scheduler.isDue(task({ schedule: { cron: "31 8 * * 1", timezone: "UTC" } }), now),
		).toBe(false);
		expect(scheduler.isDue(task({ enabled: false }), now, new Date("2026-06-15T08:24:59.000Z"))).toBe(false);
	});

	it("runs profile proactive checks and emits summary notifications", async () => {
		const sent: NotificationMessage[] = [];
		const profile: AgentProfile = {
			name: "travel",
			description: "Travel",
			systemPrompt: "travel",
			proactiveCheck: async () => "Weather is clear.",
		};
		const scheduler = new Scheduler({
			config: { tasks: [task()] },
			context: { env: fakeEnv(), config: resolveHarnessConfig() },
			notifications: {
				send: async (message) => {
					sent.push(message);
				},
			},
			profileResolver: () => profile,
		});

		const result = await scheduler.runTask("morning");

		expect(result).toMatchObject({
			taskId: "morning",
			agentProfile: "travel",
			success: true,
			output: "Weather is clear.",
		});
		expect(sent).toMatchObject([
			{
				agentName: "travel",
				title: "Scheduled check: morning",
				body: "Weather is clear.",
			},
		]);
	});

	it("captures missing proactive checks as task failures", async () => {
		const profile: AgentProfile = {
			name: "travel",
			description: "Travel",
			systemPrompt: "travel",
		};
		const scheduler = new Scheduler({
			config: { tasks: [task()] },
			context: { env: fakeEnv(), config: resolveHarnessConfig() },
			profileResolver: () => profile,
		});

		const result = await scheduler.runTask("morning");

		expect(result).toMatchObject({
			taskId: "morning",
			agentProfile: "travel",
			success: false,
			error: "Agent profile travel does not define proactiveCheck",
		});
	});

	it("does not overlap due runs for the same task", async () => {
		let resolveCheck: (value: string) => void = () => {};
		let calls = 0;
		const profile: AgentProfile = {
			name: "travel",
			description: "Travel",
			systemPrompt: "travel",
			proactiveCheck: async () => {
				calls++;
				return await new Promise<string>((resolve) => {
					resolveCheck = resolve;
				});
			},
		};
		const scheduler = new Scheduler({
			config: { tasks: [task()] },
			context: { env: fakeEnv(), config: resolveHarnessConfig() },
			profileResolver: () => profile,
		});
		const firstRun = scheduler.runDueSchedules(new Date("2026-06-15T08:30:00.000Z"));
		await scheduler.runDueSchedules(new Date("2026-06-15T08:31:00.000Z"));
		resolveCheck("clear");
		await firstRun;

		expect(calls).toBe(1);
	});

	it("parses and documents the scheduler CLI flag", () => {
		expect(parseCliArgs(["--agent", "travel", "--scheduler"]).options).toMatchObject({
			agent: "travel",
			scheduler: true,
		});
		expect(formatCliHelp()).toContain("--scheduler");
	});
});
