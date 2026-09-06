import type { Skill } from "@earendil-works/pi-agent-core";
import type { ResolvedHarnessConfig } from "../config.ts";
import { createFrozenPrefix, type DeclaredToolPrefixEntry, type PrefixParts } from "../context/lifecycle.ts";
import { InMemoryUserMemoryStore } from "../memory/index.ts";
import type { IntakeOptions } from "../intake/index.ts";
import type { RoutingOptions } from "../routing/index.ts";
import type { TraceSink } from "../trace/index.ts";
import { configuredTools } from "../tools/metadata.ts";
import {
	createSkillCardRegistry,
	type SkillCard,
	type SkillCardRegistry,
} from "../skills/index.ts";
import type { AgentRequestDeps, RequestMemoryOptions, RequestWorkerReviewerLoopOptions } from "./types.ts";

export interface RequestLifecycleRuntimeOptions {
	/** Automatic completion control for raw requests; TaskContracts retain their review loop. */
	goalGate?: AgentRequestDeps["goalGate"];
	skillRegistry?: SkillCardRegistry;
	skillBodies?: ReadonlyMap<string, string> | Record<string, string>;
	memoryStore?: InMemoryUserMemoryStore;
	intake?: IntakeOptions;
	routing?: RoutingOptions;
	trace?: TraceSink;
	workerReviewerLoop?: RequestWorkerReviewerLoopOptions;
	memoryScope?: string;
	memorySubject?: string;
	now?: () => number;
}

export function createRequestLifecycleDeps(
	config: Pick<ResolvedHarnessConfig, "resources" | "systemPrompt" | "tools" | "toolRegistrations">,
	options: RequestLifecycleRuntimeOptions = {},
): AgentRequestDeps {
	const skillRegistry = options.skillRegistry ?? createSkillRegistryFromSkills(config.resources?.skills ?? []);
	const skillBodies = options.skillBodies ?? skillBodiesFromSkills(config.resources?.skills ?? []);
	const getPrefixParts = (): PrefixParts => ({
		systemPrompt: config.systemPrompt ?? "",
		declaredTools: declaredToolsFromConfig(config),
		skillCardIndex: skillRegistry.prefixIndex().map((entry) => ({
			name: entry.name,
			whenToUse: entry.whenToUse,
			responsibility: entry.responsibility,
		})),
	});
	const memory: RequestMemoryOptions = {
		store: options.memoryStore ?? new InMemoryUserMemoryStore(),
		scope: options.memoryScope ?? "global",
		subject: options.memorySubject ?? "user",
	};
	return {
		skillRegistry,
		intake: options.intake,
		routing: options.routing ?? createDefaultRouting(skillRegistry),
		memory,
		trace: options.trace,
		workerReviewerLoop: options.workerReviewerLoop,
		goalGate: options.goalGate,
		prefix: createFrozenPrefix(getPrefixParts()),
		getPrefixParts,
		loadSkillBody: (skill) => readSkillBody(skillBodies, skill.name),
		now: options.now,
	};
}

export function createSkillRegistryFromSkills(skills: readonly Skill[]): SkillCardRegistry {
	return createSkillCardRegistry(skills.map(skillToCard));
}

export function skillToCard(skill: Skill): SkillCard {
	const responsibility = skill.description || skill.name;
	const metadata = codingSkillCardMetadata[skill.name];
	return {
		name: skill.name,
		responsibility,
		whenToUse: metadata?.whenToUse ?? responsibility,
		inputs: metadata?.inputs ?? ["user request"],
		outputs: metadata?.outputs ?? ["assistant response"],
		tools: metadata?.tools ?? [],
		effects: metadata?.effects ?? [],
		constraints: metadata?.constraints ?? [],
		adjacentFalseTriggers: metadata?.adjacentFalseTriggers ?? [],
		positiveExamples: metadata?.positiveExamples ?? [],
		negativeExamples: metadata?.negativeExamples ?? [],
		handoffContract: metadata?.handoffContract ?? `Apply the ${skill.name} skill to the current request.`,
	};
}

const codingSkillCardMetadata: Record<string, Omit<SkillCard, "name" | "responsibility">> = {
	review: {
		whenToUse: "Use for blind or ordinary review of a concrete diff, evidence manifest, or completed code change.",
		inputs: ["diff", "evidence manifest", "acceptance criteria", "test output"],
		outputs: ["review verdict", "ordered findings", "residual risks"],
		tools: ["read", "grep", "glob"],
		effects: ["reads code and evidence", "reports findings", "does not modify files"],
		constraints: ["read-only", "no-worker-transcript"],
		adjacentFalseTriggers: ["implementing a requested code change", "repairing a known failing test"],
		positiveExamples: [
			"Review this diff against the acceptance criteria.",
			"Act as the blind reviewer for this worker attempt.",
		],
		negativeExamples: [
			"Fix the implementation yourself.",
			"Run a long autonomous coding task.",
		],
		handoffContract: "Return PASS, FAIL, NEEDS_HUMAN, BLOCKED, or SCOPE_GAP with evidence-backed findings.",
	},
	"fix-tests": {
		whenToUse: "Use when a focused test or verification command is failing and the task is to diagnose and repair it.",
		inputs: ["failing command", "test output", "relevant files"],
		outputs: ["minimal patch", "rerun result", "root-cause note"],
		tools: ["read", "grep", "glob", "edit", "bash"],
		effects: ["edits code or tests", "reruns focused verification"],
		constraints: ["preserve-user-changes", "focused-fix"],
		adjacentFalseTriggers: ["broad feature implementation", "review-only requests"],
		positiveExamples: [
			"Fix this failing test and rerun the focused command.",
			"Diagnose the regression shown in this test output.",
		],
		negativeExamples: [
			"Review this PR without changing files.",
			"Implement an unrelated roadmap item.",
		],
		handoffContract: "Return changed files, root cause, focused command rerun, and any remaining failure.",
	},
};

function createDefaultRouting(skillRegistry: SkillCardRegistry): RoutingOptions {
	return {
		routes: skillRegistry.list().map((card) => ({
			name: card.name,
			skill: card.name,
			triggers: [new RegExp(`\\b${escapeRegex(card.name)}\\b`, "i")],
			constraints: card.constraints,
		})),
	};
}

function skillBodiesFromSkills(skills: readonly Skill[]): ReadonlyMap<string, string> {
	return new Map(skills.map((skill) => [skill.name, skill.content]));
}

function readSkillBody(
	source: ReadonlyMap<string, string> | Record<string, string>,
	name: string,
): string | undefined {
	if (isReadonlyStringMap(source)) return source.get(name);
	return source[name];
}

function isReadonlyStringMap(
	source: ReadonlyMap<string, string> | Record<string, string>,
): source is ReadonlyMap<string, string> {
	return "get" in source && typeof source.get === "function";
}

function declaredToolsFromConfig(
	config: Pick<ResolvedHarnessConfig, "tools" | "toolRegistrations">,
): DeclaredToolPrefixEntry[] {
	return configuredTools(config).map((tool) => ({
		name: tool.name,
		...("description" in tool && typeof tool.description === "string" ? { description: tool.description } : {}),
	}));
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
