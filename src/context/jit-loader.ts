import { assertPrefixInvariant, type FrozenPrefix } from "./lifecycle.ts";

export type JitBodyKind = "skill" | "tool";

export interface CompactJitIndexEntry {
	kind: JitBodyKind;
	name: string;
	anchor: string;
	whenToUse?: string;
}

export interface JitBodyRequest {
	kind: JitBodyKind;
	name: string;
}

export type JitLoadedBody = string | { body: string };

export interface DynamicJitSuffixItem {
	kind: JitBodyKind;
	name: string;
	anchor: string;
	body: string;
}

export interface DynamicJitSuffix {
	kind: "dynamic_jit_suffix";
	prefixFingerprint: string;
	items: DynamicJitSuffixItem[];
}

export interface LoadJitDynamicSuffixOptions {
	prefix: FrozenPrefix;
	compactIndex: readonly CompactJitIndexEntry[];
	requests: readonly JitBodyRequest[];
	loadBody: (entry: CompactJitIndexEntry) => Promise<JitLoadedBody> | JitLoadedBody;
}

export async function loadJitDynamicSuffix(options: LoadJitDynamicSuffixOptions): Promise<DynamicJitSuffix> {
	assertPrefixInvariant(options.prefix, options.prefix);
	const prefixFingerprint = options.prefix.fingerprint;
	const items: DynamicJitSuffixItem[] = [];

	for (const request of options.requests) {
		const entry = findIndexEntry(options.compactIndex, request);
		const loaded = await options.loadBody(entry);
		items.push({
			kind: entry.kind,
			name: entry.name,
			anchor: entry.anchor,
			body: readDynamicBody(loaded),
		});
	}

	assertPrefixInvariant(options.prefix, options.prefix);
	if (options.prefix.fingerprint !== prefixFingerprint) {
		throw new Error("Frozen prefix changed while loading JIT dynamic suffix");
	}

	return {
		kind: "dynamic_jit_suffix",
		prefixFingerprint,
		items,
	};
}

function findIndexEntry(
	compactIndex: readonly CompactJitIndexEntry[],
	request: JitBodyRequest,
): CompactJitIndexEntry {
	const entry = compactIndex.find((candidate) => candidate.kind === request.kind && candidate.name === request.name);
	if (!entry) {
		throw new Error(`No JIT ${request.kind} entry found for ${request.name}`);
	}

	return entry;
}

function readDynamicBody(loaded: JitLoadedBody): string {
	if (typeof loaded === "string") {
		return loaded;
	}

	if (typeof loaded !== "object" || loaded === null) {
		throw new Error("JIT loader must return a dynamic suffix body");
	}

	const record = loaded as Record<string, unknown>;
	for (const forbidden of ["systemPrompt", "declaredTools", "skillCardIndex", "prefix", "frozenPrefix"]) {
		if (forbidden in record) {
			throw new Error("JIT loader may only return dynamic suffix body, not prefix or declared tool changes");
		}
	}

	if (typeof record.body !== "string") {
		throw new Error("JIT loader must return a dynamic suffix body");
	}

	return record.body;
}
