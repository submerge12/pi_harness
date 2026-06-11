import { appendFile, mkdir } from "node:fs/promises";
import { dirname, posix, win32 } from "node:path";
import { redact } from "./redact.ts";
import type { HarnessEvent, HarnessEventSource } from "./types.ts";

export interface EventLogOptions {
	filePath: string;
	now?: () => Date;
}

export interface EventLogEntry {
	timestamp: string;
	event: unknown;
}

function assertSafeSessionId(sessionId: string): void {
	if (
		sessionId.length === 0 ||
		sessionId.includes("/") ||
		sessionId.includes("\\") ||
		sessionId === ".." ||
		posix.isAbsolute(sessionId) ||
		win32.isAbsolute(sessionId) ||
		/^[A-Za-z]:/.test(sessionId)
	) {
		throw new Error(`Invalid session id: ${sessionId}`);
	}
}

export function createSessionEventLogPath(sessionsRoot: string, sessionId: string): string {
	assertSafeSessionId(sessionId);
	const pathApi = sessionsRoot.includes("\\") || /^[A-Za-z]:/.test(sessionsRoot) ? win32 : posix;
	return pathApi.join(sessionsRoot, `${sessionId}.events.jsonl`);
}

export class EventLog {
	private readonly filePath: string;
	private readonly now: () => Date;

	constructor(options: EventLogOptions) {
		this.filePath = options.filePath;
		this.now = options.now ?? (() => new Date());
	}

	async handleEvent(event: HarnessEvent, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return;
		const entry: EventLogEntry = {
			timestamp: this.now().toISOString(),
			event: redact(event),
		};
		await mkdir(dirname(this.filePath), { recursive: true });
		await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
	}

	subscribeTo(harness: HarnessEventSource): () => void {
		return harness.subscribe((event, signal) => this.handleEvent(event, signal));
	}
}
