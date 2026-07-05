import { describe, expect, it } from "vitest";
import type { TaskContract } from "../../src/contract/index.ts";
import {
	recallVerdictLessons,
	renderLessonsSuffix,
	writeVerdictLessons,
} from "../../src/feedback/lessons.ts";
import { InMemoryUserMemoryStore } from "../../src/memory/store.ts";
import { recallUserMemories } from "../../src/memory/index.ts";
import type { ReviewVerdict } from "../../src/review/index.ts";

const taskContract: TaskContract = {
	id: "task-1",
	goal: "ship the feature",
	rawRequest: "ship it",
	hardConstraints: [],
	assignedSkill: "coding",
	writeScope: ["src"],
	gateTier: "G1",
};

function failVerdict(claims: readonly { severity: "blocker" | "warn"; claim: string }[]): ReviewVerdict {
	return {
		verdict: "FAIL",
		reviewer: "blind-reviewer",
		phase: "blind",
		findings: claims.map((finding) => ({ ...finding })),
		decidedAt: 100,
	};
}

describe("verdict lessons", () => {
	it("persists blocker findings as per-skill lessons and recalls them most-recent-first", () => {
		const store = new InMemoryUserMemoryStore();
		const written = writeVerdictLessons(store, {
			taskContract,
			verdicts: [
				failVerdict([
					{ severity: "blocker", claim: "tests were not run before claiming done" },
					{ severity: "warn", claim: "style nit" },
				]),
			],
			now: 1_000,
		});
		expect(written).toHaveLength(1);

		const lessons = recallVerdictLessons(store, { skill: "coding", now: 2_000 });
		expect(lessons).toHaveLength(1);
		expect(lessons[0]!.object).toBe("tests were not run before claiming done");
		expect(recallVerdictLessons(store, { skill: "research", now: 2_000 })).toEqual([]);
	});

	it("dedupes repeated claims, expires lessons, and keeps distinct lessons from evicting each other", () => {
		const store = new InMemoryUserMemoryStore();
		writeVerdictLessons(store, {
			taskContract,
			verdicts: [
				failVerdict([
					{ severity: "blocker", claim: "missing write receipt" },
					{ severity: "blocker", claim: "Missing write receipt" },
					{ severity: "blocker", claim: "wrote outside scope" },
				]),
			],
			now: 1_000,
			ttlMs: 500,
		});
		expect(recallVerdictLessons(store, { skill: "coding", now: 1_200 })).toHaveLength(2);
		expect(recallVerdictLessons(store, { skill: "coding", now: 2_000 })).toEqual([]);
	});

	it("keeps lessons out of the background user-memory path via model_inferred trust", () => {
		const store = new InMemoryUserMemoryStore();
		writeVerdictLessons(store, {
			taskContract,
			verdicts: [failVerdict([{ severity: "blocker", claim: "missing write receipt" }])],
			now: 1_000,
		});
		const background = recallUserMemories(store, { scope: "global", subject: "worker", now: 1_100 })
			.filter((memory) => memory.trust !== "model_inferred");
		expect(background).toEqual([]);
	});

	it("renders a bounded prompt suffix", () => {
		const store = new InMemoryUserMemoryStore();
		writeVerdictLessons(store, {
			taskContract,
			verdicts: [failVerdict([{ severity: "blocker", claim: "missing write receipt" }])],
			now: 1_000,
		});
		const suffix = renderLessonsSuffix(recallVerdictLessons(store, { skill: "coding", now: 1_100 }));
		expect(suffix).toContain("Lessons from prior reviewed failures");
		expect(suffix).toContain("- missing write receipt");
		expect(renderLessonsSuffix([])).toBeUndefined();
	});
});
