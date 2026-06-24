import { Type } from "typebox";
import type { Static } from "typebox";

export const normalizedTestResultSchema = Type.Object(
	{
		name: Type.String(),
		passed: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const normalizedUsageSchema = Type.Object(
	{
		inputTokens: Type.Number(),
		outputTokens: Type.Number(),
		costUsd: Type.Number(),
	},
	{ additionalProperties: false },
);

export const normalizedResultSchema = Type.Object(
	{
		status: Type.Union([
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("blocked"),
		]),
		diffRef: Type.Optional(Type.String()),
		testResults: Type.Array(normalizedTestResultSchema),
		evidenceRefs: Type.Array(Type.String()),
		usage: normalizedUsageSchema,
		message: Type.String(),
	},
	{ additionalProperties: false },
);

export type NormalizedTestResult = Static<typeof normalizedTestResultSchema>;
export type NormalizedUsage = Static<typeof normalizedUsageSchema>;
export type NormalizedResult = Static<typeof normalizedResultSchema>;
