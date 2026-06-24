import { Type } from "typebox";
import type { Static } from "typebox";

export const skillCardSchema = Type.Object(
	{
		name: Type.String(),
		responsibility: Type.String(),
		whenToUse: Type.String(),
		effects: Type.Array(Type.String()),
		adjacentFalseTriggers: Type.Array(Type.String()),
		positiveExamples: Type.Array(Type.String()),
		negativeExamples: Type.Array(Type.String()),
		inputs: Type.Array(Type.String()),
		outputs: Type.Array(Type.String()),
		tools: Type.Array(Type.String()),
		constraints: Type.Array(Type.String()),
		handoffContract: Type.String(),
	},
	{ additionalProperties: false },
);

export type SkillCard = Static<typeof skillCardSchema>;
