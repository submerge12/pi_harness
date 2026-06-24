import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { redact } from "../observability/redact.ts";
import type { InspectableTraceSink, TraceEvent, TraceEventInput, TraceSink } from "./types.ts";

export interface TraceSinkOptions {
	runId: string;
	now?: () => number;
}

export interface FileTraceSinkOptions extends TraceSinkOptions {
	filePath: string;
}

export function createInMemoryTraceSink(options: TraceSinkOptions): InspectableTraceSink {
	const events: TraceEvent[] = [];
	const now = options.now ?? (() => Date.now());

	return {
		append(event: TraceEventInput): TraceEvent {
			const stored = createStoredEvent(options.runId, events.length, now, event);
			events.push(stored);
			return cloneTraceEvent(stored);
		},
		events(): readonly TraceEvent[] {
			return events.map(cloneTraceEvent);
		},
	};
}

export function createFileTraceSink(options: FileTraceSinkOptions): TraceSink {
	let seq = 0;
	const now = options.now ?? (() => Date.now());

	return {
		async append(event: TraceEventInput): Promise<TraceEvent> {
			const stored = createStoredEvent(options.runId, seq, now, event);
			seq += 1;
			await mkdir(dirname(options.filePath), { recursive: true });
			await appendFile(options.filePath, `${JSON.stringify(stored)}\n`, "utf8");
			return cloneTraceEvent(stored);
		},
	};
}

function createStoredEvent(
	runId: string,
	seq: number,
	now: () => number,
	event: TraceEventInput,
): TraceEvent {
	return {
		runId,
		seq,
		type: event.type,
		at: now(),
		...(event.data === undefined ? {} : { data: redact(event.data) }),
	};
}

function cloneTraceEvent(event: TraceEvent): TraceEvent {
	return JSON.parse(JSON.stringify(event)) as TraceEvent;
}
