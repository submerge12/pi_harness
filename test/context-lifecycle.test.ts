import { describe, expect, it } from "vitest";
import {
	CONTEXT_TIERS,
	FULL_COMPACTION_SECTION_TITLES,
	assertPrefixInvariant,
	classifyContextTier,
	createFrozenPrefix,
	createFullCompactionSummary,
	createTombstoneAnchor,
	isPrefixInvariant,
	selectProtectedRecentTurns,
} from "../src/context/lifecycle.ts";
import { loadJitDynamicSuffix } from "../src/context/jit-loader.ts";

describe("context lifecycle policy", () => {
	it("creates a tombstone that declares the removed summary before a retrievable anchor", () => {
		const tombstone = createTombstoneAnchor({
			removedSummary: "Superseded package-lock inspection output was removed.",
			anchorId: "cold://context/tool-output/package-lock-1",
			retrievableFrom: "context-store/tool-output/package-lock-1.json",
			reason: "superseded_tool_result",
		});

		expect(CONTEXT_TIERS).toEqual(["pinned", "warm", "cold"]);
		expect(tombstone.tier).toBe("warm");
		expect(tombstone.anchor).toEqual({
			id: "cold://context/tool-output/package-lock-1",
			retrievable: true,
			retrievableFrom: "context-store/tool-output/package-lock-1.json",
		});
		expect(tombstone.text.indexOf("removed summary:")).toBeLessThan(tombstone.text.indexOf("retrievable anchor:"));
		expect(tombstone.text).toContain("Superseded package-lock inspection output was removed.");
	});

	it("builds the fixed 9-section full-compaction summary shape", () => {
		const summary = createFullCompactionSummary({
			sections: {
				"Main request & user intent": "Implement L4 context lifecycle policy.",
				"Key technical concepts": "Pinned, Warm, Cold, tombstone, JIT suffix.",
				"Files & code": "src/context/lifecycle.ts and src/context/jit-loader.ts.",
				"Pitfalls encountered & fixes": "Keep prefix frozen.",
				"Problem-solving process": "Write tests, then helpers.",
				"All user information, itemized": "- User limited write scope to context files and one test.",
				"Pending tasks": "Run Vitest.",
				"What is currently being worked on": "Context lifecycle helpers.",
			},
			originalNextStepWording: "execute Suggested build order #4",
		});

		expect(summary.sections.map((section) => section.title)).toEqual(FULL_COMPACTION_SECTION_TITLES);
		expect(summary.sections).toHaveLength(9);
		expect(summary.sections[8]).toEqual({
			title: "The user's original wording for the next step",
			content: "execute Suggested build order #4",
		});
	});

	it("protects recent turns verbatim during compaction", () => {
		const turns = [
			{ id: "turn-1", role: "user", content: "old" },
			{ id: "turn-2", role: "assistant", content: "older" },
			{ id: "turn-3", role: "user", content: "recent" },
			{ id: "turn-4", role: "assistant", content: "most recent" },
		] as const;

		expect(classifyContextTier({ isRecent: true })).toBe("pinned");
		expect(selectProtectedRecentTurns(turns, { protectedTurnCount: 2 })).toEqual(turns.slice(-2));

		const summary = createFullCompactionSummary({
			sections: {},
			originalNextStepWording: "continue",
			recentTurns: turns,
			protectedTurnCount: 2,
		});

		expect(summary.protectedRecentTurns).toEqual(turns.slice(-2));
	});

	it("enforces the frozen prefix invariant for system prompt, declared tools, and skill-card index", () => {
		const prefix = createFrozenPrefix({
			systemPrompt: "system prompt",
			declaredTools: [
				{ name: "load_skill", description: "Load a skill body on demand" },
				{ name: "get_doc", description: "Load detailed docs on demand" },
			],
			skillCardIndex: [{ name: "context-lifecycle", whenToUse: "Stage 5 context lifecycle work" }],
		});

		expect(isPrefixInvariant(prefix, prefix)).toBe(true);
		expect(() =>
			assertPrefixInvariant(prefix, {
				...prefix,
				systemPrompt: "mutated prompt",
			}),
		).toThrow("Frozen prefix changed");
		expect(() => {
			(prefix.declaredTools as Array<{ name: string }>).push({ name: "new_tool" });
		}).toThrow();
	});
});

describe("context JIT loader", () => {
	it("loads skill and tool bodies only as a dynamic suffix without changing the declared prefix", async () => {
		const prefix = createFrozenPrefix({
			systemPrompt: "system prompt",
			declaredTools: [
				{ name: "load_skill", description: "Load a skill body on demand" },
				{ name: "get_doc", description: "Load detailed docs on demand" },
			],
			skillCardIndex: [
				{ name: "tdd", whenToUse: "Before implementation" },
				{ name: "bash", whenToUse: "Run shell commands" },
			],
		});
		const compactIndex = [
			{ kind: "skill", name: "tdd", anchor: "skill://tdd" },
			{ kind: "tool", name: "bash", anchor: "tool://bash" },
		] as const;

		const suffix = await loadJitDynamicSuffix({
			prefix,
			compactIndex,
			requests: [
				{ kind: "skill", name: "tdd" },
				{ kind: "tool", name: "bash" },
			],
			loadBody: async (entry) => `${entry.kind}:${entry.name}:full body`,
		});

		expect(suffix).toEqual({
			kind: "dynamic_jit_suffix",
			prefixFingerprint: prefix.fingerprint,
			items: [
				{ kind: "skill", name: "tdd", anchor: "skill://tdd", body: "skill:tdd:full body" },
				{ kind: "tool", name: "bash", anchor: "tool://bash", body: "tool:bash:full body" },
			],
		});
		expect(Object.keys(suffix)).not.toContain("declaredTools");
		expect(prefix.declaredTools.map((tool) => tool.name)).toEqual(["load_skill", "get_doc"]);

		await expect(
			loadJitDynamicSuffix({
				prefix,
				compactIndex,
				requests: [{ kind: "skill", name: "tdd" }],
				loadBody: async () => ({ body: "bad", declaredTools: [{ name: "new_tool" }] }),
			}),
		).rejects.toThrow("dynamic suffix");
	});
});
