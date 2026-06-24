export const CONTEXT_TIERS = ["pinned", "warm", "cold"] as const;
export type ContextTier = (typeof CONTEXT_TIERS)[number];

export const DEFAULT_PROTECTED_RECENT_TURNS = 10;

export const FULL_COMPACTION_SECTION_TITLES = [
	"Main request & user intent",
	"Key technical concepts",
	"Files & code",
	"Pitfalls encountered & fixes",
	"Problem-solving process",
	"All user information, itemized",
	"Pending tasks",
	"What is currently being worked on",
	"The user's original wording for the next step",
] as const;

export type FullCompactionSectionTitle = (typeof FULL_COMPACTION_SECTION_TITLES)[number];

export interface ContextTierSignals {
	isPinned?: boolean;
	isRecent?: boolean;
	isCold?: boolean;
	isAgedOut?: boolean;
	hasColdBody?: boolean;
}

export interface ContextAnchor {
	id: string;
	retrievable: true;
	retrievableFrom?: string;
}

export interface ContextTombstone {
	kind: "context_tombstone";
	tier: "warm";
	removedSummary: string;
	reason?: string;
	anchor: ContextAnchor;
	text: string;
}

export interface FullCompactionSection {
	title: FullCompactionSectionTitle;
	content: string;
}

export interface FullCompactionSummary<TTurn = unknown> {
	kind: "full_compaction_summary";
	sections: FullCompactionSection[];
	protectedRecentTurns: TTurn[];
}

export interface CreateFullCompactionSummaryOptions<TTurn = unknown> {
	sections: Partial<Record<FullCompactionSectionTitle, string>>;
	originalNextStepWording: string;
	recentTurns?: readonly TTurn[];
	protectedTurnCount?: number;
}

export interface SelectProtectedRecentTurnsOptions {
	protectedTurnCount?: number;
}

export interface DeclaredToolPrefixEntry {
	name: string;
	description?: string;
	[key: string]: unknown;
}

export interface SkillCardIndexEntry {
	name: string;
	whenToUse: string;
	[key: string]: unknown;
}

export interface PrefixParts {
	systemPrompt: string;
	declaredTools: readonly DeclaredToolPrefixEntry[];
	skillCardIndex: readonly SkillCardIndexEntry[];
}

export interface FrozenPrefix extends PrefixParts {
	fingerprint: string;
}

export function classifyContextTier(signals: ContextTierSignals = {}): ContextTier {
	if (signals.isPinned || signals.isRecent) {
		return "pinned";
	}

	if (signals.isCold || signals.isAgedOut || signals.hasColdBody) {
		return "cold";
	}

	return "warm";
}

export function createTombstoneAnchor(options: {
	removedSummary: string;
	anchorId: string;
	retrievableFrom?: string;
	reason?: string;
}): ContextTombstone {
	const removedSummary = requireNonBlank(options.removedSummary, "removedSummary");
	const anchorId = requireNonBlank(options.anchorId, "anchorId");
	const anchor: ContextAnchor = options.retrievableFrom
		? { id: anchorId, retrievable: true, retrievableFrom: options.retrievableFrom }
		: { id: anchorId, retrievable: true };
	const reasonLine = options.reason ? `reason: ${options.reason}\n` : "";
	const locationLine = options.retrievableFrom ? `retrievable from: ${options.retrievableFrom}` : "retrievable from: anchor id";

	return {
		kind: "context_tombstone",
		tier: "warm",
		removedSummary,
		reason: options.reason,
		anchor,
		text: `${reasonLine}removed summary: ${removedSummary}\nretrievable anchor: ${anchorId}\n${locationLine}`,
	};
}

export function createFullCompactionSummary<TTurn = unknown>(
	options: CreateFullCompactionSummaryOptions<TTurn>,
): FullCompactionSummary<TTurn> {
	const sections = FULL_COMPACTION_SECTION_TITLES.map((title): FullCompactionSection => {
		const content =
			title === "The user's original wording for the next step"
				? options.originalNextStepWording
				: options.sections[title] ?? "";
		return { title, content };
	});

	return {
		kind: "full_compaction_summary",
		sections,
		protectedRecentTurns: selectProtectedRecentTurns(options.recentTurns ?? [], {
			protectedTurnCount: options.protectedTurnCount,
		}),
	};
}

export function selectProtectedRecentTurns<TTurn>(
	turns: readonly TTurn[],
	options: SelectProtectedRecentTurnsOptions = {},
): TTurn[] {
	const protectedTurnCount = options.protectedTurnCount ?? DEFAULT_PROTECTED_RECENT_TURNS;
	if (!Number.isFinite(protectedTurnCount) || protectedTurnCount <= 0) {
		return [];
	}

	return turns.slice(-Math.floor(protectedTurnCount));
}

export function createFrozenPrefix(parts: PrefixParts): FrozenPrefix {
	const prefix: FrozenPrefix = {
		systemPrompt: parts.systemPrompt,
		declaredTools: deepClone(parts.declaredTools),
		skillCardIndex: deepClone(parts.skillCardIndex),
		fingerprint: fingerprintPrefix(parts),
	};

	return deepFreeze(prefix);
}

export function assertPrefixInvariant(frozen: FrozenPrefix, candidate: PrefixParts): void {
	if (!isPrefixInvariant(frozen, candidate)) {
		throw new Error("Frozen prefix changed: system prompt, declared tools, and skill-card index are immutable");
	}
}

export function isPrefixInvariant(frozen: FrozenPrefix, candidate: PrefixParts): boolean {
	return frozen.fingerprint === fingerprintPrefix(candidate);
}

export function fingerprintPrefix(parts: PrefixParts): string {
	return stableStringify({
		systemPrompt: parts.systemPrompt,
		declaredTools: parts.declaredTools,
		skillCardIndex: parts.skillCardIndex,
	});
}

function requireNonBlank(value: string, name: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new Error(`${name} must not be blank`);
	}
	return trimmed;
}

function deepClone<T>(value: T): T {
	if (value === undefined) {
		return value;
	}

	return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null) {
		return value;
	}

	for (const nested of Object.values(value)) {
		deepFreeze(nested);
	}

	return Object.freeze(value);
}

function stableStringify(value: unknown): string {
	return stringifyStable(value, new Set());
}

function stringifyStable(value: unknown, seen: Set<object>): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}

	if (seen.has(value)) {
		throw new Error("Cannot fingerprint circular prefix data");
	}
	seen.add(value);

	if (Array.isArray(value)) {
		const serialized = `[${value.map((item) => stringifyStable(item, seen)).join(",")}]`;
		seen.delete(value);
		return serialized;
	}

	const record = value as Record<string, unknown>;
	const serialized = `{${Object.keys(record)
		.sort()
		.filter((key) => record[key] !== undefined)
		.map((key) => `${JSON.stringify(key)}:${stringifyStable(record[key], seen)}`)
		.join(",")}}`;
	seen.delete(value);
	return serialized;
}
