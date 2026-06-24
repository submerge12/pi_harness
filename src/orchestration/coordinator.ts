import type { TaskContract } from "../contract/index.ts";
import type { CheckpointStore } from "../checkpoint/index.ts";
import type { EvidenceManifestEntry } from "../evidence/index.ts";
import type { CompletionGateFailure, ReceiptLedger } from "../feedback/ledger.ts";
import type { BudgetDecision } from "../observability/budget.ts";
import type { RunPolicy } from "../policy/index.ts";
import type { ReviewVerdict, ReviewerInput } from "../review/index.ts";
import type { TraceSink } from "../trace/index.ts";
import type { HumanDecision, HumanGateRequest, LoopPersistence } from "./persistence.ts";
import { transition, type RunState, type TransitionContext } from "./states.ts";

export interface WorkerAttemptInput {
	taskContract: TaskContract;
	attempt: number;
	maxTurns: number;
	failureDigest?: string;
	checkpoint: CheckpointStore;
}

export interface WorkerAttemptResult {
	doneClaim: boolean;
	diff: string;
	receipts: readonly EvidenceManifestEntry[];
	workerTranscript?: string;
}

export interface WorkerReviewInput {
	attempt: number;
	input: ReviewerInput;
	receipts: readonly EvidenceManifestEntry[];
}

export interface WorkerReviewerBudget {
	checkBeforeTurn(): BudgetDecision;
}

export interface WorkerReviewerLoopOptions {
	taskContract: TaskContract;
	trace: TraceSink;
	checkpoint: CheckpointStore;
	ledger: ReceiptLedger;
	worker(input: WorkerAttemptInput): Promise<WorkerAttemptResult>;
	reviewer(input: WorkerReviewInput): Promise<ReviewVerdict>;
	maxAttempts?: number;
	maxTurns?: number;
	budget?: WorkerReviewerBudget;
	policy?: unknown;
	runPolicy?: RunPolicy;
	humanGate?: {
		requestDecision(request: HumanGateRequest): Promise<HumanDecision | undefined> | HumanDecision | undefined;
		persistence?: LoopPersistence;
	};
}

export interface WorkerReviewerLoopResult {
	state: Extract<RunState, "DONE" | "NEEDS_HUMAN" | "FAILED">;
	attempts: number;
	reviewVerdicts: readonly ReviewVerdict[];
	completionGateFailures: readonly CompletionGateFailure[];
	receipts: readonly EvidenceManifestEntry[];
	humanGateRequests: readonly HumanGateRequest[];
	humanDecisions: readonly HumanDecision[];
	rewinds: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_TURNS = 10;

export async function runWorkerReviewerLoop(
	options: WorkerReviewerLoopOptions,
): Promise<WorkerReviewerLoopResult> {
	const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
	let state: RunState = "CREATED";
	let failureDigest: string | undefined;
	const reviewVerdicts: ReviewVerdict[] = [];
	const completionGateFailures: CompletionGateFailure[] = [];
	const receipts: EvidenceManifestEntry[] = [];
	const humanGateRequests: HumanGateRequest[] = [];
	const humanDecisions: HumanDecision[] = [];
	let rewinds = 0;

	const preRunDecision = await requestPreRunHumanGateIfRequired(options, {
		humanGateRequests,
		humanDecisions,
	});
	if (preRunDecision?.action === "abort" || (preRunDecision === undefined && shouldGateBeforeRun(options))) {
		state = await recordTransition(options.trace, state, "PLANNED");
		state = await recordTransition(options.trace, state, "GATED");
		state = await recordTransition(options.trace, state, "NEEDS_HUMAN");
		return {
			state: terminalState(state),
			attempts: 0,
			reviewVerdicts,
			completionGateFailures,
			receipts,
			humanGateRequests,
			humanDecisions,
			rewinds,
		};
	}

	if (options.taskContract.writeScope.length === 0) {
		state = await recordTransition(options.trace, state, "WORKER_ATTEMPT");
		const workerResult = await options.worker({
			taskContract: options.taskContract,
			attempt: 1,
			maxTurns,
			checkpoint: options.checkpoint,
		});
		await options.trace.append({ type: "worker-attempt", data: workerTraceData(1, workerResult) });
		receipts.push(...workerResult.receipts);
		state = await recordTransition(options.trace, state, "DONE", { readOnly: true });
			return {
				state: terminalState(state),
				attempts: 1,
				reviewVerdicts,
				completionGateFailures,
				receipts,
				humanGateRequests,
				humanDecisions,
				rewinds,
			};
	}

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const budgetDecision = options.budget?.checkBeforeTurn();
		if (budgetDecision && !budgetDecision.allowed) {
			state = await pauseForHuman(options.trace, state);
			return {
				state: terminalState(state),
				attempts: attempt - 1,
				reviewVerdicts,
				completionGateFailures,
				receipts,
				humanGateRequests,
				humanDecisions,
				rewinds,
			};
		}

		if (state !== "WORKER_ATTEMPT") {
			state = await recordTransition(options.trace, state, "WORKER_ATTEMPT");
		}

		options.checkpoint.beginAttempt?.(attempt);
		let workerResult: WorkerAttemptResult;
		try {
			workerResult = await options.worker({
				taskContract: options.taskContract,
				attempt,
				maxTurns,
				...(failureDigest ? { failureDigest } : {}),
				checkpoint: options.checkpoint,
			});
		} finally {
			options.checkpoint.finishAttempt?.();
		}
		for (const receipt of workerResult.receipts) {
			for (const path of receipt.actualWritePaths ?? []) {
				await options.checkpoint.snapshot(attempt, path);
			}
		}
		receipts.push(...workerResult.receipts);
		options.ledger.recordAttempt(attempt, workerResult.receipts);
		await options.trace.append({ type: "worker-attempt", data: workerTraceData(attempt, workerResult) });

		const completion = options.ledger.checkCompletion({
			taskContract: options.taskContract,
			attempt,
			doneClaim: workerResult.doneClaim,
		});
		if (!completion.ok && completion.failure) {
			completionGateFailures.push(completion.failure);
			await options.trace.append({ type: "completion-gate", data: completion.failure });
			if (attempt >= maxAttempts) {
				await requestHumanGateIfConfigured(options, {
					attempt,
					verdict: syntheticHumanVerdict(completion.failure.reason),
					diff: completion.failure.reason,
					receipts,
					humanGateRequests,
					humanDecisions,
				});
				state = await recordTransition(options.trace, state, "NEEDS_HUMAN");
				return { state: terminalState(state), attempts: attempt, reviewVerdicts, completionGateFailures, receipts, humanGateRequests, humanDecisions, rewinds };
			}
			if (!canRewind(options, rewinds)) {
				await requestHumanGateIfConfigured(options, {
					attempt,
					verdict: syntheticHumanVerdict("run policy maxRewinds reached"),
					diff: completion.failure.reason,
					receipts,
					humanGateRequests,
					humanDecisions,
				});
				state = await recordTransition(options.trace, state, "NEEDS_HUMAN");
				return { state: terminalState(state), attempts: attempt, reviewVerdicts, completionGateFailures, receipts, humanGateRequests, humanDecisions, rewinds };
			}
			state = await rewindAttempt(options, state, attempt);
			rewinds += 1;
			failureDigest = completion.failure.reason;
			continue;
		}

		state = await recordTransition(options.trace, state, "REVIEWING");
		const reviewerInput: ReviewerInput = {
			diff: workerResult.diff,
			evidenceManifest: completion.acceptedReceipts,
			acceptanceCriteria: acceptanceCriteria(options.taskContract),
			policy: options.policy ?? {},
		};
		const verdict = await options.reviewer({
			attempt,
			input: reviewerInput,
			receipts: completion.acceptedReceipts,
		});
		reviewVerdicts.push(verdict);
		await options.trace.append({ type: "review-verdict", data: { attempt, verdict } });

		if (verdict.verdict === "PASS") {
			state = await recordTransition(options.trace, state, "DONE", { reviewerVerdict: "PASS" });
			return { state: terminalState(state), attempts: attempt, reviewVerdicts, completionGateFailures, receipts, humanGateRequests, humanDecisions, rewinds };
		}

		if (verdict.verdict === "NEEDS_HUMAN" || verdict.verdict === "BLOCKED") {
			const decision = await requestHumanGateIfConfigured(options, {
				attempt,
				verdict,
				diff: workerResult.diff,
				receipts: completion.acceptedReceipts,
				humanGateRequests,
				humanDecisions,
			});
			if (decision?.action === "resume" && attempt < maxAttempts) {
				if (!canRewind(options, rewinds)) {
					state = await recordTransition(options.trace, state, "NEEDS_HUMAN");
					return { state: terminalState(state), attempts: attempt, reviewVerdicts, completionGateFailures, receipts, humanGateRequests, humanDecisions, rewinds };
				}
				state = await rewindAttempt(options, state, attempt);
				rewinds += 1;
				failureDigest = failureDigestFromVerdict(verdict);
				continue;
			}
			state = await recordTransition(options.trace, state, "NEEDS_HUMAN");
			return { state: terminalState(state), attempts: attempt, reviewVerdicts, completionGateFailures, receipts, humanGateRequests, humanDecisions, rewinds };
		}

		if (attempt >= maxAttempts) {
			await requestHumanGateIfConfigured(options, {
				attempt,
				verdict,
				diff: workerResult.diff,
				receipts: completion.acceptedReceipts,
				humanGateRequests,
				humanDecisions,
			});
			state = await recordTransition(options.trace, state, "NEEDS_HUMAN");
			return { state: terminalState(state), attempts: attempt, reviewVerdicts, completionGateFailures, receipts, humanGateRequests, humanDecisions, rewinds };
		}

		if (!canRewind(options, rewinds)) {
			await requestHumanGateIfConfigured(options, {
				attempt,
				verdict: syntheticHumanVerdict("run policy maxRewinds reached"),
				diff: workerResult.diff,
				receipts: completion.acceptedReceipts,
				humanGateRequests,
				humanDecisions,
			});
			state = await recordTransition(options.trace, state, "NEEDS_HUMAN");
			return { state: terminalState(state), attempts: attempt, reviewVerdicts, completionGateFailures, receipts, humanGateRequests, humanDecisions, rewinds };
		}
		state = await rewindAttempt(options, state, attempt);
		rewinds += 1;
		failureDigest = failureDigestFromVerdict(verdict);
	}

	if (state !== "NEEDS_HUMAN") state = await recordTransition(options.trace, state, "NEEDS_HUMAN");
	return { state: "NEEDS_HUMAN", attempts: maxAttempts, reviewVerdicts, completionGateFailures, receipts, humanGateRequests, humanDecisions, rewinds };
}

function canRewind(options: WorkerReviewerLoopOptions, rewinds: number): boolean {
	const maxRewinds = options.runPolicy?.repairLimits?.maxRewinds;
	return maxRewinds === undefined || rewinds < maxRewinds;
}

async function requestHumanGateIfConfigured(
	options: WorkerReviewerLoopOptions,
	input: {
		attempt: number;
		verdict: ReviewVerdict;
		diff: string;
		receipts: readonly EvidenceManifestEntry[];
		humanGateRequests: HumanGateRequest[];
		humanDecisions: HumanDecision[];
	},
): Promise<HumanDecision | undefined> {
	if (!options.humanGate) return undefined;
	const request: HumanGateRequest = {
		id: `${options.taskContract.id}-attempt-${input.attempt}-human-gate`,
		attempt: input.attempt,
		gateTier: options.taskContract.gateTier,
		verdict: input.verdict,
		diff: input.diff,
		evidence: input.receipts.map((receipt) => receipt.id),
	};
	input.humanGateRequests.push(request);
	const persistedDecision = await findPersistedDecision(options.humanGate.persistence, request.id);
	if (persistedDecision) {
		input.humanDecisions.push(persistedDecision);
		await options.trace.append({ type: "human-decision", data: persistedDecision });
		return persistedDecision;
	}
	await options.humanGate.persistence?.savePendingHumanGate(request);
	await options.trace.append({ type: "human-gate", data: request });
	const decision = await options.humanGate.requestDecision(request);
	if (!decision) return undefined;
	const storedDecision = {
		...decision,
		requestId: decision.requestId ?? request.id,
	};
	input.humanDecisions.push(storedDecision);
	await options.humanGate.persistence?.saveHumanDecision(storedDecision);
	await options.trace.append({ type: "human-decision", data: storedDecision });
	return storedDecision;
}

async function requestPreRunHumanGateIfRequired(
	options: WorkerReviewerLoopOptions,
	input: {
		humanGateRequests: HumanGateRequest[];
		humanDecisions: HumanDecision[];
	},
): Promise<HumanDecision | undefined> {
	if (!shouldGateBeforeRun(options)) return { id: "no-pre-run-gate", action: "resume", reviewer: "system", decidedAt: Date.now() };
	return await requestHumanGateIfConfigured(options, {
		attempt: 0,
		verdict: syntheticHumanVerdict(`run policy requires human gate for ${options.taskContract.gateTier}`),
		diff: options.taskContract.goal,
		receipts: [],
		humanGateRequests: input.humanGateRequests,
		humanDecisions: input.humanDecisions,
	});
}

function shouldGateBeforeRun(options: WorkerReviewerLoopOptions): boolean {
	return options.runPolicy?.gateTiers?.[options.taskContract.gateTier] === "human";
}

async function findPersistedDecision(
	persistence: LoopPersistence | undefined,
	requestId: string,
): Promise<HumanDecision | undefined> {
	const decisions = await persistence?.loadHumanDecisions() ?? [];
	return decisions.find((decision) =>
		(decision.requestId === requestId || decision.requestId === undefined) &&
		(decision.action === "resume" || decision.action === "abort")
	);
}

function syntheticHumanVerdict(claim: string): ReviewVerdict {
	return {
		verdict: "NEEDS_HUMAN",
		reviewer: "completion-gate",
		phase: "cross-check",
		findings: [{ severity: "blocker", claim }],
		decidedAt: Date.now(),
	};
}

function terminalState(state: RunState): WorkerReviewerLoopResult["state"] {
	if (state === "DONE" || state === "NEEDS_HUMAN" || state === "FAILED") return state;
	throw new Error(`worker-reviewer loop ended in non-terminal state ${state}`);
}

async function rewindAttempt(
	options: Pick<WorkerReviewerLoopOptions, "trace" | "checkpoint">,
	state: RunState,
	attempt: number,
): Promise<RunState> {
	const rewindState = await recordTransition(options.trace, state, "REWIND");
	await options.checkpoint.restore(attempt);
	await options.trace.append({ type: "rewind", data: { fromAttempt: attempt } });
	return await recordTransition(options.trace, rewindState, "WORKER_ATTEMPT");
}

async function recordTransition(
	trace: TraceSink,
	from: RunState,
	to: RunState,
	context?: TransitionContext,
): Promise<RunState> {
	const next = transition(from, to, context);
	await trace.append({ type: "transition", data: { from, to, ...(context ? { context } : {}) } });
	return next;
}

async function pauseForHuman(trace: TraceSink, state: RunState): Promise<RunState> {
	if (state === "CREATED") {
		const planned = await recordTransition(trace, state, "PLANNED");
		const gated = await recordTransition(trace, planned, "GATED");
		return await recordTransition(trace, gated, "NEEDS_HUMAN");
	}
	return await recordTransition(trace, state, "NEEDS_HUMAN");
}

function acceptanceCriteria(taskContract: TaskContract): string[] {
	const criteria = taskContract.hardConstraints
		.filter((constraint) => constraint.kind === "acceptance")
		.map((constraint) => constraint.value);
	return criteria.length > 0 ? criteria : [taskContract.goal];
}

function workerTraceData(attempt: number, result: WorkerAttemptResult): Record<string, unknown> {
	return {
		attempt,
		doneClaim: result.doneClaim,
		diff: result.diff,
		receipts: result.receipts.map((receipt) => receipt.id),
	};
}

function failureDigestFromVerdict(verdict: ReviewVerdict): string {
	const claims = verdict.findings.map((finding) => finding.claim).filter(Boolean);
	return claims.length > 0 ? claims.join("; ") : `reviewer ${verdict.verdict}`;
}
