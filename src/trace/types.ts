import { Type } from "typebox";
import type { Static } from "typebox";

export const traceEventTypeSchema = Type.Union([
	Type.Literal("stage"),
	Type.Literal("transition"),
	Type.Literal("worker-attempt"),
	Type.Literal("review-verdict"),
	Type.Literal("rewind"),
	Type.Literal("completion-gate"),
	Type.Literal("human-gate"),
	Type.Literal("human-decision"),
]);

export const traceEventSchema = Type.Object(
	{
		runId: Type.String(),
		seq: Type.Integer({ minimum: 0 }),
		type: traceEventTypeSchema,
		at: Type.Number(),
		data: Type.Optional(Type.Any()),
	},
	{ additionalProperties: false },
);

export type TraceEventType = Static<typeof traceEventTypeSchema>;
export type TraceEvent = Static<typeof traceEventSchema>;

export interface TraceEventInput {
	type: TraceEventType;
	data?: unknown;
}

export interface TraceSink {
	append(event: TraceEventInput): Promise<TraceEvent> | TraceEvent;
}

export interface InspectableTraceSink extends TraceSink {
	events(): readonly TraceEvent[];
}
