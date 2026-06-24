import { Type } from "typebox";
import type { Static } from "typebox";
import { userMemoryTrustSchema } from "../../memory/schemas/user-memory.ts";

export const memoryCandidateSchema = Type.Object(
	{
		subject: Type.String(),
		predicate: Type.String(),
		object: Type.String(),
		trust: userMemoryTrustSchema,
		source: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const planAmendmentSchema = Type.Object(
	{
		id: Type.String(),
		reason: Type.String(),
		changes: Type.Array(Type.String()),
		createdAt: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

export const domainHandoffPackageSchema = Type.Object(
	{
		sourceDomain: Type.String(),
		targetDomain: Type.String(),
		artifactRefs: Type.Array(Type.String()),
		decisions: Type.Optional(Type.Array(Type.String())),
		unresolvedQuestions: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);

export type MemoryCandidate = Static<typeof memoryCandidateSchema>;
export type PlanAmendment = Static<typeof planAmendmentSchema>;
export type DomainHandoffPackage = Static<typeof domainHandoffPackageSchema>;
