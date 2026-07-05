import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TaskContract } from "../contract/index.ts";
import type { CheckpointStore } from "../checkpoint/index.ts";
import type { FrozenPrefix, PrefixParts } from "../context/lifecycle.ts";
import type { EvidenceManifestEntry, EvidenceReceiptCollector } from "../evidence/index.ts";
import type { CompletionGateFailure, ReceiptLedger } from "../feedback/index.ts";
import type { IntakeOptions, IntakeResult } from "../intake/index.ts";
import type { InMemoryUserMemoryStore, UserMemoryRecord } from "../memory/index.ts";
import type {
	HumanDecision,
	HumanGateRequest,
	LoopPersistence,
	WorkerReviewInput,
	WorkerReviewerBudget,
} from "../orchestration/index.ts";
import type { RunPolicy } from "../policy/index.ts";
import type { ReviewVerdict } from "../review/index.ts";
import type { RouteMatch, RoutingOptions } from "../routing/index.ts";
import type { SkillCard, SkillCardRegistry } from "../skills/index.ts";
import type { TraceSink } from "../trace/index.ts";

export type AgentRequestInput = { rawRequest: string } | { taskContract: TaskContract };

export interface AgentRequestHarness {
	prompt(text: string, options?: unknown): Promise<AssistantMessage>;
	promptTaskAttempt?(taskContract: TaskContract, text: string, options?: unknown): Promise<AssistantMessage>;
	skill?(name: string, additionalInstructions?: string): Promise<AssistantMessage>;
}

export type RequestLifecycleStage =
	| "intake"
	| "route"
	| "skill-select"
	| "memory-recall"
	| "execute"
	| "memory-write";

export interface RequestLifecycleTraceEvent {
	stage: RequestLifecycleStage;
	status: "pass" | "skip";
	detail?: string;
}

export interface RequestMemoryOptions {
	store: InMemoryUserMemoryStore;
	scope?: string;
	subject?: string;
	extractCandidates?: (input: {
		rawRequest: string;
		message: AssistantMessage;
		scope: string;
		subject: string;
		now: number;
	}) => readonly UserMemoryRecord[];
}

export interface RequestWorkerReviewerLoopOptions {
	checkpoint: CheckpointStore;
	ledger: ReceiptLedger;
	reviewer(input: WorkerReviewInput): Promise<ReviewVerdict>;
	receiptSource?: (input: {
		attempt: number;
		taskContract: TaskContract;
		message: AssistantMessage;
	}) => readonly EvidenceManifestEntry[];
	captureTaskAttemptEvidence?: (input: {
		attempt: number;
		taskContract: TaskContract;
		message: AssistantMessage;
	}) => Promise<EvidenceManifestEntry | undefined> | EvidenceManifestEntry | undefined;
	receiptCollector?: EvidenceReceiptCollector;
	diffSource?: (input: {
		attempt: number;
		taskContract: TaskContract;
		message: AssistantMessage;
	}) => string | Promise<string>;
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

export interface AgentRequestDeps {
	skillRegistry: SkillCardRegistry;
	intake?: IntakeOptions;
	routing: RoutingOptions;
	memory?: RequestMemoryOptions;
	trace?: TraceSink;
	workerReviewerLoop?: RequestWorkerReviewerLoopOptions;
	prefix?: FrozenPrefix;
	getPrefixParts?: () => PrefixParts;
	loadSkillBody?: (skill: SkillCard) => string | undefined;
	now?: () => number;
}

export type AgentRequestResult =
	| {
			entryStage: "intake";
			clarification: string;
			intake: IntakeResult;
			stageTrace: readonly RequestLifecycleTraceEvent[];
			recalledMemories: readonly UserMemoryRecord[];
			writtenMemories: readonly UserMemoryRecord[];
	  }
	| {
			entryStage: "execute";
			message: AssistantMessage;
			evidenceRefs: readonly string[];
			reviewVerdicts?: readonly ReviewVerdict[];
			completionGateFailures?: readonly CompletionGateFailure[];
			loopState?: "DONE" | "NEEDS_HUMAN" | "FAILED";
			diffRef?: string;
			route?: RouteMatch;
			selectedSkill?: SkillCard;
			stageTrace: readonly RequestLifecycleTraceEvent[];
			recalledMemories: readonly UserMemoryRecord[];
			writtenMemories: readonly UserMemoryRecord[];
	  };
