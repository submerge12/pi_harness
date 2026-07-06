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

export const normalizedModelFailureErrorSchema = Type.Object(
	{
		type: Type.Literal("model_failure"),
		kind: Type.Union([
			Type.Literal("refusal"),
			Type.Literal("loop"),
			Type.Literal("truncation"),
		]),
		pattern: Type.String(),
		retryClassification: Type.Union([
			Type.Literal("fatal"),
			Type.Literal("transient"),
		]),
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
		error: Type.Optional(normalizedModelFailureErrorSchema),
		// Additive, optional: the ModelProfile id that executed, for per-(executor, model) attribution.
		model: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export type NormalizedTestResult = Static<typeof normalizedTestResultSchema>;
export type NormalizedUsage = Static<typeof normalizedUsageSchema>;
export type NormalizedModelFailureError = Static<typeof normalizedModelFailureErrorSchema>;
export type NormalizedResult = Static<typeof normalizedResultSchema>;
