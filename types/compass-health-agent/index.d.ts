/**
 * Fallback type surface for the OPTIONAL `compass-health-agent` package.
 *
 * The real package is a private sibling project installed via a `file:` optional
 * dependency. When it is present, tsconfig `paths` resolves its real `dist/*.d.ts`
 * first and these stubs are never used. When it is absent, these stubs keep
 * `npm run check` and `npm run build` green; the compass-health profile then
 * fails to load at runtime and is skipped by the profile registry.
 */
import type { AgentProfile } from "../../src/agents/profile.ts";

export interface CompassHealthToolContext {
	close(): Promise<void>;
	[key: string]: unknown;
}

export declare const compassHealthProfileSpec: Pick<
	AgentProfile,
	"name" | "description" | "systemPrompt" | "model" | "thinkingLevel" | "policy" | "context" | "scheduledTasks"
>;

export declare function createToolContextFromEnv(): Promise<CompassHealthToolContext>;
