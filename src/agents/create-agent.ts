import type {
	AgentHarnessResources,
	ExecutionEnv,
	JsonlSessionMetadata,
	Session,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { createJsonlSession } from "../session/factory.ts";
import type { HarnessConfig, ResolvedHarnessConfig } from "../config.ts";
import type { TaskContract } from "../contract/index.ts";
import { resolveHarnessConfig } from "../config.ts";
import { createExecutionEnvCheckpointStore } from "../checkpoint/index.ts";
import {
	createEvidenceGateway,
	createEvidenceReceiptCollector,
	recordEvidenceGatewayEntries,
	type EvidenceGateway,
	type EvidenceManifestEntry,
	type EvidenceReceiptCollector,
} from "../evidence/index.ts";
import { createReceiptLedger } from "../feedback/index.ts";
import { GenericHarness, createGenericHarnessFromSession, type GenericHarnessRuntimeOptions } from "../harness.ts";
import type { RequestLifecycleRuntimeOptions } from "../lifecycle/index.ts";
import { BudgetTracker } from "../observability/budget.ts";
import { CostTracker } from "../observability/cost-tracker.ts";
import { createFileLoopPersistence } from "../orchestration/index.ts";
import { createSpawnedReviewerAgent } from "../review/index.ts";
import { createFileTraceSink } from "../trace/index.ts";
import { PermissionGate, ToolPermissionDecisionStore } from "../tools/permission.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { StoredToolRegistration, ToolAccessLevel, ToolPermissionDecisionLookup, ToolRegistration } from "../tools/types.ts";
import { mergeAgentProfileConfig, mergeStricterPolicies, type ToolAccessMap } from "./merge.ts";
import type { AgentProfile, AgentToolDefinition } from "./profile.ts";
import { getProfile } from "./registry.ts";

export interface CreateAgentOptions extends HarnessConfig, GenericHarnessRuntimeOptions {
	env?: ExecutionEnv;
	session?: Session<JsonlSessionMetadata>;
}

function mergeResources(
	profile: AgentProfile,
	config: ResolvedHarnessConfig,
): AgentHarnessResources | undefined {
	const skills = [...(profile.skills ?? []), ...(config.resources?.skills ?? [])];
	const promptTemplates = [...(profile.templates ?? []), ...(config.resources?.promptTemplates ?? [])];
	if (skills.length === 0 && promptTemplates.length === 0) return config.resources;
	return {
		skills: skills.length > 0 ? skills : undefined,
		promptTemplates: promptTemplates.length > 0 ? promptTemplates : undefined,
	};
}

function isToolRegistrationList(
	value: ToolRegistration | readonly ToolRegistration[],
): value is readonly ToolRegistration[] {
	return Array.isArray(value);
}

async function resolveToolDefinition(
	definition: AgentToolDefinition,
	env: ExecutionEnv,
	config: ResolvedHarnessConfig,
	runtime: GenericHarnessRuntimeOptions & { getPermissionDecision: ToolPermissionDecisionLookup },
): Promise<readonly ToolRegistration[]> {
	if (typeof definition !== "function") return [definition];
	const result = await definition({ env, config, ...runtime });
	if (isToolRegistrationList(result)) return result;
	return [result];
}

async function createRegistry(
	profile: AgentProfile,
	env: ExecutionEnv,
	config: ResolvedHarnessConfig,
	runtime: GenericHarnessRuntimeOptions & { getPermissionDecision: ToolPermissionDecisionLookup },
): Promise<ToolRegistry | undefined> {
	if (!profile.tools || profile.tools.length === 0) return undefined;
	const registry = new ToolRegistry();
	for (const definition of profile.tools) {
		const registrations = await resolveToolDefinition(definition, env, config, runtime);
		for (const registration of registrations) registry.register(registration);
	}
	return registry;
}

async function createSession(
	config: ResolvedHarnessConfig,
	options: CreateAgentOptions,
): Promise<{ env: ExecutionEnv; session: Session<JsonlSessionMetadata> }> {
	if (options.env && options.session) return { env: options.env, session: options.session };
	if (options.env || options.session) throw new Error("createAgent requires both env and session when either is provided");
	return await createJsonlSession({ cwd: config.cwd, sessionsRoot: config.sessionsRoot });
}

function toolAccessMap(registrations: readonly StoredToolRegistration[] | undefined): ToolAccessMap {
	const accessByTool: Record<string, ToolAccessLevel> = {};
	for (const registration of registrations ?? []) {
		accessByTool[registration.tool.name] = registration.accessLevel;
	}
	return accessByTool;
}

export async function createAgent(profile: AgentProfile, options: CreateAgentOptions = {}): Promise<GenericHarness> {
	const {
		env: _env,
		session: _session,
		evidenceGateway,
		getActiveLease,
		requestLifecycle,
		budgetTracker: providedBudgetTracker,
		costTracker: providedCostTracker,
		...overrides
	} = options;
	const permissionDecisions = new ToolPermissionDecisionStore();
	const mergedConfig = mergeAgentProfileConfig(profile, overrides);
	const resolvedConfig = applyRunPolicyBudget(resolveHarnessConfig(mergedConfig));
	const budgetTracker = providedBudgetTracker ?? (resolvedConfig.budget ? new BudgetTracker(resolvedConfig.budget) : undefined);
	const costTracker = providedCostTracker ?? new CostTracker();
	const { env, session } = await createSession(resolvedConfig, options);
	const baseEvidenceGateway = evidenceGateway ?? await createDefaultEvidenceGatewayIfNeeded({
		config: resolvedConfig,
		env,
		session,
		requestLifecycle,
	});
	const effectiveRequestLifecycle = await buildRequestLifecycleRuntime({
		profile,
		env,
		session,
		config: resolvedConfig,
		requestLifecycle,
		evidenceGateway: baseEvidenceGateway,
		getActiveLease,
		budgetTracker,
		costTracker,
	});
	const runtimeEvidenceGateway = recordEvidenceGatewayEntries(
		baseEvidenceGateway,
		effectiveRequestLifecycle?.workerReviewerLoop?.receiptCollector,
	);
	const runtimeOptions: GenericHarnessRuntimeOptions = {
		...(runtimeEvidenceGateway ? { evidenceGateway: runtimeEvidenceGateway } : {}),
		...(getActiveLease ? { getActiveLease } : {}),
		...(effectiveRequestLifecycle ? { requestLifecycle: effectiveRequestLifecycle } : {}),
		...(effectiveRequestLifecycle?.workerReviewerLoop?.checkpoint
			? { checkpoint: effectiveRequestLifecycle.workerReviewerLoop.checkpoint }
			: {}),
		...(budgetTracker ? { budgetTracker } : {}),
		costTracker,
		...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
	};
	const registry = await createRegistry(profile, env, resolvedConfig, {
		...runtimeOptions,
		getPermissionDecision: permissionDecisions.lookup,
	});
	const registrations = registry?.listRegistrations();
	const profileTools = registry?.toAgentTools() ?? [];
	const tools = profileTools.length > 0 || resolvedConfig.tools
		? [...profileTools, ...(resolvedConfig.tools ?? [])]
		: undefined;
	const policy = resolvedConfig.internal?.inheritedPolicy
		? mergeStricterPolicies(resolvedConfig.internal.inheritedPolicy, profile.policy, toolAccessMap(registrations))
		: resolvedConfig.policy;
	const config: HarnessConfig = {
		...resolvedConfig,
		policy,
		resources: mergeResources(profile, resolvedConfig),
		tools,
		toolRegistrations: registrations,
		useDefaultTools: tools === undefined ? resolvedConfig.useDefaultTools : false,
	};
	const harness = await createGenericHarnessFromSession(config, env, session, runtimeOptions);
	if (registry) {
		harness.addDisposer(
			new PermissionGate(registry, harness.getConfig().policy, {
				askCallback: harness.getConfig().askPermission,
				getActiveLease,
				getActiveToolNames: () => harness.getActiveTaskToolNames(),
				onDecision: (decision) => permissionDecisions.record(decision),
			}).install(harness),
		);
	}
	const disposer = await profile.install?.(harness);
	if (disposer) harness.addDisposer(disposer);
	return harness;
}

interface BuildRequestLifecycleRuntimeInput {
	profile: AgentProfile;
	env: ExecutionEnv;
	session: Session<JsonlSessionMetadata>;
	config: ResolvedHarnessConfig;
	requestLifecycle?: RequestLifecycleRuntimeOptions;
	evidenceGateway?: GenericHarnessRuntimeOptions["evidenceGateway"];
	getActiveLease?: GenericHarnessRuntimeOptions["getActiveLease"];
	budgetTracker?: BudgetTracker;
	costTracker?: CostTracker;
}

async function buildRequestLifecycleRuntime(
	input: BuildRequestLifecycleRuntimeInput,
): Promise<RequestLifecycleRuntimeOptions | undefined> {
	if (input.requestLifecycle?.workerReviewerLoop || input.config.reviewLoop?.enabled !== true) {
		return input.requestLifecycle;
	}
	const metadata = await input.session.getMetadata();
	const runId = safeRunId(metadata.id);
	const sessionsRoot = isAbsolute(input.config.sessionsRoot)
		? input.config.sessionsRoot
		: resolve(input.config.cwd, input.config.sessionsRoot);
	const runPolicy = input.config.reviewLoop.runPolicy ?? input.config.runPolicy;
	const persistence = createFileLoopPersistence({
		rootDir: join(sessionsRoot, runId),
		runId,
	});
	const trace = input.requestLifecycle?.trace ?? createFileTraceSink({
		runId,
		filePath: join(sessionsRoot, runId, "worker-reviewer-trace.jsonl"),
	});
	const checkpoint = createExecutionEnvCheckpointStore({
		env: input.env,
		roots: input.config.sandbox?.roots,
	});
	const receiptCollector = createEvidenceReceiptCollector();
	const reviewerAgent = createSpawnedReviewerAgent({
		profile: input.config.reviewLoop.reviewerProfile ?? input.profile.name,
		maxTurns: input.config.reviewLoop.reviewerMaxTurns ?? 3,
		spawnAgent: async (spawnInput) => {
			const child = await createAgent(resolveReviewerProfile(spawnInput.profile, input.profile), {
				...input.config,
				activeToolNames: spawnInput.task_contract?.allowedTools
					? [...spawnInput.task_contract.allowedTools]
					: ["read", "grep", "glob"],
				evidenceGateway: input.evidenceGateway,
				getActiveLease: input.getActiveLease,
				budgetTracker: input.budgetTracker,
				costTracker: input.costTracker,
				reviewLoop: { enabled: false },
			});
			try {
				const message = await child.prompt(spawnInput.prompt, {
					maxTurns: spawnInput.max_turns,
				} as Parameters<GenericHarness["prompt"]>[1]);
				return { text: assistantText(message) };
			} finally {
				await child.dispose();
			}
		},
	});
	return {
		...(input.requestLifecycle ?? {}),
		trace,
		workerReviewerLoop: {
			checkpoint,
			ledger: createReceiptLedger(),
			receiptCollector,
			...(input.evidenceGateway
				? {
						captureTaskAttemptEvidence: async ({ attempt, taskContract, message }) =>
							await captureSanitizedTaskAttemptEvidence({
								evidenceGateway: input.evidenceGateway!,
								receiptCollector,
								attempt,
								taskContract,
								message,
							}),
					}
				: {}),
			maxAttempts: input.config.reviewLoop.maxAttempts ?? runPolicy?.repairLimits?.maxAttempts,
			maxTurns: input.config.reviewLoop.maxTurns ?? runPolicy?.budget?.maxTurns,
			...(input.budgetTracker ? { budget: input.budgetTracker } : {}),
			policy: runPolicy,
			runPolicy,
			humanGate: {
				persistence,
				requestDecision: async (request) => {
					const decisions = await persistence.loadHumanDecisions();
					return decisions.find((decision) =>
						(decision.requestId === request.id || decision.requestId === undefined) &&
						(decision.action === "resume" || decision.action === "abort")
					);
				},
			},
			reviewer: async ({ input: reviewerInput }) => await reviewerAgent.review(reviewerInput),
		},
	};
}

async function captureSanitizedTaskAttemptEvidence(input: {
	evidenceGateway: EvidenceGateway;
	receiptCollector: EvidenceReceiptCollector;
	attempt: number;
	taskContract: TaskContract;
	message: AssistantMessage;
}): Promise<EvidenceManifestEntry> {
	const assignmentDigest = taskContractDigest(input.taskContract);
	const entry = await input.evidenceGateway.captureOutput({
		id: `task-attempt-${input.attempt}-${assignmentDigest.slice(0, 12)}`,
		command: "pi-harness task-contract attempt summary",
		subject: "TaskContract attempt summary",
		allowed: { level: "allow", ruleId: "task-contract-summary" },
		writeScope: input.taskContract.writeScope,
		actualWritePaths: [],
		assignmentDigest,
		stdout: JSON.stringify({
			schema: "pi-harness.task-attempt-summary.v1",
			attempt: input.attempt,
			assignmentDigest,
			assignedSkill: input.taskContract.assignedSkill,
			allowedTools: input.taskContract.allowedTools ?? [],
			writeScopeCount: input.taskContract.writeScope.length,
			gateTier: input.taskContract.gateTier,
			stopReason: input.message.stopReason,
			usage: {
				inputTokens: input.message.usage.input,
				outputTokens: input.message.usage.output,
				costUsd: input.message.usage.cost.total,
			},
		}),
		stderr: "",
		exitCode: input.message.stopReason === "error" ? 1 : 0,
	});
	input.receiptCollector.record(entry);
	return entry;
}

function taskContractDigest(taskContract: TaskContract): string {
	return createHash("sha256").update(JSON.stringify(taskContract)).digest("hex");
}

function resolveReviewerProfile(name: string, parentProfile: AgentProfile): AgentProfile {
	if (name === parentProfile.name) return cloneAgentProfile(parentProfile);
	return getProfile(name);
}

function cloneAgentProfile(profile: AgentProfile): AgentProfile {
	return {
		...profile,
		tools: profile.tools ? [...profile.tools] : undefined,
		policy: profile.policy
			? {
					defaults: { ...profile.policy.defaults },
					tools: profile.policy.tools ? { ...profile.policy.tools } : undefined,
					rules: profile.policy.rules ? profile.policy.rules.map((rule) => ({ ...rule })) : undefined,
				}
			: undefined,
		context: profile.context ? { ...profile.context } : undefined,
		skills: profile.skills ? [...profile.skills] : undefined,
		templates: profile.templates ? [...profile.templates] : undefined,
		scheduledTasks: profile.scheduledTasks ? [...profile.scheduledTasks] : undefined,
	};
}

function applyRunPolicyBudget(config: ResolvedHarnessConfig): ResolvedHarnessConfig {
	if (config.reviewLoop?.enabled !== true) return config;
	const runPolicy = config.reviewLoop.runPolicy ?? config.runPolicy;
	const maxUsd = runPolicy?.budget?.maxUsd;
	if (maxUsd === undefined) return config;
	return {
		...config,
		// RunPolicy is the executor contract; when set, it supplies the effective hard session budget.
		budget: {
			...(config.budget ?? {}),
			maxUsdPerSession: maxUsd,
		},
	};
}

interface DefaultEvidenceGatewayInput {
	config: ResolvedHarnessConfig;
	env: ExecutionEnv;
	session: Session<JsonlSessionMetadata>;
	requestLifecycle?: RequestLifecycleRuntimeOptions;
}

async function createDefaultEvidenceGatewayIfNeeded(
	input: DefaultEvidenceGatewayInput,
): Promise<EvidenceGateway | undefined> {
	if (input.config.reviewLoop?.enabled !== true && !input.requestLifecycle?.workerReviewerLoop) return undefined;
	const metadata = await input.session.getMetadata();
	const runId = safeRunId(metadata.id);
	const sessionsRoot = isAbsolute(input.config.sessionsRoot)
		? input.config.sessionsRoot
		: resolve(input.config.cwd, input.config.sessionsRoot);
	return createEvidenceGateway({
		env: input.env,
		rootDir: join(sessionsRoot, runId),
		runId,
		now: () => new Date(),
	});
}

function safeRunId(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-") || "run";
}

function assistantText(message: AssistantMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			if (!("type" in part) || part.type !== "text") return "";
			return "text" in part && typeof part.text === "string" ? part.text : "";
		})
		.join("");
}
