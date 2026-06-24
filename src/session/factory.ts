import { JsonlSessionRepo, type JsonlSessionMetadata, type Session } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { repairJsonlTail, type JsonlTailRecoveryResult } from "./recovery.ts";

export {
	createFileDomainSessionStore,
	type Decision,
	type DomainSession,
	type DomainSessionStore,
	type FileDomainSessionStoreOptions,
	type Question,
} from "./domain-session.ts";

export interface JsonlSessionFactoryOptions {
	cwd: string;
	sessionsRoot: string;
	shellPath?: string;
	shellEnv?: NodeJS.ProcessEnv;
}

export interface JsonlSessionFactoryResult {
	env: NodeExecutionEnv;
	session: Session<JsonlSessionMetadata>;
}

export interface OpenJsonlSessionOptions extends JsonlSessionFactoryOptions {
	onRecovery?: (result: JsonlTailRecoveryResult) => Promise<void> | void;
	sessionId: string;
}

export interface JsonlSessionListOptions extends JsonlSessionFactoryOptions {
	all?: boolean;
}

interface JsonlSessionRepoFactoryResult {
	env: NodeExecutionEnv;
	repo: JsonlSessionRepo;
}

function createSessionRepo(options: JsonlSessionFactoryOptions): JsonlSessionRepoFactoryResult {
	const env = new NodeExecutionEnv({
		cwd: options.cwd,
		shellPath: options.shellPath,
		shellEnv: options.shellEnv,
	});
	const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: options.sessionsRoot });
	return { env, repo };
}

function compareNewestFirst(first: JsonlSessionMetadata, second: JsonlSessionMetadata): number {
	const createdAtOrder = second.createdAt.localeCompare(first.createdAt);
	if (createdAtOrder !== 0) return createdAtOrder;
	return second.id.localeCompare(first.id);
}

export async function createJsonlSession(options: JsonlSessionFactoryOptions): Promise<JsonlSessionFactoryResult> {
	const { env, repo } = createSessionRepo(options);
	const session = await repo.create({ cwd: options.cwd });
	return { env, session };
}

export async function openJsonlSession(options: OpenJsonlSessionOptions): Promise<JsonlSessionFactoryResult> {
	const { env, repo } = createSessionRepo(options);
	const sessions = await repo.list();
	const metadata = sessions.find((session) => session.id === options.sessionId);
	if (!metadata) throw new Error(`session not found: ${options.sessionId}`);
	const recovery = await repairJsonlTail(metadata.path);
	if (recovery.repaired) await options.onRecovery?.(recovery);
	const session = await repo.open(metadata);
	return { env, session };
}

export async function listSessions(options: JsonlSessionListOptions): Promise<JsonlSessionMetadata[]> {
	const { env, repo } = createSessionRepo(options);
	try {
		const sessions = await repo.list(options.all ? undefined : { cwd: options.cwd });
		return [...sessions].sort(compareNewestFirst);
	} finally {
		await env.cleanup();
	}
}
