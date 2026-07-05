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
import { DEFAULT_MODEL_PROFILE } from "../model-profiles/registry.ts";
import { runWorkerReviewerLoop } from "../orchestration/index.ts";
import { runRequestFrontPipeline, type RouteMatch } from "../routing/index.ts";
import { matchSkillCards, lookupSkillCard, type SkillCard } from "../skills/index.ts";
import type {
	AgentRequestDeps,
	AgentRequestHarness,
	AgentRequestInput,
	AgentRequestResult,
	RequestLifecycleTraceEvent,
} from "./types.ts";
import type { CompletionGateFailure } from "../feedback/index.ts";
import type { ReviewVerdict } from "../review/index.ts";

const DEFAULT_SCOPE = "global";
const DEFAULT_SUBJECT = "user";

interface TaskExecutionOutcome {
	message: AssistantMessage;
	evidenceRefs: readonly string[];
	reviewVerdicts?: readonly ReviewVerdict[];
	completionGateFailures?: readonly CompletionGateFailure[];
	loopState?: "DONE" | "NEEDS_HUMAN" | "FAILED";
	diffRef?: string;
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
		return {
			entryStage: "execute",
			...execution,
			stageTrace,
			recalledMemories: [],
			writtenMemories: [],
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
	const message = await executeRequest(harness, executionText, selectedSkill);
	await recordStage(deps, stageTrace, { stage: "execute", status: "pass", detail: selectedSkill?.name ?? front.route?.route.name });

	const writtenMemories = writeCandidateMemories(deps, input.rawRequest, message, now);
	await recordStage(deps, stageTrace, { stage: "memory-write", status: writtenMemories.length > 0 ? "pass" : "skip", detail: String(writtenMemories.length) });

	return {
		entryStage: "execute",
		message,
		evidenceRefs: [],
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
		humanGate: loop.humanGate,
		worker: async ({ attempt, maxTurns, failureDigest }) => {
			loop.receiptCollector?.markAttemptStart(attempt);
			const attemptPrompt = composeTaskContractAttempt(taskContract, attempt, failureDigest);
			const message = taskContract.allowedTools?.length
				? await promptAllowedTaskAttempt(harness, taskContract, attemptPrompt, { maxTurns })
				: await harness.prompt(attemptPrompt, { maxTurns });
			latestMessage = message;
			const collectedReceipts = loop.receiptCollector?.receiptsForAttempt(attempt) ?? [];
			return {
				doneClaim: message.stopReason !== "error",
				diff: await readAttemptDiff(loop, { attempt, taskContract, message }),
				receipts: loop.receiptSource?.({ attempt, taskContract, message }) ?? collectedReceipts,
			};
		},
		reviewer: loop.reviewer,
	});

	const message = result.state === "DONE" && latestMessage
		? latestMessage
		: lifecycleAssistantMessage(`Worker-reviewer loop ended with ${result.state} after ${result.attempts} attempt(s).`);
	return {
		message,
		evidenceRefs: evidenceRefsFromReceipts(result.receipts),
		reviewVerdicts: result.reviewVerdicts,
		completionGateFailures: result.completionGateFailures,
		loopState: result.state,
	};
}

function composeTaskContractAttempt(
	taskContract: TaskContract,
	attempt: number,
	failureDigest: string | undefined,
): string {
	return [
		"TaskContract execution request:",
		`attempt=${attempt}`,
		`assignedSkill=${taskContract.assignedSkill}`,
		`goal=${taskContract.goal}`,
		`rawRequest=${taskContract.rawRequest}`,
		...(failureDigest ? ["", "Previous review failure digest:", failureDigest] : []),
	].join("\n");
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
): Promise<string> {
	return await loop.diffSource?.(input) ?? assistantText(input.message);
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
	const message = await executeTaskContract(harness, taskContract);
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
): UserMemoryRecord[] {
	const memory = deps.memory;
	if (!memory) return [];
	const scope = memory.scope ?? DEFAULT_SCOPE;
	const subject = memory.subject ?? DEFAULT_SUBJECT;
	const candidates =
		memory.extractCandidates?.({ rawRequest, message, scope, subject, now }) ??
		extractDefaultMemoryCandidates({ rawRequest, message, scope, subject, now });
	return candidates.map((candidate) => writeUserMemory(memory.store, candidate));
}

function readScope(memory: UserMemoryRecord): string {
	return "scope" in memory && typeof memory.scope === "string" ? memory.scope : DEFAULT_SCOPE;
}
