import type { SkillCard } from "./schemas/skill-card.ts";

export interface SkillCardPrefixEntry {
	name: string;
	responsibility: string;
	whenToUse: string;
}

export interface SkillCardRegistry {
	publish(card: SkillCard): SkillCard;
	lookup(name: string): SkillCard | undefined;
	prefixIndex(): SkillCardPrefixEntry[];
	match(hardConstraints: readonly string[]): SkillCard[];
	list(): SkillCard[];
}
