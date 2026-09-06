import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import { GenericHarness, type GenericHarnessInner } from "../src/harness.ts";
import { createModelGoalJudge, runGoalGate, type GoalGateOptions } from "../src/goal/goal-gate.ts";
import { resolveHarnessModel } from "../src/model-resolver.ts";
import { resolveHarnessConfig } from "../src/config.ts";
import { createInMemoryTraceSink } from "../src/trace/index.ts";

function response(text = "Work completed", stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant", content: [{ type: "text", text }], stopReason,
		api: "openai-completions", provider: "deepseek", model: "test-model", timestamp: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}
function gate(overrides: Partial<GoalGateOptions> = {}): GoalGateOptions {
	return {
		observe: () => ({ status: "ready", summary: "Current artifact and its checks match the request." }),
		judge: async () => ({ status: "complete", reason: "All requirements have evidence." }),
		...overrides,
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
function harness(options: GoalGateOptions, prompt = vi.fn(async (_text: string) => response()), trace = createInMemoryTraceSink({ runId: "goal-test" })) {
	const inner: GenericHarnessInner = {
		prompt, subscribe: () => () => {}, on: () => () => {},
		abort: async () => ({ clearedSteer: [], clearedFollowUp: [] }),
	};
	return new GenericHarness({ inner, requestLifecycle: { goalGate: options, trace } });
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("automatic goal control", () => {
	it("continues when the worker stops early without a done marker", async () => {
		const execute = vi.fn(async () => response("Here is a partial answer"));
		const judge = vi.fn<GoalGateOptions["judge"]>()
			.mockResolvedValueOnce({ status: "continue", reason: "The second deliverable is missing." })
			.mockResolvedValueOnce({ status: "complete", reason: "Both deliverables verified." });
		const result = await runGoalGate({ goal: "Create two deliverables", execute, options: gate({ judge }) });
		expect(result.goal).toMatchObject({ state: "COMPLETE", continuations: 1 });
		expect(execute).toHaveBeenCalledTimes(2);
		expect(execute.mock.calls[1]).toEqual([expect.stringContaining("second deliverable")]);
	});
	it.each(["pending", "blocked", "incomplete"] as const)("does not let semantic approval bypass %s host evidence", async (status) => {
		const judge = vi.fn<GoalGateOptions["judge"]>().mockResolvedValue({ status: "complete", reason: "Looks done" });
		const execute = vi.fn(async () => response("PI_HARNESS_DONE"));
		const result = await runGoalGate({ goal: "Verify", execute, options: gate({
			observe: () => ({ status, summary: "Waiting for verification." }), judge, maxContinuations: 0,
		}) });
		expect(result.goal.state).toBe({ pending: "WAITING", blocked: "NEEDS_HUMAN", incomplete: "LIMIT_REACHED" }[status]);
		expect(judge).not.toHaveBeenCalled();
		expect(execute).toHaveBeenCalledTimes(1);
	});
	it("rejects evidence that changed while the judge was running", async () => {
		const observe = vi.fn<GoalGateOptions["observe"]>()
			.mockReturnValueOnce({ status: "ready", summary: "Verified artifact hash A" })
			.mockReturnValue({ status: "incomplete", summary: "Artifact changed to hash B" });
		const result = await runGoalGate({ goal: "Finish", execute: async () => response(), options: gate({ observe, maxContinuations: 0 }) });
		expect(result.goal.state).toBe("LIMIT_REACHED");
		expect(result.goal.reason).toContain("hash B");
	});
	it("bounds repeated incomplete outcomes", async () => {
		const execute = vi.fn(async () => response());
		const result = await runGoalGate({ goal: "Finish", execute, options: gate({
			observe: () => ({ status: "incomplete", summary: "Missing test evidence." }), maxContinuations: 2,
		}) });
		expect(result.goal).toMatchObject({ state: "LIMIT_REACHED", continuations: 2 });
		expect(execute).toHaveBeenCalledTimes(3);
	});
	it.each(["error", "aborted"] as const)("never judges a worker %s", async (stopReason) => {
		const observe = vi.fn<GoalGateOptions["observe"]>();
		const result = await runGoalGate({ goal: "Finish", execute: async () => response("failed", stopReason), options: gate({ observe }) });
		expect(result.goal.state).toBe(stopReason === "error" ? "FAILED" : "CANCELLED");
		expect(observe).not.toHaveBeenCalled();
	});
	it.each(["length", "toolUse"] as const)("does not complete when worker stops with %s", async (stopReason) => {
		const result = await runGoalGate({ goal: "Finish", execute: async () => response("unfinished", stopReason), options: gate() });
		expect(result.goal.state).toBe("LIMIT_REACHED");
	});
	it("does not execute an already cancelled queued request", async () => {
		const execute = vi.fn(async () => response());
		const result = await runGoalGate({ goal: "Finish", execute, options: gate(), signal: AbortSignal.abort() });
		expect(result.goal.state).toBe("CANCELLED");
		expect(execute).not.toHaveBeenCalled();
	});
	it("ignores a late successful judge response after cancellation", async () => {
		const controller = new AbortController();
		const entered = deferred<void>();
		const pending = deferred<{ status: "complete"; reason: string }>();
		const run = runGoalGate({ goal: "Finish", signal: controller.signal, execute: async () => response(), options: gate({
			judge: async () => { entered.resolve(); return pending.promise; },
		}) });
		await entered.promise;
		controller.abort();
		expect((await run).goal.state).toBe("CANCELLED");
		pending.resolve({ status: "complete", reason: "Late result" });
	});
	it.each(["observe", "judge"] as const)("times out a hung %s without completing", async (hook) => {
		vi.useFakeTimers();
		const run = runGoalGate({ goal: "Finish", execute: async () => response(), options: gate({
			[hook]: () => new Promise(() => {}), checkTimeoutMs: 20,
		}) });
		await vi.advanceTimersByTimeAsync(21);
		expect((await run).goal.state).toBe("NEEDS_HUMAN");
	});
	it("fails closed on malformed judge data or provider errors", async () => {
		for (const judge of [async () => JSON.parse('{"status":"complete"}'), async () => { throw new Error("secret-provider-data"); }]) {
			const result = await runGoalGate({ goal: "Finish", execute: async () => response(), options: gate({ judge }) });
			expect(result.goal.state).toBe("NEEDS_HUMAN");
			expect(JSON.stringify(result)).not.toContain("secret-provider-data");
		}
	});
	it.each([NaN, Infinity, -1, 1.5])("rejects invalid continuation limit %s before work starts", async (maxContinuations) => {
		const execute = vi.fn(async () => response());
		await expect(runGoalGate({ goal: "Finish", execute, options: gate({ maxContinuations }) })).rejects.toThrow("maxContinuations");
		expect(execute).not.toHaveBeenCalled();
	});
});

describe("GenericHarness goal integration", () => {
	it("uses the real request entry point and records a terminal goal trace", async () => {
		const trace = createInMemoryTraceSink({ runId: "goal-integration" });
		const judge = vi.fn<GoalGateOptions["judge"]>()
			.mockResolvedValueOnce({ status: "continue", reason: "Missing output" })
			.mockResolvedValueOnce({ status: "complete", reason: "Verified output" });
		const prompt = vi.fn(async (_text: string) => response());
		const agent = harness(gate({ judge }), prompt, trace);
		const result = await agent.runRequest({ rawRequest: "Write a short greeting" });
		expect(result.entryStage === "execute" && result.goal?.state).toBe("COMPLETE");
		expect(prompt).toHaveBeenCalledTimes(2);
		expect(trace.events().some((event) => event.data?.stage === "goal-gate" && event.data.state === "COMPLETE")).toBe(true);
		await agent.dispose();
	});
	it("returns an explicit waiting message and writes no success memory", async () => {
		const agent = harness(gate({ observe: () => ({ status: "pending", summary: "Job 42 is running." }) }));
		const result = await agent.runRequest({ rawRequest: "Write a short greeting" });
		expect(result.entryStage === "execute" && result.goal?.state).toBe("WAITING");
		expect(result.writtenMemories).toEqual([]);
		expect(result.entryStage === "execute" && result.message.content).toEqual([{ type: "text", text: "Goal WAITING: Job 42 is running." }]);
		await agent.dispose();
	});
	it("new user input cancels the old judge and owns the next worker run", async () => {
		const entered = deferred<void>();
		const judge = vi.fn<GoalGateOptions["judge"]>()
			.mockImplementationOnce(async () => { entered.resolve(); return new Promise(() => {}); })
			.mockResolvedValue({ status: "complete", reason: "New request verified" });
		const prompt = vi.fn(async (_text: string) => response());
		const agent = harness(gate({ judge }), prompt);
		const old = agent.runRequest({ rawRequest: "Write a greeting" });
		await entered.promise;
		const next = agent.runRequest({ rawRequest: "Write a farewell" });
		const [first, second] = await Promise.all([old, next]);
		expect(first.entryStage === "execute" && first.goal?.state).toBe("CANCELLED");
		expect(second.entryStage === "execute" && second.goal?.state).toBe("COMPLETE");
		expect(prompt.mock.calls.map(([text]) => text)).toEqual(["Write a greeting", "Write a farewell"]);
		await agent.dispose();
	});
	it("never starts superseded requests queued behind a running worker", async () => {
		const entered = deferred<void>();
		const released = deferred<AssistantMessage>();
		const prompt = vi.fn(async (_text: string) => response())
			.mockImplementationOnce(async () => { entered.resolve(); return released.promise; });
		const agent = harness(gate(), prompt);
		const first = agent.runRequest({ rawRequest: "Write first" });
		await entered.promise;
		const second = agent.runRequest({ rawRequest: "Write superseded" });
		const third = agent.runRequest({ rawRequest: "Write final" });
		released.resolve(response());
		const results = await Promise.all([first, second, third]);
		expect(results.map((result) => result.entryStage === "execute" && result.goal?.state)).toEqual(["CANCELLED", "CANCELLED", "COMPLETE"]);
		expect(prompt.mock.calls.map(([text]) => text)).toEqual(["Write first", "Write final"]);
		await agent.dispose();
	});
	it("abort cancels a judge even when the inner worker is idle", async () => {
		const entered = deferred<void>();
		const agent = harness(gate({ judge: async () => { entered.resolve(); return new Promise(() => {}); } }));
		const pending = agent.runRequest({ rawRequest: "Write a greeting" });
		await entered.promise;
		await agent.abort();
		const result = await pending;
		expect(result.entryStage === "execute" && result.goal?.state).toBe("CANCELLED");
		await agent.dispose();
	});
	it("dispose cancels pending verification before closing resources", async () => {
		const entered = deferred<void>();
		const agent = harness(gate({ judge: async () => { entered.resolve(); return new Promise(() => {}); } }));
		const pending = agent.runRequest({ rawRequest: "Write a greeting" });
		await entered.promise;
		await agent.dispose();
		const result = await pending;
		expect(result.entryStage === "execute" && result.goal?.state).toBe("CANCELLED");
		await expect(agent.prompt("Another request")).rejects.toThrow("disposed");
	});
	it("leaves unconfigured requests as single worker runs", async () => {
		const prompt = vi.fn(async () => response());
		const agent = new GenericHarness({ inner: { prompt, on: () => () => {}, subscribe: () => () => {}, abort: async () => ({ clearedSteer: [], clearedFollowUp: [] }) } });
		const result = await agent.runRequest({ rawRequest: "Write a greeting" });
		expect(result.entryStage === "execute" && result.goal).toBeUndefined();
		expect(prompt).toHaveBeenCalledTimes(1);
		await agent.dispose();
	});
	it("uses a fresh tool-free model context and rejects prose pretending to be a verdict", async () => {
		const complete = vi.fn<Models["completeSimple"]>()
			.mockResolvedValueOnce(response('{"status":"complete","reason":"Verified"}'))
			.mockResolvedValueOnce(response("Everything is done."));
		const judge = createModelGoalJudge({ model: resolveHarnessModel(resolveHarnessConfig({})), models: { completeSimple: complete } });
		const input = { goal: "Write", response: "Worker response", evidence: "Current artifact", signal: new AbortController().signal };
		expect(await judge(input)).toMatchObject({ status: "complete" });
		const context = complete.mock.calls[0][1];
		expect(context.tools).toBeUndefined();
		expect(context.messages).toHaveLength(1);
		await expect(judge(input)).rejects.toThrow();
	});
});
