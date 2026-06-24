import { describe, expect, it } from "vitest";
import {
	LEGAL_TRANSITIONS,
	type RunState,
	transition,
	validateTransitionLog,
} from "../../src/orchestration/index.ts";

describe("orchestration state transitions", () => {
	it("allows every legal transition from the Phase 4 table", () => {
		for (const [from, targets] of Object.entries(LEGAL_TRANSITIONS) as Array<
			[RunState, readonly RunState[]]
		>) {
			for (const to of targets) {
				const context =
					to === "DONE" && from === "REVIEWING"
						? { reviewerVerdict: "PASS" as const }
						: to === "DONE" && from === "WORKER_ATTEMPT"
							? { readOnly: true }
							: undefined;
				expect(transition(from, to, context)).toBe(to);
			}
		}
	});

	it("rejects illegal transitions with a stable message", () => {
		expect(() => transition("CREATED", "WORKING")).toThrow("illegal transition CREATED -> WORKING");
		expect(() => transition("DONE", "WORKING")).toThrow("illegal transition DONE -> WORKING");
		expect(() => transition("FAILED", "DONE")).toThrow("illegal transition FAILED -> DONE");
	});

	it("rejects DONE without reviewer PASS unless the task is read-only", () => {
		expect(() => transition("REVIEWING", "DONE")).toThrow(
			"illegal transition REVIEWING -> DONE without reviewer PASS",
		);
		expect(() => transition("WORKER_ATTEMPT", "DONE")).toThrow(
			"illegal transition WORKER_ATTEMPT -> DONE without reviewer PASS",
		);
		expect(transition("REVIEWING", "DONE", { reviewerVerdict: "PASS" })).toBe("DONE");
		expect(transition("WORKER_ATTEMPT", "DONE", { readOnly: true })).toBe("DONE");
	});

	it("treats DONE, NEEDS_HUMAN, and FAILED as terminal states", () => {
		expect(LEGAL_TRANSITIONS.DONE).toEqual([]);
		expect(LEGAL_TRANSITIONS.NEEDS_HUMAN).toEqual([]);
		expect(LEGAL_TRANSITIONS.FAILED).toEqual([]);
	});

	it("freezes the transition table and each state's target list at runtime", () => {
		expect(Object.isFrozen(LEGAL_TRANSITIONS)).toBe(true);

		for (const targets of Object.values(LEGAL_TRANSITIONS)) {
			expect(Object.isFrozen(targets)).toBe(true);
		}
	});
});

describe("validateTransitionLog", () => {
	it("accepts a continuous legal transition log", () => {
		expect(
			validateTransitionLog([
				{ from: "CREATED", to: "PLANNED" },
				{ from: "PLANNED", to: "GATED" },
				{ from: "GATED", to: "WORKING" },
				{ from: "WORKING", to: "REVIEWING" },
				{ from: "REVIEWING", to: "DONE", context: { reviewerVerdict: "PASS" } },
			]),
		).toEqual({ ok: true, errors: [] });
	});

	it("reports illegal transition entries with stable paths", () => {
		expect(
			validateTransitionLog([
				{ from: "CREATED", to: "PLANNED" },
				{ from: "PLANNED", to: "WORKING" },
			]),
		).toEqual({
			ok: false,
			errors: [{ path: "$[1]", message: "illegal transition PLANNED -> WORKING" }],
		});
	});

	it("reports DONE transition logs that lack reviewer PASS context", () => {
		expect(validateTransitionLog([{ from: "REVIEWING", to: "DONE" }])).toEqual({
			ok: false,
			errors: [{ path: "$[0]", message: "illegal transition REVIEWING -> DONE without reviewer PASS" }],
		});
	});

	it("reports continuity breaks between adjacent entries", () => {
		expect(
			validateTransitionLog([
				{ from: "CREATED", to: "PLANNED" },
				{ from: "GATED", to: "WORKING" },
			]),
		).toEqual({
			ok: false,
			errors: [
				{
					path: "$[1].from",
					message: "transition log discontinuity: previous to PLANNED does not match from GATED",
				},
			],
		});
	});
});
