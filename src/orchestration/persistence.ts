import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GateTier } from "../contract/index.ts";
import { redactUnknown } from "../redaction/core.ts";
import type { ReviewVerdict } from "../review/index.ts";
import {
	findHumanDecisionForRequest,
	parseHumanDecisionsFile,
	type HumanDecisionParseWarning,
	type HumanDecisionWarningSink,
} from "./human-gate-decisions.ts";

export interface HumanGateRequest {
	id: string;
	attempt: number;
	gateTier: GateTier;
	verdict: ReviewVerdict;
	diff: string;
	evidence: readonly string[];
}

export interface HumanDecision {
	id: string;
	action: "resume" | "abort";
	reviewer: string;
	decidedAt: number;
	reason?: string;
	requestId?: string;
}

export interface LoopPersistence {
	savePendingHumanGate(request: HumanGateRequest): Promise<void>;
	loadPendingHumanGate(): Promise<HumanGateRequest | undefined>;
	saveHumanDecision(decision: HumanDecision): Promise<void>;
	loadHumanDecisions(): Promise<readonly HumanDecision[]>;
}

export interface FileLoopPersistenceOptions {
	rootDir: string;
	runId: string;
	onWarning?: HumanDecisionWarningSink;
}

export function createFileLoopPersistence(options: FileLoopPersistenceOptions): LoopPersistence {
	const runDir = join(options.rootDir, safeSegment(options.runId));
	const pendingPath = join(runDir, "pending-human-gate.json");
	const decisionsPath = join(runDir, "human-decisions.json");

	return {
		async savePendingHumanGate(request: HumanGateRequest): Promise<void> {
			await mkdir(runDir, { recursive: true });
			await writeFile(pendingPath, `${JSON.stringify(redactHumanGateRequest(request), null, "\t")}\n`, "utf8");
		},
		async loadPendingHumanGate(): Promise<HumanGateRequest | undefined> {
			const request = await readOptionalJson<HumanGateRequest>(pendingPath);
			if (!request) return undefined;
			const decisions = await readDecisions(decisionsPath, options.onWarning);
			if (findHumanDecisionForRequest(decisions, request.id)) {
				return undefined;
			}
			return request;
		},
		async saveHumanDecision(decision: HumanDecision): Promise<void> {
			await mkdir(runDir, { recursive: true });
			const decisions = await readDecisions(decisionsPath, options.onWarning);
			decisions.push(redactHumanDecision(decision));
			await writeFile(decisionsPath, `${JSON.stringify(decisions, null, "\t")}\n`, "utf8");
		},
		async loadHumanDecisions(): Promise<readonly HumanDecision[]> {
			return (await readDecisions(decisionsPath, options.onWarning)).map((decision) => ({ ...decision }));
		},
	};
}

function redactHumanGateRequest(request: HumanGateRequest): HumanGateRequest {
	return redactUnknown(request) as HumanGateRequest;
}

function redactHumanDecision(decision: HumanDecision): HumanDecision {
	return redactUnknown(decision) as HumanDecision;
}

async function readDecisions(filePath: string, onWarning?: HumanDecisionWarningSink): Promise<HumanDecision[]> {
	const parsed = await readOptionalJson<unknown>(filePath);
	if (parsed === undefined) return [];
	return parseHumanDecisionsFile(parsed, { filePath, warn: onWarning ?? logHumanDecisionWarning });
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as T;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function safeSegment(value: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
		throw new Error(`invalid loop persistence runId: ${value}`);
	}
	return value;
}

function logHumanDecisionWarning(warning: HumanDecisionParseWarning): void {
	console.warn(
		[
			`Invalid human decision persistence entry (${warning.code})`,
			`file=${warning.filePath}`,
			warning.index === undefined ? undefined : `index=${warning.index}`,
			warning.path ? `path=${warning.path}` : undefined,
			`message=${warning.message}`,
		].filter(Boolean).join(" "),
	);
}
