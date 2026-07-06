import { decide } from "../policy/decide.ts";
import { resolveSubjectDetails } from "../policy/subject.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
	HarnessToolCallEvent,
	HarnessToolCallSubscriber,
	PermissionGateOptions,
	PermissionPolicy,
	ToolCallPermissionResult,
	ToolPermissionDecisionLookup,
	ToolPermissionDecisionRecord,
} from "./types.ts";
import type { ToolRegistry } from "./registry.ts";

export class ToolPermissionDecisionStore {
	private readonly decisions = new Map<string, ToolPermissionDecisionRecord>();

	record(decision: ToolPermissionDecisionRecord): void {
		this.decisions.set(decision.toolCallId, {
			...decision,
			allowed: { ...decision.allowed },
			writeScope: decision.writeScope ? [...decision.writeScope] : undefined,
		});
	}

	lookup: ToolPermissionDecisionLookup = (toolCallId) => {
		const decision = this.decisions.get(toolCallId);
		return decision
			? {
					...decision,
					allowed: { ...decision.allowed },
					writeScope: decision.writeScope ? [...decision.writeScope] : undefined,
				}
			: undefined;
	};
}

export class PermissionGate {
	private registry: ToolRegistry;
	private policy: PermissionPolicy;
	private options: PermissionGateOptions;
	private askQueue: Promise<void> = Promise.resolve();

	constructor(registry: ToolRegistry, policy: PermissionPolicy, options: PermissionGateOptions = {}) {
		this.registry = registry;
		this.policy = {
			defaults: { ...policy.defaults },
			tools: policy.tools ? { ...policy.tools } : undefined,
			rules: policy.rules ? policy.rules.map((rule) => ({ ...rule })) : undefined,
		};
		this.options = { ...options };
	}

	install(harness: HarnessToolCallSubscriber): () => void {
		return harness.on("tool_call", (event) => this.handleToolCall(event));
	}

	guardTool<TTool extends AgentTool>(tool: TTool): TTool {
		return {
			...tool,
			execute: async (toolCallId, params, signal, onUpdate) => {
				const decision = await this.handleToolCall({
					type: "tool_call",
					toolCallId,
					toolName: tool.name,
					input: toInputRecord(params),
				});
				if (decision?.block) throw new Error(decision.reason ?? `Tool ${tool.name} was blocked`);
				return await tool.execute(toolCallId, params, signal, onUpdate);
			},
		};
	}

	guardTools<TTool extends AgentTool>(tools: readonly TTool[]): TTool[] {
		return tools.map((tool) => this.guardTool(tool));
	}

	async handleToolCall(event: HarnessToolCallEvent): Promise<ToolCallPermissionResult | undefined> {
		const registration = this.registry.getRegistration(event.toolName);
		if (!registration) return { block: true, reason: `Unknown tool ${event.toolName}` };
		const activeToolNames = this.options.getActiveToolNames?.();
		if (activeToolNames && !activeToolNames.includes(event.toolName)) {
			return { block: true, reason: `Tool ${event.toolName} is not allowed for this task` };
		}

		const resolvedSubject = resolveSubjectDetails(event.input);
		const subject = resolvedSubject.subject;
		const activeLease = this.options.getActiveLease?.();
		const decision = decide(this.policy, event.toolName, subject, {
			accessLevel: registration.accessLevel,
			permissionOverride: registration.permissionOverride,
			subjectIsPath: resolvedSubject.isPath,
			writeScope: activeLease?.writeScope,
		});
		const decisionRecord: ToolPermissionDecisionRecord = {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			subject,
			allowed: { ...decision },
			writeScope: activeLease?.writeScope ? [...activeLease.writeScope] : undefined,
		};
		this.options.onDecision?.(decisionRecord);

		if (decision.level === "deny") {
			return {
				block: true,
				reason:
					decision.ruleId === "write-scope"
						? `Tool ${event.toolName} is denied by write scope`
						: `Tool ${event.toolName} is denied by policy`,
			};
		}
		if (decision.level === "allow") return undefined;

		const approved = await this.runAskCallback(event.toolName, event.input, subject);
		return approved ? undefined : { block: true, reason: `Tool ${event.toolName} requires approval` };
	}

	private async runAskCallback(
		toolName: string,
		input: Record<string, unknown>,
		subject: string,
	): Promise<boolean | undefined> {
		if (!this.options.askCallback) return undefined;
		const previous = this.askQueue;
		let release: () => void = () => undefined;
		this.askQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await this.options.askCallback(toolName, { ...input }, subject ? { subject } : undefined);
		} finally {
			release();
		}
	}
}

function toInputRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	return { ...(value as Record<string, unknown>) };
}
