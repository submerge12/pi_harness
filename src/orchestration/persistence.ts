import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GateTier } from "../contract/index.ts";
import type { ReviewVerdict } from "../review/index.ts";

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
}

export function createFileLoopPersistence(options: FileLoopPersistenceOptions): LoopPersistence {
	const runDir = join(options.rootDir, safeSegment(options.runId));
	const pendingPath = join(runDir, "pending-human-gate.json");
	const decisionsPath = join(runDir, "human-decisions.json");

	return {
		async savePendingHumanGate(request: HumanGateRequest): Promise<void> {
			await mkdir(runDir, { recursive: true });
			await writeFile(pendingPath, `${JSON.stringify(request, null, "\t")}\n`, "utf8");
		},
		async loadPendingHumanGate(): Promise<HumanGateRequest | undefined> {
			const request = await readOptionalJson<HumanGateRequest>(pendingPath);
			if (!request) return undefined;
			const decisions = await readDecisions(decisionsPath);
			if (decisions.some((decision) => decision.requestId === request.id || decision.requestId === undefined)) {
				return undefined;
			}
			return request;
		},
		async saveHumanDecision(decision: HumanDecision): Promise<void> {
			await mkdir(runDir, { recursive: true });
			const decisions = await readDecisions(decisionsPath);
			decisions.push({ ...decision });
			await writeFile(decisionsPath, `${JSON.stringify(decisions, null, "\t")}\n`, "utf8");
		},
		async loadHumanDecisions(): Promise<readonly HumanDecision[]> {
			return (await readDecisions(decisionsPath)).map((decision) => ({ ...decision }));
		},
	};
}

async function readDecisions(filePath: string): Promise<HumanDecision[]> {
	return await readOptionalJson<HumanDecision[]>(filePath) ?? [];
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
