/**
 * Structured acceptance criteria for the evidence cross-check.
 *
 * Criteria are carried as the string `value` of `kind: "acceptance"` hard constraints on
 * the TaskContract, using a small machine-checkable syntax (parsed case-insensitively):
 *
 * - `exit-zero`                 — at least one receipt exists and every receipt exited 0.
 * - `file-exists <path>`        — the path exists on disk at cross-check time.
 * - `test-command <command>`    — a successful (allow, exit 0) receipt exists whose
 *                                 captured command equals the given command.
 * - `contains <text>`           — some receipt's captured stdout/stderr contains the text.
 *
 * Anything else is free text: it is surfaced to the blind reviewer but cannot be machine
 * verified, so a reviewer PASS with free-text criteria is demoted to NEEDS_HUMAN.
 */
export type AcceptanceCriterion =
	| { kind: "free-text"; raw: string }
	| { kind: "contains"; raw: string; text: string }
	| { kind: "exit-zero"; raw: string }
	| { kind: "file-exists"; raw: string; path: string }
	| { kind: "test-command"; raw: string; command: string };

export function parseAcceptanceCriterion(raw: string): AcceptanceCriterion {
	const trimmed = raw.trim();
	if (/^exit-zero$/i.test(trimmed)) return { kind: "exit-zero", raw };
	const fileExists = /^file-exists\s+(.+)$/i.exec(trimmed);
	if (fileExists?.[1]) return { kind: "file-exists", raw, path: fileExists[1].trim() };
	const testCommand = /^test-command\s+(.+)$/i.exec(trimmed);
	if (testCommand?.[1]) return { kind: "test-command", raw, command: testCommand[1].trim() };
	const containsPrefix = /^contains\s+(.+)$/i.exec(trimmed);
	if (containsPrefix?.[1]) return { kind: "contains", raw, text: containsPrefix[1].trim() };
	// Legacy form: a "contains <token>" phrase embedded in prose stays checkable.
	const containsToken = /\bcontains\s+([A-Za-z0-9._-]+)/i.exec(trimmed);
	if (containsToken?.[1]) return { kind: "contains", raw, text: containsToken[1] };
	return { kind: "free-text", raw };
}

export function parseAcceptanceCriteria(raw: readonly string[]): AcceptanceCriterion[] {
	return raw.map(parseAcceptanceCriterion);
}
