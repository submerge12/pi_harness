import { Type } from "typebox";
import type { Static } from "typebox";

export const userMemoryTrustSchema = Type.Union([
	Type.Literal("user_confirmed"),
	Type.Literal("tool_evidenced"),
	Type.Literal("model_inferred"),
]);

export const userMemoryRecordSchema = Type.Object(
	{
		id: Type.String(),
		scope: Type.String(),
		category: Type.Optional(Type.String()),
		subject: Type.String(),
		predicate: Type.String(),
		object: Type.String(),
		validFrom: Type.Number(),
		validTo: Type.Optional(Type.Number()),
		observedAt: Type.Number(),
		lastConfirmedAt: Type.Number(),
		source: Type.String(),
		trust: userMemoryTrustSchema,
		sensitivity: Type.String(),
		expiresAt: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

export type UserMemoryTrust = Static<typeof userMemoryTrustSchema>;
export type UserMemoryRecord = Static<typeof userMemoryRecordSchema>;
