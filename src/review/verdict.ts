import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

export const reviewVerdictValueSchema = Type.Union([
	Type.Literal("PASS"),
	Type.Literal("FAIL"),
	Type.Literal("NEEDS_HUMAN"),
	Type.Literal("BLOCKED"),
	Type.Literal("SCOPE_GAP"),
]);

export const reviewPhaseSchema = Type.Union([Type.Literal("blind"), Type.Literal("cross-check")]);

export const reviewFindingSeveritySchema = Type.Union([
	Type.Literal("info"),
	Type.Literal("warn"),
	Type.Literal("blocker"),
]);

export const reviewFindingSchema = Type.Object(
	{
		severity: reviewFindingSeveritySchema,
		claim: Type.String(),
		evidenceRef: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const reviewRerunSchema = Type.Object(
	{
		ran: Type.Boolean(),
		matched: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const reviewVerdictSchema = Type.Object(
	{
		verdict: reviewVerdictValueSchema,
		reviewer: Type.String(),
		phase: reviewPhaseSchema,
		findings: Type.Array(reviewFindingSchema),
		rerun: Type.Optional(reviewRerunSchema),
		decidedAt: Type.Number(),
	},
	{ additionalProperties: false },
);

export type ReviewVerdictValue = Static<typeof reviewVerdictValueSchema>;
export type Verdict = ReviewVerdictValue;
export type ReviewPhase = Static<typeof reviewPhaseSchema>;
export type ReviewFindingSeverity = Static<typeof reviewFindingSeveritySchema>;
export type ReviewFinding = Static<typeof reviewFindingSchema>;
export type ReviewRerun = Static<typeof reviewRerunSchema>;
export type ReviewVerdict = Static<typeof reviewVerdictSchema>;

export function isReviewVerdict(value: unknown): value is ReviewVerdict {
	return Value.Check(reviewVerdictSchema, value);
}
