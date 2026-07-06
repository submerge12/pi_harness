import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type TaskContract } from "../contract/index.ts";
import { assertPrefixInvariant, createFrozenPrefix, type FrozenPrefix } from "../context/lifecycle.ts";
import { loadJitDynamicSuffix } from "../context/jit-loader.ts";
import {
	extractDefaultMemoryCandidates,
	recallUserMemories,
	writeUserMemory,
	type UserMemoryRecord,
} from "../memory/index.ts";
import {
	isModelFailureError,
	type ModelFailureClassification,
	type ModelFailureError,
} from "../model-adapters/index.ts";
import { DEFAULT_MODEL_PROFILE } from "../model-profiles/registry.ts";
import { runWorkerReviewerLoop } from "../orchestration/index.ts";
import { runRequestFrontPipeline, type RouteMatch } from "../routing/index.ts";
import { matchSkillCards, lookupSkillCard, type SkillCard } from "../skills/index.ts";
import type {
	AgentRequestDeps,
	AgentRequestHarness,
	AgentRequestInput,
	AgentRequestResult,
	AttemptDiff,
	RequestLifecycleTraceEvent,
} from "./types.ts";
import {
	recallVerdictLessons,
	renderLessonsSuffix,
	type CompletionGateFailure,
} from "../feedback/index.ts";
import type { ReviewVerdict } from "../review/index.ts";

const DEFAULT_SCOPE = "global";
const DEFAULT_SUBJECT = "user";
const DONE_CLAIM_MARKER = "PI_HARNESS_DONE";

interface TaskExecutionOutcome {
	message: AssistantMessage;
	evidenceRefs: readonly string[];
	reviewVerdicts?: readonly ReviewVerdict[];
	completionGateFailures?: readonly CompletionGateFailure[];
	loopState?: "DONE" | "NEEDS_HUMAN" | "FAILED";
	diffRef?: string;
	modelFailure?: ModelFailureClassification;
}

export async function runAgentRequest(
	harness: AgentRequestHarness,
	input: AgentRequestInput,
	deps: AgentRequestDeps,
): Promise<AgentRequestResult> {
	const stageTrace: RequestLifecycleTraceEvent[] = [];
	const now = deps.now?.() ?? Date.now();

	if ("taskContract" in input) {
		const front = runRequestFrontPipeline({ taskContract: input.taskContract }, {
			intake: deps.intake,
			routing: deps.routing,
		});
		if (front.entryStage !== "execute") throw new Error("task contract must enter execute stage");
		const execution = shouldRunWorkerReviewerLoop(front.taskContract, deps)
			? await executeTaskContractWithWorkerReviewerLoop(harness, front.taskContract, deps)
			: await executeTaskContractWithReceipts(harness, front.taskContract, deps);
		await recordStage(deps, stageTrace, { stage: "execute", status: "pass", detail: input.taskContract.assignedSkill });
		const writtenMemories = execution.modelFailure
			? []
			: writeCandidateMemories(deps, front.taskContract.rawRequest, execution.message, now, execution.evidenceRefs);
		await recordStage(deps, stageTrace, { stage: "memory-write", status: writtenMemories.length > 0 ? "pass" : "skip", detail: String(writtenMemories.length) });
		return {
			entryStage: "execute",
			...execution,
			stageTrace,
			recalledMemories: [],
			writtenMemories,
		};
	}

	const front = runRequestFrontPipeline({ rawRequest: input.rawRequest }, {
		intake: deps.intake,
		routing: deps.routing,
	});
	await recordStage(deps, stageTrace, { stage: "intake", status: front.entryStage === "intake" ? "skip" : "pass" });
	if (front.entryStage === "intake") {
		return {
			entryStage: "intake",
			clarification: createClarification(front.intake.missingConstraintKinds),
			intake: front.intake,
			stageTrace,
			recalledMemories: [],
			writtenMemories: [],
		};
	}
	if (front.entryStage !== "route") {
		throw new Error("raw request must enter route stage");
	}

	await recordStage(deps, stageTrace, { stage: "route", status: front.route ? "pass" : "skip", detail: front.route?.route.name });
	const selectedSkill = selectSkill(front.route, constraintStrings(front.intake.hardConstraints), deps);
	await recordStage(deps, stageTrace, { stage: "skill-select", status: selectedSkill ? "pass" : "skip", detail: selectedSkill?.name });

	const recalledMemories = recallBackgroundMemories(deps, now);
	await recordStage(deps, stageTrace, { stage: "memory-recall", status: recalledMemories.length > 0 ? "pass" : "skip", detail: String(recalledMemories.length) });

	const frozenPrefix = deps.prefix ?? createFrozenPrefix({
		systemPrompt: "",
		declaredTools: [],
		skillCardIndex: deps.skillRegistry.prefixIndex().map((entry) => ({
			name: entry.name,
			whenToUse: entry.whenToUse,
			responsibility: entry.responsibility,
		})),
	});
	if (deps.getPrefixParts) assertPrefixInvariant(frozenPrefix, deps.getPrefixParts());
	const dynamicSuffix = await loadSelectedSkillSuffix(frozenPrefix, selectedSkill, deps);
	if (deps.getPrefixParts) assertPrefixInvariant(frozenPrefix, deps.getPrefixParts());
	const executionText = composeExecutionText(input.rawRequest, recalledMemories, dynamicSuffix);
	let message: AssistantMessage;
	let modelFailure: ModelFailureClassification | undefined;
	try {
		message = await executeRequest(harness, executionText, selectedSkill);
	} catch (error) {
		if (!isModelFailureError(error)) throw error;
		message = modelFailureAssistantMessage(error);
		modelFailure = error.classification;
	}
	await recordStage(deps, stageTrace, { stage: "execute", status: "pass", detail: selectedSkill?.name ?? front.route?.route.name });

	const writtenMemories = modelFailure ? [] : writeCandidateMemories(deps, input.rawRequest, message, now);
	await recordStage(deps, stageTrace, { stage: "memory-write", status: writtenMemories.length > 0 ? "pass" : "skip", detail: String(writtenMemories.length) });

	return {
		entryStage: "execute",
		message,
		evidenceRefs: [],
		...(modelFailure ? { modelFailure } : {}),
		route: front.route,
		selectedSkill,
		stageTrace,
		recalledMemories,
		writtenMemories,
	};
}

function shouldRunWorkerReviewerLoop(taskContract: TaskContract, deps: AgentRequestDeps): boolean {
	return taskContract.writeScope.length > 0 && deps.workerReviewerLoop !== undefined;
}

async function executeTaskContractWithWorkerReviewerLoop(
	harness: AgentRequestHarness,
	taskContract: TaskContract,
	deps: AgentRequestDeps,
): Promise<TaskExecutionOutcome> {
	const loop = deps.workerReviewerLoop;
	if (!loop) return await executeTaskContractWithReceipts(harness, taskContract, deps);
	if (!deps.trace) throw new Error("worker-reviewer loop requires a trace sink");

	let latestMessage: AssistantMessage | undefined;
	const result = await runWorkerReviewerLoop({
		taskContract,
		trace: deps.trace,
		checkpoint: loop.checkpoint,
		ledger: loop.ledger,
		maxAttempts: loop.maxAttempts,
		maxTurns: loop.maxTurns,
		budget: loop.budget,
		policy: loop.policy ?? loop.runPolicy ?? {},
		runPolicy: loop.runPolicy,
		lessons: loopLessonsOptions(taskContract, deps, loop),
		humanGate: loop.humanGate,
		worker: async ({ attempt, maxTurns, failureDigest }) => {
			loop.receiptCollector?.markAttemptStart(attempt);
			const attemptPrompt = composeTaskContractAttempt(
				taskContract,
				attempt,
				failureDigest,
				recallLessonsSuffix(taskContract, deps, loop),
			);
			let message: AssistantMessage;
			try {
				message = taskContract.allowedTools?.length
					? await promptAllowedTaskAttempt(harness, taskContract, attemptPrompt, { maxTurns })
					: await harness.prompt(attemptPrompt, { maxTurns });
			} catch (error) {
				if (!isModelFailureError(error)) throw error;
				message = modelFailureAssistantMessage(error);
				latestMessage = message;
				return {
					doneClaim: false,
					diff: error.message,
					diffOrigin: "self-report",
					receipts: [],
					modelFailure: error.classification,
				};
			}
			latestMessage = message;
			const collectedReceipts = loop.receiptCollector?.receiptsForAttempt(attempt) ?? [];
			return {
				doneClaim: isDoneClaim(message),
				...await readAttemptDiff(loop, { attempt, taskContract, message }),
				receipts: loop.receiptSource?.({ attempt, taskContract, message }) ?? collectedReceipts,
			};
		},
		reviewer: loop.reviewer,
	});

	const message = latestMessage?.stopReason === "error"
		? latestMessage
		: result.state === "DONE" && latestMessage
		? latestMessage
		: lifecycleAssistantMessage(`Worker-reviewer loop ended with ${result.state} after ${result.attempts} attempt(s).`);
	return {
		message,
		evidenceRefs: evidenceRefsFromReceipts(result.receipts),
		reviewVerdicts: result.reviewVerdicts,
		completionGateFailures: result.completionGateFailures,
		loopState: result.state,
		...(result.modelFailure ? { modelFailure: result.modelFailure } : {}),
	};
}

function composeTaskContractAttempt(
	taskContract: TaskContract,
	attempt: number,
	failureDigest: string | undefined,
	lessonsSuffix: string | undefined,
): string {
	return [
		"TaskContract execution request:",
		`attempt=${attempt}`,
		`assignedSkill=${taskContract.assignedSkill}`,
		`goal=${taskContract.goal}`,
		`rawRequest=${taskContract.rawRequest}`,
		"",
		"Completion protocol:",
		`When and only when this attempt is complete, include ${DONE_CLAIM_MARKER} on its own line in your final response.`,
		`If you could not finish, do not include ${DONE_CLAIM_MARKER}; explain the blocker instead.`,
		...(lessonsSuffix ? ["", lessonsSuffix] : []),
		...(failureDigest ? ["", "Previous review failure digest:", failureDigest] : []),
	].join("\n");
}

function loopLessonsOptions(
	taskContract: TaskContract,
	deps: AgentRequestDeps,
	loop: NonNullable<AgentRequestDeps["workerReviewerLoop"]>,
) {
	if (!deps.memory || !lessonsEnabled(taskContract, loop)) return undefined;
	return {
		store: deps.memory.store,
		...(deps.now ? { now: deps.now } : {}),
		...(loop.runPolicy?.lessons?.ttlMs !== undefined ? { ttlMs: loop.runPolicy.lessons.ttlMs } : {}),
	};
}

function recallLessonsSuffix(
	taskContract: TaskContract,
	deps: AgentRequestDeps,
	loop: NonNullable<AgentRequestDeps["workerReviewerLoop"]>,
): string | undefined {
	if (!deps.memory || !lessonsEnabled(taskContract, loop)) return undefined;
	return renderLessonsSuffix(recallVerdictLessons(deps.memory.store, {
		skill: taskContract.assignedSkill,
		now: deps.now?.() ?? Date.now(),
		...(loop.runPolicy?.lessons?.maxLessons !== undefined
			? { maxLessons: loop.runPolicy.lessons.maxLessons }
			: {}),
	}));
}

function lessonsEnabled(
	taskContract: TaskContract,
	loop: NonNullable<AgentRequestDeps["workerReviewerLoop"]>,
): boolean {
	return taskContract.writeScope.length > 0 && loop.runPolicy?.lessons?.enabled !== false;
}

function isDoneClaim(message: AssistantMessage): boolean {
	return message.stopReason !== "error" && assistantText(message)
		.split(/\r?\n/)
		.some((line) => line.trim() === DONE_CLAIM_MARKER);
}

async function promptAllowedTaskAttempt(
	harness: AgentRequestHarness,
	taskContract: TaskContract,
	text: string,
	options: unknown,
): Promise<AssistantMessage> {
	if (!harness.promptTaskAttempt) {
		throw new Error("TaskContract allowedTools requires a harness that can constrain task attempt tools");
	}
	return await harness.promptTaskAttempt(taskContract, text, options);
}

async function readAttemptDiff(
	loop: NonNullable<AgentRequestDeps["workerReviewerLoop"]>,
	input: { attempt: number; taskContract: TaskContract; message: AssistantMessage },
): Promise<AttemptDiff> {
	const diff = await loop.diffSource?.(input);
	// A plain-string source is consumer-supplied with unknown provenance; only sources
	// that declare their origin (AttemptDiff) may claim "git".
	if (typeof diff === "string") return { diff, diffOrigin: "custom" };
	if (diff) return diff;
	return { diff: assistantText(input.message), diffOrigin: "self-report" };
}

function assistantText(message: AssistantMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			if (!("type" in part) || part.type !== "text") return "";
			return "text" in part && typeof part.text === "string" ? part.text : "";
		})
		.join("");
}

function lifecycleAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: DEFAULT_MODEL_PROFILE.api,
		provider: DEFAULT_MODEL_PROFILE.provider,
		model: DEFAULT_MODEL_PROFILE.modelId,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function modelFailureAssistantMessage(error: ModelFailureError): AssistantMessage {
	const source = error.assistantMessage;
	return {
		role: "assistant",
		content: [{ type: "text", text: error.message }],
		api: source?.api ?? DEFAULT_MODEL_PROFILE.api,
		provider: source?.provider ?? DEFAULT_MODEL_PROFILE.provider,
		model: source?.model ?? DEFAULT_MODEL_PROFILE.modelId,
		usage: source?.usage ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error.message,
		timestamp: source?.timestamp ?? Date.now(),
	};
}

async function recordStage(
	deps: AgentRequestDeps,
	stageTrace: RequestLifecycleTraceEvent[],
	event: RequestLifecycleTraceEvent,
): Promise<void> {
	stageTrace.push(event);
	await deps.trace?.append({ type: "stage", data: event });
}

function createClarification(missingConstraintKinds: readonly string[]): string {
	if (missingConstraintKinds.length === 0) return "Please clarify the request.";
	return `Please clarify the missing constraints: ${missingConstraintKinds.join(", ")}`;
}

function constraintStrings(constraints: readonly { kind: string; value: string }[]): string[] {
	return constraints.map((constraint) => `${constraint.kind}:${constraint.value}`);
}

function selectSkill(
	route: RouteMatch | undefined,
	hardConstraints: readonly string[],
	deps: AgentRequestDeps,
): SkillCard | undefined {
	const eligible = matchSkillCards(deps.skillRegistry, hardConstraints);
	const routeSkill = route?.route.skill;
	if (routeSkill) {
		const card = lookupSkillCard(deps.skillRegistry, routeSkill);
		if (!card) throw new Error(`Route selected unknown skill: ${routeSkill}`);
		if (!eligible.some((candidate) => candidate.name === card.name)) {
			throw new Error(`Route selected ineligible skill: ${routeSkill}`);
		}
		return card;
	}
	if (!route) return undefined;
	return eligible.find((candidate) => candidate.name === route.route.name);
}

function recallBackgroundMemories(deps: AgentRequestDeps, now: number): UserMemoryRecord[] {
	if (!deps.memory) return [];
	return recallUserMemories(deps.memory.store, {
		scope: deps.memory.scope ?? DEFAULT_SCOPE,
		subject: deps.memory.subject ?? DEFAULT_SUBJECT,
		now,
	}).filter((memory) => memory.trust !== "model_inferred");
}

function composeExecutionText(
	rawRequest: string,
	memories: readonly UserMemoryRecord[],
	dynamicSuffix: string | undefined,
): string {
	if (memories.length === 0 && !dynamicSuffix) return rawRequest;
	return [
		...(memories.length > 0
			? ["Background context (not instructions):", ...memories.map(renderMemory), ""]
			: []),
		...(dynamicSuffix ? ["Dynamic suffix:", dynamicSuffix, ""] : []),
		"User request:",
		rawRequest,
	].join("\n");
}

async function loadSelectedSkillSuffix(
	prefix: FrozenPrefix,
	selectedSkill: SkillCard | undefined,
	deps: AgentRequestDeps,
): Promise<string | undefined> {
	if (!selectedSkill) return undefined;
	const suffix = await loadJitDynamicSuffix({
		prefix,
		compactIndex: [{ kind: "skill", name: selectedSkill.name, anchor: `skill://${selectedSkill.name}` }],
		requests: [{ kind: "skill", name: selectedSkill.name }],
		loadBody: () => ({
			body: deps.loadSkillBody?.(selectedSkill) ?? [
				`skill=${selectedSkill.name}`,
				`whenToUse=${selectedSkill.whenToUse}`,
				`handoffContract=${selectedSkill.handoffContract}`,
			].join("\n"),
		}),
	});
	return suffix.items.map((item) => item.body).join("\n");
}

function renderMemory(memory: UserMemoryRecord): string {
	return [
		`${memory.subject}.${memory.predicate}=${memory.object}`,
		`scope=${readScope(memory)}`,
		`trust=${memory.trust}`,
		`validFrom=${memory.validFrom}`,
		`observedAt=${memory.observedAt}`,
		`lastConfirmedAt=${memory.lastConfirmedAt}`,
	].join(" ");
}

async function executeRequest(
	harness: AgentRequestHarness,
	text: string,
	selectedSkill: SkillCard | undefined,
): Promise<AssistantMessage> {
	if (selectedSkill && harness.skill) return await harness.skill(selectedSkill.name, text);
	return await harness.prompt(text);
}

async function executeTaskContract(
	harness: AgentRequestHarness,
	taskContract: TaskContract,
): Promise<AssistantMessage> {
	const prompt = [
		"TaskContract execution request:",
		`assignedSkill=${taskContract.assignedSkill}`,
		`goal=${taskContract.goal}`,
		`rawRequest=${taskContract.rawRequest}`,
	].join("\n");
	if (taskContract.allowedTools?.length) {
		return await promptAllowedTaskAttempt(harness, taskContract, prompt, undefined);
	}
	return await harness.prompt(prompt);
}

async function executeTaskContractWithReceipts(
	harness: AgentRequestHarness,
	taskContract: TaskContract,
	deps: AgentRequestDeps,
): Promise<TaskExecutionOutcome> {
	const receiptCollector = deps.workerReviewerLoop?.receiptCollector;
	receiptCollector?.markAttemptStart(0);
	let message: AssistantMessage;
	let modelFailure: ModelFailureClassification | undefined;
	try {
		message = await executeTaskContract(harness, taskContract);
	} catch (error) {
		if (!isModelFailureError(error)) throw error;
		message = modelFailureAssistantMessage(error);
		modelFailure = error.classification;
	}
	let receipts = receiptCollector?.receiptsForAttempt(0) ?? [];
	if (receipts.length === 0) {
		const captured = await deps.workerReviewerLoop?.captureTaskAttemptEvidence?.({
			attempt: 0,
			taskContract,
			message,
		});
		if (captured) receipts = [captured];
	}
	return {
		message,
		evidenceRefs: evidenceRefsFromReceipts(receipts),
		...(modelFailure ? { modelFailure } : {}),
	};
}

function evidenceRefsFromReceipts(receipts: readonly { id: string }[]): string[] {
	return receipts.map((receipt) => receipt.id);
}

function writeCandidateMemories(
	deps: AgentRequestDeps,
	rawRequest: string,
	message: AssistantMessage,
	now: number,
	evidenceRefs: readonly string[] = [],
): UserMemoryRecord[] {
	const memory = deps.memory;
	if (!memory) return [];
	const scope = memory.scope ?? DEFAULT_SCOPE;
	const subject = memory.subject ?? DEFAULT_SUBJECT;
	const candidates =
		memory.extractCandidates?.({ rawRequest, message, scope, subject, now, evidenceRefs }) ??
		extractDefaultMemoryCandidates({ rawRequest, message, scope, subject, now, evidenceRefs });
	return candidates.map((candidate) => writeUserMemory(memory.store, candidate));
}

function readScope(memory: UserMemoryRecord): string {
	return "scope" in memory && typeof memory.scope === "string" ? memory.scope : DEFAULT_SCOPE;
}
