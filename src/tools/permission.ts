import { decide } from "../policy/decide.ts";
import { resolveSubjectDetails } from "../policy/subject.ts";
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

		const approved = await this.options.askCallback?.(
			event.toolName,
			{ ...event.input },
			subject ? { subject } : undefined,
		);
		return approved ? undefined : { block: true, reason: `Tool ${event.toolName} requires approval` };
	}
}
