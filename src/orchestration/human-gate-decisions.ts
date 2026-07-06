import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import type { HumanDecision } from "./persistence.ts";

export const humanDecisionActionSchema = Type.Union([Type.Literal("resume"), Type.Literal("abort")]);

export const humanDecisionSchema = Type.Object(
	{
		id: Type.String(),
		action: humanDecisionActionSchema,
		reviewer: Type.String(),
		decidedAt: Type.Number(),
		requestId: Type.String(),
		reason: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const humanDecisionsFileSchema = Type.Array(humanDecisionSchema);

export type PersistedHumanDecision = Static<typeof humanDecisionSchema>;

export interface HumanDecisionParseWarning {
	code: "invalid-human-decisions-file" | "invalid-human-decision";
	filePath: string;
	index?: number;
	path?: string;
	message: string;
}

export type HumanDecisionWarningSink = (warning: HumanDecisionParseWarning) => void;

export interface ParseHumanDecisionsOptions {
	filePath: string;
	warn?: HumanDecisionWarningSink;
}

export function findHumanDecisionForRequest(
	decisions: readonly HumanDecision[],
	requestId: string,
): HumanDecision | undefined {
	return decisions.find((decision) =>
		decision.requestId === requestId &&
		(decision.action === "resume" || decision.action === "abort")
	);
}

export function parseHumanDecisionsFile(
	value: unknown,
	options: ParseHumanDecisionsOptions,
): PersistedHumanDecision[] {
	if (!Array.isArray(value)) {
		warnInvalid(options, "invalid-human-decisions-file", value);
		return [];
	}

	const decisions: PersistedHumanDecision[] = [];
	value.forEach((entry, index) => {
		if (Value.Check(humanDecisionSchema, entry)) {
			decisions.push({ ...entry });
			return;
		}
		warnInvalid(options, "invalid-human-decision", entry, index);
	});
	return decisions;
}

function warnInvalid(
	options: ParseHumanDecisionsOptions,
	code: HumanDecisionParseWarning["code"],
	value: unknown,
	index?: number,
): void {
	const errors = [...Value.Errors(index === undefined ? humanDecisionsFileSchema : humanDecisionSchema, value)];
	const first = errors[0];
	const path = typeof first === "object" && first !== null && "path" in first && typeof first.path === "string"
		? first.path
		: undefined;
	options.warn?.({
		code,
		filePath: options.filePath,
		...(index === undefined ? {} : { index }),
		...(path ? { path } : {}),
		message: first?.message ?? "Invalid human decision record",
	});
}
