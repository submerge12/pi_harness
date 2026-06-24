export type RunState =
	| "CREATED"
	| "PLANNED"
	| "GATED"
	| "WORKING"
	| "WORKER_ATTEMPT"
	| "REVIEWING"
	| "REWIND"
	| "DONE"
	| "NEEDS_HUMAN"
	| "FAILED";

export const LEGAL_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = Object.freeze({
	CREATED: Object.freeze(["PLANNED", "WORKER_ATTEMPT", "FAILED"] as RunState[]),
	PLANNED: Object.freeze(["GATED", "FAILED"] as RunState[]),
	GATED: Object.freeze(["WORKING", "NEEDS_HUMAN"] as RunState[]),
	WORKING: Object.freeze(["REVIEWING", "FAILED"] as RunState[]),
	WORKER_ATTEMPT: Object.freeze(["REVIEWING", "DONE", "REWIND", "NEEDS_HUMAN", "FAILED"] as RunState[]),
	REVIEWING: Object.freeze(["DONE", "REWIND", "WORKING", "NEEDS_HUMAN"] as RunState[]),
	REWIND: Object.freeze(["WORKER_ATTEMPT", "FAILED", "NEEDS_HUMAN"] as RunState[]),
	DONE: Object.freeze([] as RunState[]),
	NEEDS_HUMAN: Object.freeze([] as RunState[]),
	FAILED: Object.freeze([] as RunState[]),
});

export interface TransitionLogEntry {
	from: RunState;
	to: RunState;
	context?: TransitionContext;
}

export interface TransitionContext {
	reviewerVerdict?: "PASS";
	readOnly?: boolean;
}

export interface TransitionLogValidationError {
	path: string;
	message: string;
}

export interface TransitionLogValidationResult {
	ok: boolean;
	errors: TransitionLogValidationError[];
}

export function transition(from: RunState, to: RunState, context: TransitionContext = {}): RunState {
	if (!LEGAL_TRANSITIONS[from].includes(to)) throw new Error(illegalTransitionMessage(from, to));
	if (to === "DONE" && from === "REVIEWING" && context.reviewerVerdict !== "PASS") {
		throw new Error("illegal transition REVIEWING -> DONE without reviewer PASS");
	}
	if (to === "DONE" && from !== "REVIEWING" && !context.readOnly) {
		throw new Error(`illegal transition ${from} -> DONE without reviewer PASS`);
	}
	return to;
}

export function validateTransitionLog(entries: readonly TransitionLogEntry[]): TransitionLogValidationResult {
	const errors: TransitionLogValidationError[] = [];

	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		const previous = entries[index - 1];

		if (previous && previous.to !== entry.from) {
			errors.push({
				path: `$[${index}].from`,
				message: `transition log discontinuity: previous to ${previous.to} does not match from ${entry.from}`,
			});
		}

		try {
			transition(entry.from, entry.to, entry.context);
		} catch (error) {
			errors.push({
				path: `$[${index}]`,
				message: error instanceof Error ? error.message : illegalTransitionMessage(entry.from, entry.to),
			});
		}
	}

	return { ok: errors.length === 0, errors };
}

function illegalTransitionMessage(from: RunState, to: RunState): string {
	return `illegal transition ${from} -> ${to}`;
}
