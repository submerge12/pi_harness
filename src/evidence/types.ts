export type EvidenceAllowedLevel = "allow" | "ask" | "deny";

export interface EvidenceAllowedDecision {
	level: EvidenceAllowedLevel;
	ruleId?: string;
}

export interface EvidenceExecOptions {
	cwd?: string;
	env?: Record<string, string>;
	timeout?: number;
	abortSignal?: AbortSignal;
}

export interface EvidenceExecSuccess {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface EvidenceExecError {
	message: string;
	code?: string;
}

export type EvidenceExecResult =
	| {
			ok: true;
			value: EvidenceExecSuccess;
	  }
	| {
			ok: false;
			error: EvidenceExecError;
	  };

export interface EvidenceExecEnv {
	exec(command: string, options?: EvidenceExecOptions): Promise<EvidenceExecResult>;
}

export interface EvidenceBytes {
	stdout: number;
	stderr: number;
	total: number;
}

export interface EvidenceNodeAttribution {
	nodeId?: string;
	nodeNonce?: string;
	assignmentDigest?: string;
}

export interface EvidenceManifestEntry extends EvidenceNodeAttribution {
	id: string;
	command: string;
	subject: string;
	allowed: EvidenceAllowedDecision;
	writeScope?: readonly string[];
	actualWritePaths?: readonly string[];
	exitCode: number;
	stdoutRef: string;
	stderrRef: string;
	bytes: EvidenceBytes;
	binary: boolean;
	truncated: boolean;
	sha256: string;
	stderrSha256: string;
	redactions: number;
	capturedAt: string;
}

export type EvidenceManifest = EvidenceManifestEntry[];

export interface CaptureCommandInput extends EvidenceNodeAttribution {
	id: string;
	command: string;
	subject: string;
	allowed: EvidenceAllowedDecision;
	writeScope?: readonly string[];
	actualWritePaths?: readonly string[];
	cwd?: string;
	env?: Record<string, string>;
	timeout?: number;
}

export interface CaptureOutputInput extends EvidenceNodeAttribution {
	id: string;
	command: string;
	subject: string;
	allowed: EvidenceAllowedDecision;
	writeScope?: readonly string[];
	actualWritePaths?: readonly string[];
	stdout: string;
	stderr?: string;
	exitCode?: number;
}

export interface EvidenceGatewayOptions {
	env: EvidenceExecEnv;
	rootDir: string;
	runId: string;
	now: () => Date;
	maxOutputBytes?: number;
	onEntry?: (entry: EvidenceManifestEntry) => void;
}

export interface EvidenceCapturedOutput {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface EvidenceGateway {
	captureCommand(input: CaptureCommandInput, signal?: AbortSignal): Promise<EvidenceManifestEntry>;
	captureOutput(input: CaptureOutputInput): Promise<EvidenceManifestEntry>;
}
