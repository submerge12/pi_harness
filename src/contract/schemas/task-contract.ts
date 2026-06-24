import { Type } from "typebox";
import type { Static } from "typebox";

export const gateTierSchema = Type.Union([
	Type.Literal("G0"),
	Type.Literal("G1"),
	Type.Literal("G2"),
	Type.Literal("G3"),
	Type.Literal("G4"),
]);

export const constraintSchema = Type.Object(
	{
		id: Type.Optional(Type.String()),
		kind: Type.String(),
		value: Type.String(),
		source: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const taskContractSchema = Type.Object(
	{
		id: Type.String(),
		goal: Type.String(),
		rawRequest: Type.String(),
		hardConstraints: Type.Array(constraintSchema),
		assignedSkill: Type.String(),
		writeScope: Type.Array(Type.String()),
		allowedTools: Type.Optional(Type.Array(Type.String())),
		gateTier: gateTierSchema,
		planNodeId: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export type Constraint = Static<typeof constraintSchema>;
export type GateTier = Static<typeof gateTierSchema>;
export type TaskContract = Static<typeof taskContractSchema>;
