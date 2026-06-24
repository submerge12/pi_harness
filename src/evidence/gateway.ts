import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { appendManifestEntry } from "./manifest.ts";
import { containsBinaryOutput, redactCommandOutput } from "./redactor.ts";
import type {
	CaptureCommandInput,
	CaptureOutputInput,
	EvidenceCapturedOutput,
	EvidenceGateway,
	EvidenceGatewayOptions,
	EvidenceExecSuccess,
	EvidenceManifestEntry,
} from "./types.ts";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const capturedOutputSymbol = Symbol("pi-harness.evidence.capturedOutput");

type EntryWithCapturedOutput = EvidenceManifestEntry & { [capturedOutputSymbol]?: EvidenceCapturedOutput };

export function createEvidenceGateway(options: EvidenceGatewayOptions): EvidenceGateway {
	return {
		async captureCommand(input: CaptureCommandInput, signal?: AbortSignal): Promise<EvidenceManifestEntry> {
			assertSafePathSegment(options.runId, "runId");
			assertSafePathSegment(input.id, "id");
			validateMaxOutputBytes(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);

			const result = await options.env.exec(input.command, {
				cwd: input.cwd,
				env: input.env,
				timeout: input.timeout,
				abortSignal: signal,
			});
			if (!result.ok) {
				throw new Error(`Failed to capture evidence for ${input.id}: ${result.error.message}`);
			}

			return await persistEvidence(options, input, result.value);
		},

		async captureOutput(input: CaptureOutputInput): Promise<EvidenceManifestEntry> {
			assertSafePathSegment(options.runId, "runId");
			assertSafePathSegment(input.id, "id");
			validateMaxOutputBytes(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);

			return await persistEvidence(options, input, {
				stdout: input.stdout,
				stderr: input.stderr ?? "",
				exitCode: input.exitCode ?? 0,
			});
		},
	};
}

export function getEvidenceCapturedOutput(entry: EvidenceManifestEntry): EvidenceCapturedOutput | undefined {
	return (entry as EntryWithCapturedOutput)[capturedOutputSymbol];
}

async function persistEvidence(
	options: EvidenceGatewayOptions,
	input: CaptureCommandInput | CaptureOutputInput,
	result: EvidenceExecSuccess,
): Promise<EvidenceManifestEntry> {
	const maxOutputBytes = validateMaxOutputBytes(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
	const redactedCommand = redactCommandOutput(input.command);
	const redactedSubject = redactCommandOutput(input.subject);
	const nodeId = redactOptionalString(input.nodeId);
	const nodeNonce = redactOptionalString(input.nodeNonce);
	const assignmentDigest = redactOptionalString(input.assignmentDigest);
	const writeScope = redactStringList(input.writeScope);
	const actualWritePaths = redactStringList(input.actualWritePaths);
	const stdout = prepareOutput(result.stdout, maxOutputBytes);
	const stderr = prepareOutput(result.stderr, maxOutputBytes);
	const stdoutRef = posix.join(".evidence-local", options.runId, `${input.id}.stdout`);
	const stderrRef = posix.join(".evidence-local", options.runId, `${input.id}.stderr`);
	const stdoutPath = join(options.rootDir, stdoutRef);
	const stderrPath = join(options.rootDir, stderrRef);

	await mkdir(dirname(stdoutPath), { recursive: true });
	await writeFile(stdoutPath, stdout.bytes);
	await writeFile(stderrPath, stderr.bytes);

	const entry: EvidenceManifestEntry = {
		id: input.id,
		command: redactedCommand.text,
		subject: redactedSubject.text,
		...(nodeId.value ? { nodeId: nodeId.value } : {}),
		...(nodeNonce.value ? { nodeNonce: nodeNonce.value } : {}),
		...(assignmentDigest.value ? { assignmentDigest: assignmentDigest.value } : {}),
		allowed: input.allowed,
		...(writeScope.values ? { writeScope: writeScope.values } : {}),
		...(actualWritePaths.values ? { actualWritePaths: actualWritePaths.values } : {}),
		exitCode: result.exitCode,
		stdoutRef,
		stderrRef,
		bytes: {
			stdout: stdout.bytes.byteLength,
			stderr: stderr.bytes.byteLength,
			total: stdout.bytes.byteLength + stderr.bytes.byteLength,
		},
		binary: stdout.binary || stderr.binary,
		truncated: stdout.truncated || stderr.truncated,
		sha256: createHash("sha256").update(stdout.bytes).digest("hex"),
		stderrSha256: createHash("sha256").update(stderr.bytes).digest("hex"),
		redactions:
			redactedCommand.redactions +
			redactedSubject.redactions +
			nodeId.redactions +
			nodeNonce.redactions +
			assignmentDigest.redactions +
			writeScope.redactions +
			actualWritePaths.redactions +
			stdout.redactions +
			stderr.redactions,
		capturedAt: options.now().toISOString(),
	};
	Object.defineProperty(entry, capturedOutputSymbol, {
		value: {
			stdout: stdout.text,
			stderr: stderr.text,
			exitCode: result.exitCode,
		} satisfies EvidenceCapturedOutput,
		enumerable: false,
	});

	await appendManifestEntry(join(options.rootDir, "evidence", options.runId, "manifest.json"), entry);
	options.onEntry?.(entry);
	return entry;
}

function redactOptionalString(value: string | undefined): { value?: string; redactions: number } {
	if (value === undefined) return { redactions: 0 };
	const redacted = redactCommandOutput(value);
	return { value: redacted.text, redactions: redacted.redactions };
}

function redactStringList(values: readonly string[] | undefined): { values?: string[]; redactions: number } {
	if (!values) return { redactions: 0 };
	let redactions = 0;
	const redactedValues = values.map((value) => {
		const redacted = redactCommandOutput(value);
		redactions += redacted.redactions;
		return redacted.text;
	});
	return { values: redactedValues, redactions };
}

function prepareOutput(text: string, maxOutputBytes: number) {
	const redacted = redactCommandOutput(text);
	const bytes = Buffer.from(redacted.text, "utf8");
	const truncated = bytes.byteLength > maxOutputBytes;
	const outputBytes = truncated ? bytes.subarray(0, maxOutputBytes) : bytes;
	return {
		bytes: outputBytes,
		text: outputBytes.toString("utf8"),
		binary: containsBinaryOutput(text),
		truncated,
		redactions: redacted.redactions,
	};
}

function assertSafePathSegment(value: string, label: string): void {
	if (value === "." || value === ".." || !SAFE_PATH_SEGMENT_PATTERN.test(value)) {
		throw new Error(`Invalid evidence ${label}: ${value}`);
	}
}

function validateMaxOutputBytes(value: number): number {
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid evidence maxOutputBytes: ${value}`);
	}
	return value;
}
