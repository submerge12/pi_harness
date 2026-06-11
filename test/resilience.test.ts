import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	classifyProviderError,
	formatApiKeyErrorMessage,
	getRetryAfterMs,
} from "../src/resilience/errors.ts";
import { withRetry } from "../src/resilience/retry.ts";
import { createReplSigintController, installReplSigintHandler } from "../src/cli/signals.ts";
import { repairJsonlTail } from "../src/session/recovery.ts";

const tempDirs: string[] = [];
const tempFiles: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-harness-resilience-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const file of tempFiles.splice(0)) {
		await unlink(file);
	}
	for (const dir of tempDirs.splice(0)) {
		await rmdir(dir);
	}
});

describe("provider error classification", () => {
	test("classifyProviderError marks authentication and bad request statuses as fatal", () => {
		expect(classifyProviderError({ status: 400 })).toBe("fatal");
		expect(classifyProviderError({ statusCode: 401 })).toBe("fatal");
		expect(classifyProviderError({ response: { status: 403 } })).toBe("fatal");
	});

	test("classifyProviderError marks throttling, server, and network failures as transient", () => {
		expect(classifyProviderError({ status: 408 })).toBe("transient");
		expect(classifyProviderError({ response: { status: 429 } })).toBe("transient");
		expect(classifyProviderError({ status: 503 })).toBe("transient");
		expect(classifyProviderError(Object.assign(new Error("socket closed"), { code: "ECONNRESET" }))).toBe(
			"transient",
		);
	});

	test("formatApiKeyErrorMessage points at the provider env var", () => {
		expect(formatApiKeyErrorMessage("deepseek")).toContain("DEEPSEEK_API_KEY");
		expect(formatApiKeyErrorMessage("custom-provider", "CUSTOM_KEY")).toContain("CUSTOM_KEY");
	});
});

describe("retry helper", () => {
	test("withRetry retries transient failures with deterministic full-jitter delays", async () => {
		const delays: number[] = [];
		const events: Array<{ attempt: number; attempts: number; delayMs: number }> = [];
		let calls = 0;

		const result = await withRetry(
			async () => {
				calls++;
				if (calls < 3) throw { status: 429 };
				return "ok";
			},
			{
				baseDelayMs: 100,
				delay: async (delayMs) => {
					delays.push(delayMs);
				},
				onRetry: (event) => {
					events.push({ attempt: event.attempt, attempts: event.attempts, delayMs: event.delayMs });
				},
				random: () => 0.5,
			},
		);

		expect(result).toBe("ok");
		expect(calls).toBe(3);
		expect(delays).toEqual([50, 100]);
		expect(events).toEqual([
			{ attempt: 1, attempts: 4, delayMs: 50 },
			{ attempt: 2, attempts: 4, delayMs: 100 },
		]);
	});

	test("withRetry honors Retry-After before jitter", async () => {
		const delays: number[] = [];
		let calls = 0;

		await withRetry(
			async () => {
				calls++;
				if (calls === 1) {
					throw {
						headers: {
							get(name: string): string | null {
								return name.toLowerCase() === "retry-after" ? "3" : null;
							},
						},
						status: 429,
					};
				}
				return undefined;
			},
			{
				delay: async (delayMs) => {
					delays.push(delayMs);
				},
				random: () => 0,
			},
		);

		expect(delays).toEqual([3000]);
	});

	test("withRetry does not retry fatal failures", async () => {
		const delay = vi.fn<() => Promise<void>>();
		let calls = 0;

		await expect(
			withRetry(
				async () => {
					calls++;
					throw { status: 401 };
				},
				{ delay },
			),
		).rejects.toMatchObject({ status: 401 });

		expect(calls).toBe(1);
		expect(delay).not.toHaveBeenCalled();
	});

	test("getRetryAfterMs parses seconds and http-date values", () => {
		const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);

		expect(getRetryAfterMs({ retryAfter: "2" }, nowMs)).toBe(2000);
		expect(getRetryAfterMs({ retryAfter: "Thu, 01 Jan 2026 00:00:05 GMT" }, nowMs)).toBe(5000);
	});
});

describe("REPL SIGINT controller", () => {
	test("first SIGINT during a turn aborts and second within the window exits", async () => {
		let now = 1000;
		const abort = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const exit = vi.fn<() => void>();
		const controller = createReplSigintController({
			harness: { abort },
			now: () => now,
			onExit: exit,
		});

		controller.setTurnActive(true);
		await expect(controller.handleSigint()).resolves.toBe("abort");
		now += 1500;
		await expect(controller.handleSigint()).resolves.toBe("exit");

		expect(abort).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledTimes(1);
	});

	test("SIGINT while idle exits without aborting", async () => {
		const abort = vi.fn<() => Promise<void>>();
		const exit = vi.fn<() => void>();
		const controller = createReplSigintController({
			harness: { abort },
			onExit: exit,
		});

		await expect(controller.handleSigint()).resolves.toBe("exit");

		expect(abort).not.toHaveBeenCalled();
		expect(exit).toHaveBeenCalledTimes(1);
	});

	test("installReplSigintHandler removes the registered listener during cleanup", () => {
		let listener: (() => void) | undefined;
		const target = {
			off(event: "SIGINT", nextListener: () => void): void {
				if (event === "SIGINT" && listener === nextListener) listener = undefined;
			},
			on(event: "SIGINT", nextListener: () => void): void {
				if (event === "SIGINT") listener = nextListener;
			},
		};
		const controller = createReplSigintController({
			harness: {},
			onExit: () => undefined,
		});

		const cleanup = installReplSigintHandler(target, controller);
		expect(listener).toEqual(expect.any(Function));

		cleanup();

		expect(listener).toBeUndefined();
	});
});

describe("JSONL tail recovery", () => {
	test("repairJsonlTail leaves valid JSONL untouched", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "session.jsonl");
		tempFiles.push(filePath);
		const content = `${JSON.stringify({ type: "session_info", id: "1" })}\n`;
		await writeFile(filePath, content, "utf8");

		const result = await repairJsonlTail(filePath);

		expect(result).toMatchObject({ repaired: false, droppedLines: 0, lineCount: 1 });
		await expect(readFile(filePath, "utf8")).resolves.toBe(content);
	});

	test("repairJsonlTail drops only a corrupt trailing partial line", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "session.jsonl");
		tempFiles.push(filePath);
		const validLine = JSON.stringify({ type: "session_info", id: "1" });
		await writeFile(filePath, `${validLine}\n{"type":`, "utf8");

		const result = await repairJsonlTail(filePath);
		const repaired = await readFile(filePath, "utf8");

		expect(result).toMatchObject({ repaired: true, droppedLines: 1 });
		expect(repaired).toBe(`${validLine}\n`);
	});

	test("repairJsonlTail rejects corrupt non-trailing lines", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "session.jsonl");
		tempFiles.push(filePath);
		await writeFile(filePath, `{"type":\n${JSON.stringify({ ok: true })}\n`, "utf8");

		await expect(repairJsonlTail(filePath)).rejects.toThrow("line 1");
	});
});
