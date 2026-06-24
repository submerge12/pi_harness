import {
	AgentHarness,
	type AgentMessage,
	type AgentHarnessStreamOptions,
	type AgentHarnessStreamOptionsPatch,
	type AbortResult,
	type AgentHarnessEvent,
	type AgentHarnessEventResultMap,
	type AgentHarnessOwnEvent,
	type AgentHarnessPromptOptions,
	type AgentHarnessResources,
	type AgentTool,
	type CompactResult,
	type ExecutionEnv,
	type PromptTemplate,
	type Session,
	type Skill,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { completeSimple, getEnvApiKey } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, KnownProvider, Message, Model, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import { isAbsolute, resolve } from "node:path";
import { CacheStrategyEngine } from "./cache/strategy-engine.ts";
import type { HarnessConfig, ResolvedHarnessConfig } from "./config.ts";
import { resolveHarnessConfig } from "./config.ts";
import { CompactionPolicy } from "./context/compaction-policy.ts";
import { createFullCompactionSummary } from "./context/lifecycle.ts";
import { ContextManager } from "./context/manager.ts";
import { PruneExecutor } from "./context/prune-executor.ts";
import type { CheckpointStore } from "./checkpoint/index.ts";
import { recordEvidenceGatewayEntries, type EvidenceGateway } from "./evidence/index.ts";
import type { ActiveWorktreeLeaseProvider } from "./execution/index.ts";
import {
	createRequestLifecycleDeps,
	runAgentRequest,
	type AgentRequestDeps,
	type AgentRequestInput,
	type AgentRequestResult,
	type RequestLifecycleRuntimeOptions,
} from "./lifecycle/index.ts";
import { resolveHarnessModel, resolveModel } from "./model-resolver.ts";
import { BudgetTracker } from "./observability/budget.ts";
import { CacheReportTracker } from "./observability/cache-report.ts";
import { CostTracker } from "./observability/cost-tracker.ts";
import { EventLog, createSessionEventLogPath } from "./observability/event-log.ts";
import type { CostSummary, HarnessEvent as ObservabilityEvent } from "./observability/types.ts";
import { withRetry } from "./resilience/retry.ts";
import { createJsonlSession } from "./session/factory.ts";
import { createDefaultToolset } from "./tools/builtin/index.ts";
import { PermissionGate, ToolPermissionDecisionStore } from "./tools/permission.ts";

export interface ApiKeyResolutionConfig {
	apiKey?: string;
	apiHeaders?: Record<string, string>;
	provider: string;
}

export class AuthenticationError extends Error {
	provider: string;

	constructor(provider: string) {
		super(`No API key configured for provider ${provider}`);
		this.name = "AuthenticationError";
		this.provider = provider;
	}
}

class AssistantMessageError extends Error {
	status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "AssistantMessageError";
		this.status = status;
	}
}

const lifecycleInternalPrompt = Symbol("pi-harness.lifecycleInternalPrompt");
type InternalPromptOptions = AgentHarnessPromptOptions & { [lifecycleInternalPrompt]?: true };

function markLifecycleInternalPrompt(options?: AgentHarnessPromptOptions): InternalPromptOptions {
	return { ...(options ?? {}), [lifecycleInternalPrompt]: true } as InternalPromptOptions;
}

function isLifecycleInternalPromptOptions(
	options: AgentHarnessPromptOptions | undefined,
): options is InternalPromptOptions {
	return Boolean((options as InternalPromptOptions | undefined)?.[lifecycleInternalPrompt]);
}

function stripLifecycleInternalPrompt(options: InternalPromptOptions): AgentHarnessPromptOptions | undefined {
	const { [lifecycleInternalPrompt]: _marker, ...rest } = options;
	return Object.keys(rest).length === 0 ? undefined : rest as AgentHarnessPromptOptions;
}

export async function resolveApiKeyAndHeaders(
	config: ApiKeyResolutionConfig,
): Promise<{ apiKey: string; headers?: Record<string, string> }> {
	const headers = config.apiHeaders ? { ...config.apiHeaders } : undefined;
	if (config.apiKey) return headers ? { apiKey: config.apiKey, headers } : { apiKey: config.apiKey };

	const apiKey = getEnvApiKey(config.provider);
	if (apiKey) return headers ? { apiKey, headers } : { apiKey };

	throw new AuthenticationError(config.provider);
}

export interface PrewarmStreamOptionsInput {
	auth: { apiKey: string; headers?: Record<string, string> };
	config: Pick<ResolvedHarnessConfig, "cache" | "streamOptions" | "thinkingLevel">;
	model: Model<Api>;
	sessionId: string;
}

export function buildPrewarmStreamOptions(input: PrewarmStreamOptionsInput): SimpleStreamOptions {
	const base = cloneStreamOptions({
		...input.config.streamOptions,
		headers: mergeHeaders(input.config.streamOptions?.headers, input.auth.headers),
	});
	const decision = new CacheStrategyEngine(input.config.cache).buildDecision({
		model: input.model,
		sessionId: input.sessionId,
		streamOptions: base,
	});
	const requestOptions = applyStreamOptionsPatch(base, decision.streamOptions);
	return {
		...requestOptions,
		apiKey: input.auth.apiKey,
		maxTokens: 1,
		reasoning: providerReasoning(input.config.thinkingLevel),
		sessionId: input.sessionId,
	};
}

export interface GenericHarnessInner {
	prompt(text: string, options?: AgentHarnessPromptOptions): Promise<AssistantMessage>;
	subscribe(listener: (event: AgentHarnessEvent, signal?: AbortSignal) => Promise<void> | void): () => void;
	on<TType extends keyof AgentHarnessEventResultMap>(
		type: TType,
		handler: (
			event: Extract<AgentHarnessOwnEvent, { type: TType }>,
		) => Promise<AgentHarnessEventResultMap[TType]> | AgentHarnessEventResultMap[TType],
	): () => void;
	abort(): Promise<AbortResult>;
	getModel?(): Model<Api>;
	setModel?(model: Model<Api>): Promise<void>;
	getThinkingLevel?(): ThinkingLevel;
	setThinkingLevel?(level: ThinkingLevel): Promise<void>;
	compact?(customInstructions?: string): Promise<CompactResult>;
	skill?(name: string, additionalInstructions?: string): Promise<AssistantMessage>;
	promptFromTemplate?(name: string, args?: string[]): Promise<AssistantMessage>;
	getResources?(): AgentHarnessResources;
	setResources?(resources: AgentHarnessResources): Promise<void>;
}

export interface GenericHarnessOptions {
	config?: HarnessConfig;
	env?: ExecutionEnv;
	session?: Session;
	inner?: GenericHarnessInner;
	evidenceGateway?: EvidenceGateway;
	getActiveLease?: ActiveWorktreeLeaseProvider["getActiveLease"];
	requestLifecycle?: RequestLifecycleRuntimeOptions;
	checkpoint?: CheckpointStore;
	budgetTracker?: BudgetTracker;
	costTracker?: CostTracker;
}

export interface GenericHarnessRuntimeOptions {
	evidenceGateway?: EvidenceGateway;
	getActiveLease?: ActiveWorktreeLeaseProvider["getActiveLease"];
	requestLifecycle?: RequestLifecycleRuntimeOptions;
	checkpoint?: CheckpointStore;
	budgetTracker?: BudgetTracker;
	costTracker?: CostTracker;
}

export class GenericHarness {
	private readonly config: ResolvedHarnessConfig;
	private readonly budgetTracker?: BudgetTracker;
	private readonly cacheReportTracker = new CacheReportTracker();
	private readonly costTracker: CostTracker;
	private readonly env?: ExecutionEnv;
	private readonly session?: Session;
	private readonly inner: GenericHarnessInner;
	private readonly requestLifecycle: ReturnType<typeof createRequestLifecycleDeps>;
	private readonly localListeners = new Set<(event: AgentHarnessEvent, signal?: AbortSignal) => Promise<void> | void>();
	private readonly unsubscribes: Array<() => void> = [];
	private readonly disposers: Array<() => void | Promise<void>> = [];
	private activeTaskToolNames: readonly string[] | undefined;
	private pruneExecutor?: PruneExecutor;
	private pruneBoundToTurnEnd = false;
	private disposed = false;

	constructor(options: GenericHarnessOptions = {}) {
		this.config = resolveHarnessConfig(options.config);
		this.env = options.env;
		this.session = options.session;
		this.budgetTracker = options.budgetTracker ?? (this.config.budget ? new BudgetTracker(this.config.budget) : undefined);
		this.costTracker = options.costTracker ?? new CostTracker();
		this.requestLifecycle = createRequestLifecycleDeps(this.config, options.requestLifecycle);
		this.inner = options.inner ?? this.createInner(options);
		if (options.inner) this.configurePruneExecutor(options.session);
		if (!options.inner) this.installInternalSubscriptions();
	}

	private createInner(options: GenericHarnessOptions): GenericHarnessInner {
		if (!options.env) throw new Error("GenericHarness requires env when inner is not provided");
		if (!options.session) throw new Error("GenericHarness requires session when inner is not provided");

		const model = resolveHarnessModel(this.config);
		const permissionDecisions = new ToolPermissionDecisionStore();
		const evidenceGateway = recordEvidenceGatewayEntries(
			options.evidenceGateway,
			options.requestLifecycle?.workerReviewerLoop?.receiptCollector,
		);
		const registry = this.config.useDefaultTools
			? createDefaultToolset({
					env: options.env,
					roots: this.config.sandbox?.roots,
					maxOutputChars: this.config.sandbox?.maxOutputChars,
					bashTimeoutSeconds: this.config.sandbox?.bashTimeoutSeconds,
					fetchMaxBytes: this.config.sandbox?.fetchMaxBytes,
					evidenceGateway,
					getPermissionDecision: permissionDecisions.lookup,
					checkpoint: options.checkpoint ?? options.requestLifecycle?.workerReviewerLoop?.checkpoint,
					commandRules: this.config.commandRules,
				})
			: undefined;
		const tools = this.config.tools ?? registry?.toAgentTools();
		const activeTools = selectActiveTools(tools, this.config.activeToolNames);
		this.configurePruneExecutor(options.session, async () => {
			await this.prewarmPrunedContext(model, activeTools);
		});
		const inner = new AgentHarness({
			activeToolNames: this.config.activeToolNames,
			env: options.env,
			getApiKeyAndHeaders: async (model: Model<Api>) =>
				await resolveApiKeyAndHeaders({
					apiKey: this.config.apiKey,
					apiHeaders: this.config.apiHeaders,
					provider: model.provider,
				}),
			model,
			session: options.session,
			resources: this.config.resources,
			streamOptions: this.config.streamOptions,
			systemPrompt: this.config.systemPrompt,
			thinkingLevel: this.config.thinkingLevel,
			tools,
		});

		if (registry) {
			this.unsubscribes.push(
				new PermissionGate(registry, this.config.policy, {
					askCallback: this.config.askPermission,
					getActiveLease: options.getActiveLease,
					getActiveToolNames: () => this.activeTaskToolNames,
					onDecision: (decision) => permissionDecisions.record(decision),
				}).install(inner),
			);
		}
		this.unsubscribes.push(new ContextManager({
			contextWindow: this.config.contextWindow ?? model.contextWindow,
			ratios: this.config.tokenBudgetRatios,
			rewriteMessages: this.pruneExecutor
				? (messages) => this.pruneExecutor?.rewriteContext(messages) ?? messages
				: undefined,
		}).bind(inner));
		this.unsubscribes.push(new CacheStrategyEngine({
			...this.config.cache,
			onDecision: (decision) => this.cacheReportTracker.recordDecision(decision),
		}).bind(inner));
		return inner;
	}

	async prompt(text: string, options?: AgentHarnessPromptOptions): Promise<AssistantMessage> {
		if (isLifecycleInternalPromptOptions(options)) {
			return await this.executePrompt(text, stripLifecycleInternalPrompt(options));
		}
		const result = await this.runRequest({ rawRequest: text }, options);
		if (result.entryStage === "intake") return this.assistantTextMessage(result.clarification);
		return result.message;
	}

	private async executePrompt(text: string, options?: AgentHarnessPromptOptions): Promise<AssistantMessage> {
		const budgetDecision = this.budgetTracker?.checkBeforeTurn();
		if (budgetDecision && !budgetDecision.allowed) throw new Error(budgetDecision.message ?? "budget exceeded");

		const result = await withRetry(async () => {
			const leafId = await this.session?.getLeafId();
			try {
				const message = await this.inner.prompt(text, options);
				const failure = assistantMessageError(message);
				if (failure) {
					await this.restoreSessionLeaf(leafId);
					throw failure;
				}
				return message;
			} catch (error) {
				await this.restoreSessionLeaf(leafId);
				throw error;
			}
		}, {
			...this.config.retry,
			onRetry: async (event) => {
				await this.emitLocalEvent({
					type: "retry",
					attempt: event.attempt,
					attempts: event.attempts,
					delayMs: event.delayMs,
					nextAttempt: event.nextAttempt,
				});
			},
		});
		if (!this.pruneBoundToTurnEnd) await this.pruneAfterTurn();
		await this.compactAfterTurn();
		return result;
	}

	async runRequest(input: AgentRequestInput, promptOptions?: AgentHarnessPromptOptions): Promise<AgentRequestResult> {
		return await runAgentRequest({
			prompt: async (text, options) => await this.prompt(
				text,
				markLifecycleInternalPrompt(
					(options as AgentHarnessPromptOptions | undefined) ?? promptOptions,
				),
			),
			promptTaskAttempt: async (taskContract, text, options) => await this.withActiveTaskToolNames(
				taskContract.allowedTools,
				() => this.prompt(
					text,
					markLifecycleInternalPrompt(
						(options as AgentHarnessPromptOptions | undefined) ?? promptOptions,
					),
				),
			),
			skill: async (name, additionalInstructions) => await this.skill(name, additionalInstructions),
		}, input, this.requestLifecycle);
	}

	getActiveTaskToolNames(): readonly string[] | undefined {
		return this.activeTaskToolNames ? [...this.activeTaskToolNames] : undefined;
	}

	private async withActiveTaskToolNames<T>(
		toolNames: readonly string[] | undefined,
		fn: () => Promise<T>,
	): Promise<T> {
		const previous = this.activeTaskToolNames;
		this.activeTaskToolNames = toolNames ? [...toolNames] : undefined;
		try {
			return await fn();
		} finally {
			this.activeTaskToolNames = previous;
		}
	}

	private assistantTextMessage(text: string): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-completions",
			provider: this.config.provider,
			model: this.config.modelId,
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

	subscribe(listener: (event: AgentHarnessEvent, signal?: AbortSignal) => Promise<void> | void): () => void {
		this.localListeners.add(listener);
		const unsubscribeInner = this.inner.subscribe(listener);
		return () => {
			this.localListeners.delete(listener);
			unsubscribeInner();
		};
	}

	on<TType extends keyof AgentHarnessEventResultMap>(
		type: TType,
		handler: (
			event: Extract<AgentHarnessOwnEvent, { type: TType }>,
		) => Promise<AgentHarnessEventResultMap[TType]> | AgentHarnessEventResultMap[TType],
	): () => void {
		return this.inner.on(type, handler);
	}

	async abort(): Promise<AbortResult> {
		return await this.inner.abort();
	}

	getModel(): Model<Api> | undefined {
		return this.inner.getModel?.();
	}

	async setModel(provider: KnownProvider, modelId: string): Promise<void> {
		if (!this.inner.setModel) throw new Error("model changes unsupported");
		await this.inner.setModel(resolveModel(provider, modelId));
	}

	getThinkingLevel(): ThinkingLevel | undefined {
		return this.inner.getThinkingLevel?.();
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		if (!this.inner.setThinkingLevel) throw new Error("thinking changes unsupported");
		await this.inner.setThinkingLevel(level);
	}

	async compact(customInstructions?: string): Promise<CompactResult> {
		if (!this.inner.compact) throw new Error("compaction unsupported");
		return await this.inner.compact(customInstructions);
	}

	async skill(name: string, additionalInstructions?: string): Promise<AssistantMessage> {
		if (!this.inner.skill) throw new Error("skills unsupported");
		return await this.inner.skill(name, additionalInstructions);
	}

	async promptFromTemplate(name: string, args?: string[]): Promise<AssistantMessage> {
		if (!this.inner.promptFromTemplate) throw new Error("prompt templates unsupported");
		return await this.inner.promptFromTemplate(name, args);
	}

	getResources(): AgentHarnessResources<Skill, PromptTemplate> | undefined {
		const resources = this.inner.getResources?.();
		return resources ? cloneResources(resources) : undefined;
	}

	async setResources(resources: AgentHarnessResources): Promise<void> {
		if (!this.inner.setResources) throw new Error("resources unsupported");
		await this.inner.setResources(cloneResources(resources));
	}

	addDisposer(disposer: () => void | Promise<void>): void {
		this.disposers.push(disposer);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		for (const unsubscribe of this.unsubscribes.splice(0).reverse()) unsubscribe();
		for (const disposer of this.disposers.splice(0).reverse()) await disposer();
		await this.env?.cleanup();
	}

	getInner(): GenericHarnessInner {
		return this.inner;
	}

	getRequestLifecycleDeps(): AgentRequestDeps {
		return this.requestLifecycle;
	}

	getSession(): Session | undefined {
		return this.session;
	}

	getConfig(): ResolvedHarnessConfig {
		return {
			...this.config,
			apiHeaders: this.config.apiHeaders ? { ...this.config.apiHeaders } : undefined,
			streamOptions: this.config.streamOptions ? { ...this.config.streamOptions } : undefined,
			tools: this.config.tools ? [...this.config.tools] : undefined,
			toolRegistrations: this.config.toolRegistrations ? [...this.config.toolRegistrations] : undefined,
			activeToolNames: this.config.activeToolNames ? [...this.config.activeToolNames] : undefined,
			resources: this.config.resources ? cloneResources(this.config.resources) : undefined,
			sandbox: this.config.sandbox
				? { ...this.config.sandbox, roots: this.config.sandbox.roots ? [...this.config.sandbox.roots] : undefined }
				: undefined,
			policy: {
				defaults: { ...this.config.policy.defaults },
				tools: this.config.policy.tools ? { ...this.config.policy.tools } : undefined,
				rules: this.config.policy.rules ? this.config.policy.rules.map((rule) => ({ ...rule })) : undefined,
			},
			permissionProfile: this.config.permissionProfile,
			commandRules: this.config.commandRules ? [...this.config.commandRules] : undefined,
			runPolicy: this.config.runPolicy
				? {
						...this.config.runPolicy,
						budget: this.config.runPolicy.budget ? { ...this.config.runPolicy.budget } : undefined,
						repairLimits: this.config.runPolicy.repairLimits ? { ...this.config.runPolicy.repairLimits } : undefined,
						gateTiers: this.config.runPolicy.gateTiers ? { ...this.config.runPolicy.gateTiers } : undefined,
					}
				: undefined,
			tokenBudgetRatios: this.config.tokenBudgetRatios ? { ...this.config.tokenBudgetRatios } : undefined,
			compaction: this.config.compaction ? { ...this.config.compaction } : undefined,
			pruning: { ...this.config.pruning },
			cache: this.config.cache ? { ...this.config.cache } : undefined,
			retry: this.config.retry ? { ...this.config.retry } : undefined,
			budget: this.config.budget ? { ...this.config.budget } : undefined,
			eventLog: this.config.eventLog ? { ...this.config.eventLog } : undefined,
			database: this.config.database ? { ...this.config.database } : undefined,
			scheduler: this.config.scheduler
				? {
						...this.config.scheduler,
						tasks: this.config.scheduler.tasks ? [...this.config.scheduler.tasks] : undefined,
					}
				: undefined,
			reviewLoop: this.config.reviewLoop
				? {
						...this.config.reviewLoop,
						runPolicy: this.config.reviewLoop.runPolicy
							? {
									...this.config.reviewLoop.runPolicy,
									budget: this.config.reviewLoop.runPolicy.budget
										? { ...this.config.reviewLoop.runPolicy.budget }
										: undefined,
									repairLimits: this.config.reviewLoop.runPolicy.repairLimits
										? { ...this.config.reviewLoop.runPolicy.repairLimits }
										: undefined,
									gateTiers: this.config.reviewLoop.runPolicy.gateTiers
										? { ...this.config.reviewLoop.runPolicy.gateTiers }
										: undefined,
								}
							: undefined,
					}
				: undefined,
			internal: this.config.internal
				? {
						spawnAgentDepth: this.config.internal.spawnAgentDepth,
						inheritedPolicy: this.config.internal.inheritedPolicy
							? {
									defaults: this.config.internal.inheritedPolicy.defaults
										? { ...this.config.internal.inheritedPolicy.defaults }
										: undefined,
									tools: this.config.internal.inheritedPolicy.tools
										? { ...this.config.internal.inheritedPolicy.tools }
										: undefined,
									rules: this.config.internal.inheritedPolicy.rules
										? this.config.internal.inheritedPolicy.rules.map((rule) => ({ ...rule }))
										: undefined,
								}
							: undefined,
					}
				: undefined,
		};
	}

	getCacheReport(): string {
		return this.cacheReportTracker.render();
	}

	getCostSummary(): CostSummary {
		return this.costTracker.getSummary();
	}

	private installInternalSubscriptions(): void {
		if (this.config.eventLog?.enabled !== false && this.config.eventLog?.filePath) {
			const eventLog = new EventLog({ filePath: this.config.eventLog.filePath });
			const localLogListener = async (event: AgentHarnessEvent, signal?: AbortSignal): Promise<void> => {
				await eventLog.handleEvent(event as ObservabilityEvent, signal);
			};
			this.localListeners.add(localLogListener);
			const unsubscribeInnerLog = this.inner.subscribe((event, signal) => {
				void eventLog.handleEvent(event as ObservabilityEvent, signal);
			});
			this.unsubscribes.push(() => {
				this.localListeners.delete(localLogListener);
				unsubscribeInnerLog();
			});
		}
		this.unsubscribes.push(
			this.inner.subscribe(async (event) => {
				const observabilityEvent = event as ObservabilityEvent;
				this.budgetTracker?.handleEvent(observabilityEvent);
				this.costTracker.handleEvent(observabilityEvent);
				if (event.type === "queue_update") {
					this.pruneExecutor?.handleQueueUpdate(event);
				}
				if (event.type === "turn_end") {
					const turn = this.costTracker.getLastTurn();
					if (turn) this.cacheReportTracker.recordTurn(turn);
					await this.pruneAfterTurn();
				}
			}),
		);
		this.pruneBoundToTurnEnd = true;
	}

	private configurePruneExecutor(session: Session | undefined, prewarm?: () => Promise<void>): void {
		if (!this.config.pruning.enabled || !session) return;
		this.pruneExecutor = new PruneExecutor({
			config: this.config.pruning,
			prewarm,
			session,
		});
	}

	private async prewarmPrunedContext(defaultModel: Model<Api>, activeTools: AgentTool[] | undefined): Promise<void> {
		if (!this.session) return;
		const model = this.inner.getModel?.() ?? defaultModel;
		const auth = await resolveApiKeyAndHeaders({
			apiKey: this.config.apiKey,
			apiHeaders: this.config.apiHeaders,
			provider: model.provider,
		});
		const context = await this.session.buildContext();
		const metadata = await this.session.getMetadata();
		const messages = this.pruneExecutor?.rewriteContext(context.messages) ?? context.messages;
		const response = await completeSimple(
			model,
			{
				systemPrompt: this.config.systemPrompt,
				messages: toLlmMessages(messages),
				tools: toProviderTools(activeTools),
			},
			buildPrewarmStreamOptions({
				auth,
				config: this.config,
				model,
				sessionId: metadata.id,
			}),
		);
		const failure = assistantMessageError(response);
		if (failure) throw failure;
	}

	private async compactAfterTurn(): Promise<void> {
		if (!this.session || !this.inner.compact) return;
		const contextWindow = this.config.contextWindow ?? resolveHarnessModel(this.config).contextWindow;
		const policy = new CompactionPolicy({
			contextWindow,
			ratios: this.config.tokenBudgetRatios,
			...this.config.compaction,
		});
		const context = await this.session.buildContext();
		const messages = this.pruneExecutor?.rewriteContext(context.messages) ?? context.messages;
		if (!policy.shouldCompact(messages)) return;
		await this.inner.compact(this.buildLifecycleCompactionInstructions(messages));
	}

	private buildLifecycleCompactionInstructions(messages: AgentMessage[]): string {
		const summary = createFullCompactionSummary({
			sections: {
				"Main request & user intent": "Summarize the active request and preserve the user's intent.",
				"Key technical concepts": "Preserve important APIs, lifecycle stages, constraints, and invariants.",
				"Files & code": "Preserve concrete file paths, symbols, and code decisions.",
				"Pitfalls encountered & fixes": "Preserve failed checks, fixes applied, and unresolved risks.",
				"Problem-solving process": "Preserve the sequence of decisions and verification evidence.",
				"All user information, itemized": "Preserve explicit user preferences, constraints, and corrections.",
				"Pending tasks": "Preserve incomplete work and required next actions.",
				"What is currently being worked on": "Preserve the current implementation focus.",
			},
			originalNextStepWording: lastUserText(messages) ?? "",
			recentTurns: messages,
			protectedTurnCount: 10,
		});
		const customInstructions = this.config.compaction?.customInstructions;
		return [
			...(customInstructions ? ["Custom instructions:", customInstructions, ""] : []),
			"full_compaction_summary",
			...summary.sections.map((section) => `## ${section.title}\n${section.content}`),
			"",
			"Protected recent turns:",
			...summary.protectedRecentTurns.map((message, index) => `${index + 1}. ${messageText(message)}`),
		].join("\n");
	}

	private async pruneAfterTurn(): Promise<void> {
		if (!this.pruneExecutor) return;
		const pruned = await this.pruneExecutor.handleTurnEnd({
			turnIndex: this.costTracker.getLastTurn()?.turnIndex,
		});
		if (!pruned) return;
		const event = this.pruneExecutor.getLastEvent();
		if (!event) return;
		if (typeof event.turnIndex === "number") {
			this.cacheReportTracker.recordPruneEvent({
				turnIndex: event.turnIndex,
				spans: event.spans,
				tokensRemoved: event.tokensRemoved,
				tokensAfterPrunePoint: event.tokensAfterPrunePoint,
				predictedOneTimeCostUsd: this.predictedInputCostUsd(event.predictedOneTimeCostTokens),
			});
		}
		await this.emitLocalEvent({ type: "prune", ...event });
	}

	private predictedInputCostUsd(tokens: number): number {
		return (resolveHarnessModel(this.config).cost.input / 1_000_000) * tokens;
	}

	private async emitLocalEvent(event: Record<string, unknown>): Promise<void> {
		const harnessEvent = event as AgentHarnessEvent;
		for (const listener of this.localListeners) {
			await listener(harnessEvent);
		}
	}

	private async restoreSessionLeaf(leafId: string | null | undefined): Promise<void> {
		if (!this.session || leafId === undefined) return;
		if ((await this.session.getLeafId()) === leafId) return;
		await this.session.moveTo(leafId);
	}
}

function assistantMessageError(message: AssistantMessage): AssistantMessageError | undefined {
	if (message.stopReason !== "error") return undefined;
	const errorMessage = message.errorMessage ?? "provider returned an error";
	return new AssistantMessageError(errorMessage, extractStatusCode(errorMessage));
}

function extractStatusCode(message: string): number | undefined {
	const match = /\b([1-5][0-9]{2})\b/.exec(message);
	if (!match) return undefined;
	const status = Number(match[1]);
	return Number.isFinite(status) ? status : undefined;
}

function toLlmMessages(messages: readonly AgentMessage[]): Message[] {
	const result: Message[] = [];
	for (const message of messages) {
		const role = asRecord(message)?.role;
		if (role === "user" || role === "assistant" || role === "toolResult") {
			result.push(message as unknown as Message);
		}
	}
	return result;
}

function toProviderTools(tools: readonly AgentTool[] | undefined): Tool[] | undefined {
	return tools?.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
}

function selectActiveTools(tools: AgentTool[] | undefined, activeToolNames: readonly string[] | undefined): AgentTool[] | undefined {
	if (!tools) return undefined;
	if (!activeToolNames) return tools;
	const activeNames = new Set(activeToolNames);
	return tools.filter((tool) => activeNames.has(tool.name));
}

function cloneStreamOptions(streamOptions: AgentHarnessStreamOptions): AgentHarnessStreamOptions {
	return {
		...streamOptions,
		headers: streamOptions.headers ? { ...streamOptions.headers } : undefined,
		metadata: streamOptions.metadata ? { ...streamOptions.metadata } : undefined,
	};
}

function applyStreamOptionsPatch(
	base: AgentHarnessStreamOptions,
	patch?: AgentHarnessStreamOptionsPatch,
): AgentHarnessStreamOptions {
	const result = cloneStreamOptions(base);
	if (!patch) return result;
	if (Object.hasOwn(patch, "transport")) result.transport = patch.transport;
	if (Object.hasOwn(patch, "timeoutMs")) result.timeoutMs = patch.timeoutMs;
	if (Object.hasOwn(patch, "maxRetries")) result.maxRetries = patch.maxRetries;
	if (Object.hasOwn(patch, "maxRetryDelayMs")) result.maxRetryDelayMs = patch.maxRetryDelayMs;
	if (Object.hasOwn(patch, "cacheRetention")) result.cacheRetention = patch.cacheRetention;
	if (Object.hasOwn(patch, "headers")) result.headers = applyHeadersPatch(result.headers, patch.headers);
	if (Object.hasOwn(patch, "metadata")) result.metadata = applyMetadataPatch(result.metadata, patch.metadata);
	return result;
}

function mergeHeaders(...headers: Array<Record<string, string> | undefined>): Record<string, string> | undefined {
	const merged: Record<string, string> = {};
	for (const entry of headers) {
		if (entry) Object.assign(merged, entry);
	}
	return Object.keys(merged).length > 0 ? merged : undefined;
}

function applyHeadersPatch(
	base: Record<string, string> | undefined,
	patch: Record<string, string | undefined> | undefined,
): Record<string, string> | undefined {
	if (patch === undefined) return undefined;
	const headers = { ...(base ?? {}) };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) delete headers[key];
		else headers[key] = value;
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function applyMetadataPatch(
	base: Record<string, unknown> | undefined,
	patch: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (patch === undefined) return undefined;
	const metadata = { ...(base ?? {}) };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) delete metadata[key];
		else metadata[key] = value;
	}
	return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function providerReasoning(level: ThinkingLevel): SimpleStreamOptions["reasoning"] | undefined {
	return level === "off" ? undefined : (level as SimpleStreamOptions["reasoning"]);
}

function lastUserText(messages: readonly AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (asRecord(message)?.role === "user") return messageText(message);
	}
	return undefined;
}

function messageText(message: AgentMessage | undefined): string {
	const record = asRecord(message);
	if (!record) return "";
	const content = record.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const partRecord = asRecord(part);
			if (partRecord?.type === "text" && typeof partRecord.text === "string") return partRecord.text;
			if (partRecord?.type === "toolCall") return JSON.stringify(partRecord);
			return "";
		})
		.filter(Boolean)
		.join(" ");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function cloneResources(resources: AgentHarnessResources): AgentHarnessResources {
	return {
		promptTemplates: resources.promptTemplates ? [...resources.promptTemplates] : undefined,
		skills: resources.skills ? [...resources.skills] : undefined,
	};
}

export async function createGenericHarness(config?: HarnessConfig): Promise<GenericHarness> {
	const resolvedConfig = resolveHarnessConfig(config);
	const { env, session } = await createJsonlSession({
		cwd: resolvedConfig.cwd,
		sessionsRoot: resolvedConfig.sessionsRoot,
	});
	return await createGenericHarnessFromSession(resolvedConfig, env, session);
}

export async function createGenericHarnessFromSession(
	config: HarnessConfig,
	env: ExecutionEnv,
	session: Session,
	runtimeOptions: GenericHarnessRuntimeOptions = {},
): Promise<GenericHarness> {
	const resolvedConfig = resolveHarnessConfig(config);
	const metadata = await session.getMetadata();
	const eventLog =
		resolvedConfig.eventLog?.enabled === false
			? resolvedConfig.eventLog
			: {
					...resolvedConfig.eventLog,
					filePath:
						resolvedConfig.eventLog?.filePath ??
						createSessionEventLogPath(
							isAbsolute(resolvedConfig.sessionsRoot)
								? resolvedConfig.sessionsRoot
								: resolve(resolvedConfig.cwd, resolvedConfig.sessionsRoot),
							metadata.id,
						),
				};
	return new GenericHarness({ config: { ...resolvedConfig, eventLog }, env, session, ...runtimeOptions });
}
