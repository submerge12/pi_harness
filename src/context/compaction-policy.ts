import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateContextTokens } from "@earendil-works/pi-agent-core";
import { computeTokenBudget, type TokenBudgetRatios } from "./token-budget.ts";

export interface CompactionPolicyConfig {
	enabled?: boolean;
	highWaterRatio?: number;
	customInstructions?: string;
}

export interface CompactionPolicyOptions extends CompactionPolicyConfig {
	contextWindow: number;
	ratios?: TokenBudgetRatios;
}

export interface CompactionPolicyTurnEndEvent {
	messages: AgentMessage[];
}

export interface CompactionPolicyHarness {
	on(type: "turn_end", handler: (event: CompactionPolicyTurnEndEvent) => Promise<void> | void): () => void;
	compact(customInstructions?: string): Promise<unknown>;
}

export const DEFAULT_COMPACTION_POLICY: Required<Pick<CompactionPolicyConfig, "enabled" | "highWaterRatio">> = {
	enabled: true,
	highWaterRatio: 0.85,
};

export class CompactionPolicy {
	private readonly contextWindow: number;
	private readonly customInstructions?: string;
	private readonly enabled: boolean;
	private readonly highWaterRatio: number;
	private readonly ratios?: TokenBudgetRatios;

	constructor(options: CompactionPolicyOptions) {
		this.contextWindow = options.contextWindow;
		this.customInstructions = options.customInstructions;
		this.enabled = options.enabled ?? DEFAULT_COMPACTION_POLICY.enabled;
		this.highWaterRatio = options.highWaterRatio ?? DEFAULT_COMPACTION_POLICY.highWaterRatio;
		this.ratios = options.ratios;

		if (!Number.isFinite(this.highWaterRatio) || this.highWaterRatio <= 0 || this.highWaterRatio > 1) {
			throw new Error("Compaction highWaterRatio must be greater than 0 and less than or equal to 1");
		}
	}

	bind(harness: CompactionPolicyHarness): () => void {
		return harness.on("turn_end", async (event) => {
			await this.handleTurnEnd(event, harness);
		});
	}

	shouldCompact(messages: AgentMessage[]): boolean {
		if (!this.enabled) {
			return false;
		}

		const budget = computeTokenBudget(this.contextWindow, this.ratios);
		const highWaterTokens = Math.floor(budget.warm * this.highWaterRatio);
		return estimateContextTokens(messages).tokens >= highWaterTokens;
	}

	async handleTurnEnd(event: CompactionPolicyTurnEndEvent, harness: Pick<CompactionPolicyHarness, "compact">): Promise<boolean> {
		if (!this.shouldCompact(event.messages)) {
			return false;
		}

		await harness.compact(this.customInstructions);
		return true;
	}
}
