import type { TaskContract } from "../contract/index.ts";
import type { EvidenceManifestEntry } from "../evidence/index.ts";
import { isPathWithinWriteScope, normalizeWriteScope } from "../execution/index.ts";

export interface ReceiptLedgerAttempt {
	attempt: number;
	receipts: readonly EvidenceManifestEntry[];
}

export interface CompletionGateFailure {
	attempt: number;
	reason: string;
}

export interface CompletionGateResult {
	ok: boolean;
	failure?: CompletionGateFailure;
	acceptedReceipts: readonly EvidenceManifestEntry[];
}

export interface ReceiptLedger {
	recordAttempt(attempt: number, receipts: readonly EvidenceManifestEntry[]): void;
	attempts(): readonly ReceiptLedgerAttempt[];
	successfulReceiptsForAttempt(attempt: number): readonly EvidenceManifestEntry[];
	checkCompletion(input: {
		taskContract: TaskContract;
		attempt: number;
		doneClaim: boolean;
	}): CompletionGateResult;
}

export function createReceiptLedger(): ReceiptLedger {
	const byAttempt = new Map<number, EvidenceManifestEntry[]>();

	return {
		recordAttempt(attempt: number, receipts: readonly EvidenceManifestEntry[]): void {
			byAttempt.set(attempt, receipts.map(cloneReceipt));
		},
		attempts(): readonly ReceiptLedgerAttempt[] {
			return [...byAttempt.entries()]
				.sort(([left], [right]) => left - right)
				.map(([attempt, receipts]) => ({ attempt, receipts: receipts.map(cloneReceipt) }));
		},
		successfulReceiptsForAttempt(attempt: number): readonly EvidenceManifestEntry[] {
			return (byAttempt.get(attempt) ?? []).filter(isSuccessfulReceipt).map(cloneReceipt);
		},
		checkCompletion(input): CompletionGateResult {
			if (!input.doneClaim) {
				return failure(input.attempt, "worker did not claim completion");
			}

			if (input.taskContract.writeScope.length === 0) {
				return { ok: true, acceptedReceipts: [] };
			}

			const acceptedReceipts = (byAttempt.get(input.attempt) ?? []).filter((receipt) =>
				isSuccessfulReceipt(receipt) && receiptCoversWriteScope(receipt, input.taskContract.writeScope),
			);
			if (acceptedReceipts.length === 0) {
				return failure(input.attempt, "done claim has no successful receipt covering the write scope");
			}

			return { ok: true, acceptedReceipts: acceptedReceipts.map(cloneReceipt) };
		},
	};
}

function failure(attempt: number, reason: string): CompletionGateResult {
	return {
		ok: false,
		failure: { attempt, reason },
		acceptedReceipts: [],
	};
}

function isSuccessfulReceipt(receipt: EvidenceManifestEntry): boolean {
	return receipt.allowed.level === "allow" && receipt.exitCode === 0;
}

function receiptCoversWriteScope(receipt: EvidenceManifestEntry, writeScope: readonly string[]): boolean {
	const normalizedScope = normalizeWriteScope(writeScope, { allowEmpty: true });
	const paths = receipt.actualWritePaths?.length ? receipt.actualWritePaths : [receipt.subject];
	return paths.some((path) => isPathWithinWriteScope(path, normalizedScope));
}

function cloneReceipt(receipt: EvidenceManifestEntry): EvidenceManifestEntry {
	return {
		...receipt,
		allowed: { ...receipt.allowed },
		bytes: { ...receipt.bytes },
		...(receipt.writeScope ? { writeScope: [...receipt.writeScope] } : {}),
		...(receipt.actualWritePaths ? { actualWritePaths: [...receipt.actualWritePaths] } : {}),
	};
}
