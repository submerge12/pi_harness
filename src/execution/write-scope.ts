import path from "node:path";
import type { WriteScope, WriteScopeValidationOptions } from "./types.ts";

export interface OwnedWriteScope {
	owner: string;
	writeScope: WriteScope;
}

export function normalizeWriteScope(writeScope: WriteScope, options: WriteScopeValidationOptions = {}): string[] {
	const normalized = [...new Set(writeScope.map(normalizeWriteScopePath))].sort(compareScopePaths);
	if (!options.allowEmpty && normalized.length === 0) throw new Error("write scope must include at least one path");
	return normalized;
}

export function validateWriteScope(writeScope: WriteScope, options: WriteScopeValidationOptions = {}): string[] {
	return normalizeWriteScope(writeScope, options);
}

export function assertNonOverlappingWriteScopes(scopes: readonly OwnedWriteScope[]): OwnedWriteScope[] {
	const normalizedScopes = scopes
		.map((scope) => ({
			owner: scope.owner,
			writeScope: normalizeWriteScope(scope.writeScope),
		}))
		.sort(compareOwnedScope);

	for (let leftIndex = 0; leftIndex < normalizedScopes.length; leftIndex += 1) {
		const left = normalizedScopes[leftIndex];
		for (let rightIndex = leftIndex + 1; rightIndex < normalizedScopes.length; rightIndex += 1) {
			const right = normalizedScopes[rightIndex];
			const overlap = firstOverlap(left.writeScope, right.writeScope);
			if (overlap) {
				const [leftPath, rightPath] = overlap;
				throw new Error(`write scope overlap between ${left.owner} (${leftPath}) and ${right.owner} (${rightPath})`);
			}
		}
	}

	return normalizedScopes;
}

function firstOverlap(leftScope: readonly string[], rightScope: readonly string[]): [string, string] | undefined {
	for (const leftPath of leftScope) {
		for (const rightPath of rightScope) {
			if (scopePathsOverlap(leftPath, rightPath)) return [leftPath, rightPath];
		}
	}
	return undefined;
}

function scopePathsOverlap(leftPath: string, rightPath: string): boolean {
	return leftPath === rightPath || isChildScope(leftPath, rightPath) || isChildScope(rightPath, leftPath);
}

function isChildScope(parent: string, child: string): boolean {
	return child.startsWith(`${parent}/`);
}

export function isPathWithinWriteScope(subjectPath: string, writeScope: WriteScope): boolean {
	const normalizedSubject = normalizeWriteScopePath(subjectPath);
	return normalizeWriteScope(writeScope).some((scopePath) => {
		const scopeRoot = scopePath.endsWith("/**") ? scopePath.slice(0, -3) : scopePath;
		return normalizedSubject === scopeRoot || isChildScope(scopeRoot, normalizedSubject);
	});
}

export function normalizeWriteScopePath(scopePath: string): string {
	const slashNormalized = scopePath.replaceAll("\\", "/").trim();
	if (/^[A-Za-z]:($|\/)/.test(slashNormalized)) {
		throw new Error(`write scope path must be relative and colon-free: ${scopePath}`);
	}
	const virtualUri = normalizeVirtualWriteScopeUri(slashNormalized);
	if (virtualUri) return virtualUri;
	if (slashNormalized.includes(":")) {
		throw new Error(`write scope path must be relative and colon-free: ${scopePath}`);
	}
	const normalized = path.posix.normalize(slashNormalized);
	if (normalized === "." || normalized === "") throw new Error(`invalid write scope path: ${scopePath}`);
	if (normalized.startsWith("../") || normalized === "..") throw new Error(`write scope path must not escape root: ${scopePath}`);
	if (path.posix.isAbsolute(normalized)) throw new Error(`write scope path must be relative: ${scopePath}`);
	return normalized;
}

function normalizeVirtualWriteScopeUri(scopePath: string): string | undefined {
	const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]+)(\/[^?#]*)?$/.exec(scopePath);
	if (!match) return undefined;
	const [, scheme, authority, rawPath = ""] = match;
	const segments = rawPath.split("/");
	if (segments.some((segment) => segment === "..")) {
		throw new Error(`write scope path must not escape root: ${scopePath}`);
	}
	const normalizedPath = path.posix.normalize(rawPath || "/");
	const pathSuffix = normalizedPath === "/" ? "" : normalizedPath;
	return `${scheme}://${authority}${pathSuffix}`;
}

function compareOwnedScope(left: OwnedWriteScope, right: OwnedWriteScope): number {
	const leftFirstPath = left.writeScope[0] ?? "";
	const rightFirstPath = right.writeScope[0] ?? "";
	return compareScopePaths(leftFirstPath, rightFirstPath) || left.owner.localeCompare(right.owner);
}

function compareScopePaths(left: string, right: string): number {
	return left.localeCompare(right);
}
