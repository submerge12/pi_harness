import { Value } from "typebox/value";
import { skillCardSchema } from "./schemas/skill-card.ts";
import type { SkillCard } from "./schemas/skill-card.ts";
import type { SkillCardPrefixEntry, SkillCardRegistry } from "./types.ts";

export function createSkillCardRegistry(initialCards: readonly SkillCard[] = []): SkillCardRegistry {
	const cardsByName = new Map<string, SkillCard>();
	const cardsInPublishOrder: SkillCard[] = [];

	function publish(card: SkillCard): SkillCard {
		assertSkillCard(card);
		if (cardsByName.has(card.name)) {
			throw new Error(`Duplicate skill card: ${card.name}`);
		}

		const storedCard = cloneSkillCard(card);
		cardsByName.set(storedCard.name, storedCard);
		cardsInPublishOrder.push(storedCard);
		return cloneSkillCard(storedCard);
	}

	function lookup(name: string): SkillCard | undefined {
		const card = cardsByName.get(name);
		return card === undefined ? undefined : cloneSkillCard(card);
	}

	function prefixIndex(): SkillCardPrefixEntry[] {
		return cardsInPublishOrder.map((card) => ({
			name: card.name,
			responsibility: toOneLineText(card.responsibility),
			whenToUse: toOneLineText(card.whenToUse),
		}));
	}

	function match(hardConstraints: readonly string[]): SkillCard[] {
		return cardsInPublishOrder
			.filter((card) => satisfiesHardConstraints(card, hardConstraints))
			.map(cloneSkillCard);
	}

	function list(): SkillCard[] {
		return cardsInPublishOrder.map(cloneSkillCard);
	}

	const registry: SkillCardRegistry = {
		publish,
		lookup,
		prefixIndex,
		match,
		list,
	};

	for (const card of initialCards) {
		registry.publish(card);
	}

	return registry;
}

export function publishSkillCard(registry: SkillCardRegistry, card: SkillCard): SkillCard {
	return registry.publish(card);
}

export function lookupSkillCard(registry: SkillCardRegistry, name: string): SkillCard | undefined {
	return registry.lookup(name);
}

export function getSkillCardPrefixIndex(registry: SkillCardRegistry): SkillCardPrefixEntry[] {
	return registry.prefixIndex();
}

export function matchSkillCards(
	registry: SkillCardRegistry,
	hardConstraints: readonly string[],
): SkillCard[] {
	return registry.match(hardConstraints);
}

function assertSkillCard(card: SkillCard): void {
	if (Value.Check(skillCardSchema, card)) return;

	const errors = [...Value.Errors(skillCardSchema, card)]
		.map((error) => `${error.instancePath || "/"} ${error.message}`)
		.join("; ");
	throw new Error(`Invalid skill card: ${errors}`);
}

function cloneSkillCard(card: SkillCard): SkillCard {
	return {
		name: card.name,
		responsibility: card.responsibility,
		whenToUse: card.whenToUse,
		effects: [...card.effects],
		adjacentFalseTriggers: [...card.adjacentFalseTriggers],
		positiveExamples: [...card.positiveExamples],
		negativeExamples: [...card.negativeExamples],
		inputs: [...card.inputs],
		outputs: [...card.outputs],
		tools: [...card.tools],
		constraints: [...card.constraints],
		handoffContract: card.handoffContract,
	};
}

function toOneLineText(text: string): string {
	const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
	return firstLine.trim().replace(/\s+/g, " ");
}

function satisfiesHardConstraints(card: SkillCard, hardConstraints: readonly string[]): boolean {
	const cardConstraints = new Set(card.constraints);
	return hardConstraints.every((constraint) => cardConstraints.has(constraint));
}
