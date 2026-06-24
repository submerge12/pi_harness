import type { EvidenceGateway, EvidenceManifestEntry } from "./types.ts";

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
			entries.push(cloneEntry(entry));
		},
		markAttemptStart(attempt: number): void {
			attemptStartIndexes.set(attempt, entries.length);
		},
		receiptsForAttempt(attempt: number): readonly EvidenceManifestEntry[] {
			const start = attemptStartIndexes.get(attempt);
			if (start === undefined) return [];
			return entries.slice(start).map(cloneEntry);
		},
		entries(): readonly EvidenceManifestEntry[] {
			return entries.map(cloneEntry);
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

function cloneEntry(entry: EvidenceManifestEntry): EvidenceManifestEntry {
	return {
		...entry,
		allowed: { ...entry.allowed },
		bytes: { ...entry.bytes },
		...(entry.writeScope ? { writeScope: [...entry.writeScope] } : {}),
		...(entry.actualWritePaths ? { actualWritePaths: [...entry.actualWritePaths] } : {}),
	};
}
