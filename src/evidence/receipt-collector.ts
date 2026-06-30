import type { EvidenceGateway, EvidenceManifestEntry } from "./types.ts";
import { cloneEvidenceManifestEntry } from "./gateway.ts";

export interface EvidenceReceiptCollector {
	record(entry: EvidenceManifestEntry): void;
	markAttemptStart(attempt: number): void;
	receiptsForAttempt(attempt: number): readonly EvidenceManifestEntry[];
	entries(): readonly EvidenceManifestEntry[];
}

export function createEvidenceReceiptCollector(): EvidenceReceiptCollector {
	const entries: EvidenceManifestEntry[] = [];
	const attemptStartIndexes = new Map<number, number>();

	return {
		record(entry: EvidenceManifestEntry): void {
			entries.push(cloneEvidenceManifestEntry(entry));
		},
		markAttemptStart(attempt: number): void {
			attemptStartIndexes.set(attempt, entries.length);
		},
		receiptsForAttempt(attempt: number): readonly EvidenceManifestEntry[] {
			const start = attemptStartIndexes.get(attempt);
			if (start === undefined) return [];
			return entries.slice(start).map(cloneEvidenceManifestEntry);
		},
		entries(): readonly EvidenceManifestEntry[] {
			return entries.map(cloneEvidenceManifestEntry);
		},
	};
}

export function recordEvidenceGatewayEntries(
	gateway: EvidenceGateway | undefined,
	collector: EvidenceReceiptCollector | undefined,
): EvidenceGateway | undefined {
	if (!gateway || !collector) return gateway;
	return {
		async captureCommand(input, signal) {
			const entry = await gateway.captureCommand(input, signal);
			collector.record(entry);
			return entry;
		},
		async captureOutput(input) {
			const entry = await gateway.captureOutput(input);
			collector.record(entry);
			return entry;
		},
	};
}
