import type { Api, Model } from "@earendil-works/pi-ai";
import type { HarnessPolicy, HarnessSpecialization, ThinkingLevel, ToolRegistration } from "./types.ts";

export const CODING_SPECIALIZATION_PROMPT =
	"You are a software engineering assistant. Prefer small, reviewed changes, preserve user work, and verify behavior before reporting completion.";

export interface CodingSpecializationOptions<TTool = ToolRegistration> {
	tools?: readonly TTool[];
	systemPrompt?: string;
	defaultModel?: Model<Api>;
	defaultThinkingLevel?: ThinkingLevel;
	policy?: HarnessPolicy;
}

export function createCodingSpecialization<TTool = ToolRegistration>(
	options: CodingSpecializationOptions<TTool> = {},
): HarnessSpecialization<TTool> {
	return {
		name: "coding",
		tools: options.tools ? [...options.tools] : undefined,
		systemPrompt: [CODING_SPECIALIZATION_PROMPT, options.systemPrompt].filter(Boolean).join("\n\n"),
		defaultModel: options.defaultModel,
		defaultThinkingLevel: options.defaultThinkingLevel,
		policy: options.policy,
	};
}
