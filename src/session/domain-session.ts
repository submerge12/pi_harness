import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Decision {
	id: string;
	text: string;
	madeAt: number;
}

export interface Question {
	id: string;
	text: string;
	askedAt: number;
}

export interface DomainSession {
	activeGoal?: string;
	decisions: Decision[];
	unresolved: Question[];
	artifactRefs: string[];
}

export interface DomainSessionStore {
	get(conversationId: string): Promise<DomainSession>;
	update(
		conversationId: string,
		fn: (session: DomainSession) => DomainSession | Promise<DomainSession>,
	): Promise<DomainSession>;
}

export interface FileDomainSessionStoreOptions {
	rootDir: string;
}

export function createFileDomainSessionStore(options: FileDomainSessionStoreOptions): DomainSessionStore {
	return {
		async get(conversationId: string): Promise<DomainSession> {
			return await readSession(sessionPath(options.rootDir, conversationId));
		},
		async update(conversationId, fn): Promise<DomainSession> {
			const filePath = sessionPath(options.rootDir, conversationId);
			const next = cloneSession(await fn(await readSession(filePath)));
			await mkdir(options.rootDir, { recursive: true });
			await writeFile(filePath, `${JSON.stringify(next, null, "\t")}\n`, "utf8");
			return cloneSession(next);
		},
	};
}

async function readSession(filePath: string): Promise<DomainSession> {
	try {
		const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<DomainSession>;
		return cloneSession({
			...(parsed.activeGoal ? { activeGoal: parsed.activeGoal } : {}),
			decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
			unresolved: Array.isArray(parsed.unresolved) ? parsed.unresolved : [],
			artifactRefs: Array.isArray(parsed.artifactRefs) ? parsed.artifactRefs : [],
		});
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return emptySession();
		throw error;
	}
}

function sessionPath(rootDir: string, conversationId: string): string {
	return join(rootDir, `${safeSegment(conversationId)}.json`);
}

function safeSegment(value: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
		throw new Error(`invalid domain session id: ${value}`);
	}
	return value;
}

function emptySession(): DomainSession {
	return { decisions: [], unresolved: [], artifactRefs: [] };
}

function cloneSession(session: DomainSession): DomainSession {
	return {
		...(session.activeGoal ? { activeGoal: session.activeGoal } : {}),
		decisions: session.decisions.map((decision) => ({ ...decision })),
		unresolved: session.unresolved.map((question) => ({ ...question })),
		artifactRefs: [...session.artifactRefs],
	};
}
