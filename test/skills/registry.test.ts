import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	createSkillCardRegistry,
	getSkillCardPrefixIndex,
	lookupSkillCard,
	matchSkillCards,
	publishSkillCard,
	skillCardSchema,
	type SkillCard,
} from "../../src/skills/index.ts";
import { skillToCard } from "../../src/lifecycle/index.ts";
import { reviewSkill } from "../../src/agents/profiles/coding/skills/review.ts";

function createCard(overrides: Partial<SkillCard> = {}): SkillCard {
	return {
		name: "coding.review",
		responsibility: "Review code changes and return actionable findings.\nKeep the summary brief.",
		whenToUse: "Use when the user asks for review feedback on an existing diff.\nAvoid implementation work.",
		effects: ["reads diff", "reports findings"],
		adjacentFalseTriggers: ["new feature implementation", "test repair"],
		positiveExamples: ["Review this PR for regressions."],
		negativeExamples: ["Fix the failing tests."],
		inputs: ["diff", "test output"],
		outputs: ["review findings"],
		tools: ["git.diff", "shell"],
		constraints: ["write-scope:src/**", "no-commit"],
		handoffContract: "Findings include severity, file path, line, and rationale.",
		...overrides,
	};
}

describe("skillCardSchema", () => {
	it("requires the L2 selection-contract fields and rejects extras", () => {
		const validCard = createCard();
		const { adjacentFalseTriggers, ...missingSelectionContract } = validCard;

		expect(Value.Check(skillCardSchema, validCard)).toBe(true);
		expect(Value.Check(skillCardSchema, missingSelectionContract)).toBe(false);
		expect(Value.Check(skillCardSchema, { ...validCard, extra: "nope" })).toBe(false);
	});
});

describe("skill-card registry", () => {
	it("publishes cards and rejects duplicate names", () => {
		const registry = createSkillCardRegistry();

		publishSkillCard(registry, createCard());

		expect(() => publishSkillCard(registry, createCard())).toThrow(
			"Duplicate skill card: coding.review",
		);
	});

	it("looks up a card by name", () => {
		const registry = createSkillCardRegistry();
		const card = createCard();

		publishSkillCard(registry, card);

		expect(lookupSkillCard(registry, "coding.review")).toEqual(card);
		expect(lookupSkillCard(registry, "missing.skill")).toBeUndefined();
	});

	it("returns a prefix index with name and one-line whenToUse", () => {
		const registry = createSkillCardRegistry();

		publishSkillCard(registry, createCard());
		publishSkillCard(
			registry,
			createCard({
				name: "coding.fix-tests",
				responsibility: "Fix failing tests without expanding scope.\nPreserve user changes.",
				whenToUse: "Use when tests are failing and the user wants a repair.\nDo not broaden scope.",
				constraints: ["write-scope:test/**", "no-commit"],
			}),
		);

		expect(getSkillCardPrefixIndex(registry)).toEqual([
			{
				name: "coding.review",
				responsibility: "Review code changes and return actionable findings.",
				whenToUse: "Use when the user asks for review feedback on an existing diff.",
			},
			{
				name: "coding.fix-tests",
				responsibility: "Fix failing tests without expanding scope.",
				whenToUse: "Use when tests are failing and the user wants a repair.",
			},
		]);
	});

	it("filters candidates by hard constraints", () => {
		const registry = createSkillCardRegistry([
			createCard({
				name: "coding.implementation",
				constraints: ["write-scope:src/**", "write-scope:test/**", "no-commit"],
			}),
			createCard({
				name: "docs.writer",
				constraints: ["write-scope:docs/**", "may-commit"],
			}),
		]);

		expect(matchSkillCards(registry, ["write-scope:src/**", "no-commit"]).map((card) => card.name)).toEqual([
			"coding.implementation",
		]);
		expect(matchSkillCards(registry, []).map((card) => card.name)).toEqual([
			"coding.implementation",
			"docs.writer",
		]);
		expect(matchSkillCards(registry, ["network-required"])).toEqual([]);
	});
});

describe("skillToCard", () => {
	it("populates concrete metadata for coding review skill cards", () => {
		const card = skillToCard(reviewSkill);

		expect(card.whenToUse).toContain("blind");
		expect(card.effects).toContain("does not modify files");
		expect(card.adjacentFalseTriggers).toContain("implementing a requested code change");
		expect(card.positiveExamples.length).toBeGreaterThan(0);
		expect(card.negativeExamples.length).toBeGreaterThan(0);
	});
});
