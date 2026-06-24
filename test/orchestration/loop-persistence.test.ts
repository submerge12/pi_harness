import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileLoopPersistence } from "../../src/orchestration/index.ts";

describe("loop artifact persistence", () => {
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
			reason: "ok",
		});

		const decisions = JSON.parse(await readFile(join(rootDir, "run-1", "human-decisions.json"), "utf8")) as unknown[];
		expect(decisions).toHaveLength(1);
		expect(await second.loadPendingHumanGate()).toBeUndefined();
	});
});
