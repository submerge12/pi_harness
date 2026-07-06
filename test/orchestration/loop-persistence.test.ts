import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileLoopPersistence } from "../../src/orchestration/index.ts";
import { clearKnownSecretsForTesting, registerKnownSecret } from "../../src/redaction/core.ts";

describe("loop artifact persistence", () => {
	afterEach(() => {
		clearKnownSecretsForTesting();
	});

	it("stores a pending human gate request and decision across instances", async () => {
		const rootDir = await mkdtemp(join(tmpdir(), "pi-loop-persistence-"));
		const first = createFileLoopPersistence({ rootDir, runId: "run-1" });

		await first.savePendingHumanGate({
			id: "gate-1",
			attempt: 1,
			gateTier: "G3",
			verdict: { verdict: "NEEDS_HUMAN", reviewer: "reviewer", phase: "cross-check", findings: [], decidedAt: 1 },
			diff: "diff",
			evidence: ["receipt-1"],
		});

		const second = createFileLoopPersistence({ rootDir, runId: "run-1" });
		expect(await second.loadPendingHumanGate()).toMatchObject({ id: "gate-1", evidence: ["receipt-1"] });

		await second.saveHumanDecision({
			id: "decision-1",
			action: "resume",
			reviewer: "human",
			decidedAt: 2,
			requestId: "gate-1",
			reason: "ok",
		});

		const decisions = JSON.parse(await readFile(join(rootDir, "run-1", "human-decisions.json"), "utf8")) as unknown[];
		expect(decisions).toHaveLength(1);
		expect(await second.loadPendingHumanGate()).toBeUndefined();
	});

	it("rejects id-less persisted decisions without clearing a pending gate", async () => {
		const warnings: unknown[] = [];
		const rootDir = await mkdtemp(join(tmpdir(), "pi-loop-persistence-"));
		const persistence = createFileLoopPersistence({
			rootDir,
			runId: "run-1",
			onWarning: (warning) => warnings.push(warning),
		});
		await persistence.savePendingHumanGate({
			id: "gate-1",
			attempt: 1,
			gateTier: "G3",
			verdict: { verdict: "NEEDS_HUMAN", reviewer: "reviewer", phase: "cross-check", findings: [], decidedAt: 1 },
			diff: "diff",
			evidence: ["receipt-1"],
		});
		await writeFile(
			join(rootDir, "run-1", "human-decisions.json"),
			JSON.stringify([{ id: "legacy", action: "resume", reviewer: "human", decidedAt: 2 }], null, "\t"),
			"utf8",
		);

		expect(await persistence.loadHumanDecisions()).toEqual([]);
		expect(await persistence.loadPendingHumanGate()).toMatchObject({ id: "gate-1" });
		expect(warnings).toEqual([
			expect.objectContaining({ code: "invalid-human-decision", index: 0 }),
			expect.objectContaining({ code: "invalid-human-decision", index: 0 }),
		]);
	});

	it("does not clear a pending gate with a decision for another request", async () => {
		const rootDir = await mkdtemp(join(tmpdir(), "pi-loop-persistence-"));
		const persistence = createFileLoopPersistence({ rootDir, runId: "run-1" });
		await persistence.savePendingHumanGate({
			id: "gate-1",
			attempt: 1,
			gateTier: "G3",
			verdict: { verdict: "NEEDS_HUMAN", reviewer: "reviewer", phase: "cross-check", findings: [], decidedAt: 1 },
			diff: "diff",
			evidence: ["receipt-1"],
		});
		await persistence.saveHumanDecision({
			id: "decision-1",
			action: "resume",
			reviewer: "human",
			decidedAt: 2,
			requestId: "gate-2",
		});

		expect(await persistence.loadPendingHumanGate()).toMatchObject({ id: "gate-1" });
	});

	it("keeps valid decisions while warning about malformed siblings", async () => {
		const warnings: unknown[] = [];
		const rootDir = await mkdtemp(join(tmpdir(), "pi-loop-persistence-"));
		const persistence = createFileLoopPersistence({
			rootDir,
			runId: "run-1",
			onWarning: (warning) => warnings.push(warning),
		});
		await persistence.savePendingHumanGate({
			id: "gate-1",
			attempt: 1,
			gateTier: "G3",
			verdict: { verdict: "NEEDS_HUMAN", reviewer: "reviewer", phase: "cross-check", findings: [], decidedAt: 1 },
			diff: "diff",
			evidence: ["receipt-1"],
		});
		await writeFile(
			join(rootDir, "run-1", "human-decisions.json"),
			JSON.stringify([
				{ id: "bad", action: "resume", reviewer: "human", decidedAt: 2 },
				{ id: "decision-1", action: "resume", reviewer: "human", decidedAt: 3, requestId: "gate-1" },
			], null, "\t"),
			"utf8",
		);

		expect(await persistence.loadHumanDecisions()).toEqual([
			{ id: "decision-1", action: "resume", reviewer: "human", decidedAt: 3, requestId: "gate-1" },
		]);
		expect(await persistence.loadPendingHumanGate()).toBeUndefined();
		expect(warnings).toEqual([
			expect.objectContaining({ code: "invalid-human-decision", index: 0 }),
			expect.objectContaining({ code: "invalid-human-decision", index: 0 }),
		]);
	});

	it("redacts pending human gate requests before writing them to disk", async () => {
		registerKnownSecret("sk-test-human-gate-secret");
		const rootDir = await mkdtemp(join(tmpdir(), "pi-loop-persistence-"));
		const persistence = createFileLoopPersistence({ rootDir, runId: "run-1" });

		await persistence.savePendingHumanGate({
			id: "gate-1",
			attempt: 1,
			gateTier: "G3",
			verdict: {
				verdict: "NEEDS_HUMAN",
				reviewer: "reviewer",
				phase: "cross-check",
				findings: [{ severity: "blocker", claim: "worker exposed sk-test-human-gate-secret" }],
				decidedAt: 1,
			},
			diff: "diff --git a/.env b/.env\n+DEEPSEEK_API_KEY=sk-test-human-gate-secret\n",
			evidence: ["receipt-sk-test-human-gate-secret"],
		});

		const raw = await readFile(join(rootDir, "run-1", "pending-human-gate.json"), "utf8");

		expect(raw).toContain("[REDACTED]");
		expect(raw).not.toContain("sk-test-human-gate-secret");
	});

	it("does not let toJSON bypass pending human gate redaction", async () => {
		registerKnownSecret("sk-test-to-json-secret");
		const rootDir = await mkdtemp(join(tmpdir(), "pi-loop-persistence-"));
		const persistence = createFileLoopPersistence({ rootDir, runId: "run-1" });
		const request = {
			id: "gate-1",
			attempt: 1,
			gateTier: "G3",
			verdict: {
				verdict: "NEEDS_HUMAN",
				reviewer: "reviewer",
				phase: "cross-check",
				findings: [],
				decidedAt: 1,
			},
			diff: "visible",
			evidence: [],
			toJSON: () => ({ leaked: "sk-test-to-json-secret" }),
		};

		await persistence.savePendingHumanGate(request as Parameters<typeof persistence.savePendingHumanGate>[0]);

		const raw = await readFile(join(rootDir, "run-1", "pending-human-gate.json"), "utf8");

		expect(raw).not.toContain("sk-test-to-json-secret");
		expect(raw).not.toContain("leaked");
	});

	it("redacts human decisions before writing them to disk", async () => {
		registerKnownSecret("sk-test-human-decision-secret");
		const rootDir = await mkdtemp(join(tmpdir(), "pi-loop-persistence-"));
		const persistence = createFileLoopPersistence({ rootDir, runId: "run-1" });

		await persistence.saveHumanDecision({
			id: "decision-1",
			action: "resume",
			reviewer: "human",
			decidedAt: 2,
			requestId: "gate-1",
			reason: "I checked sk-test-human-decision-secret manually",
		});

		const raw = await readFile(join(rootDir, "run-1", "human-decisions.json"), "utf8");

		expect(raw).toContain("[REDACTED]");
		expect(raw).not.toContain("sk-test-human-decision-secret");
	});
});
