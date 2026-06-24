const subjectKeys = ["command", "file_path", "path", "pattern"] as const;
const pathSubjectKeys = new Set<(typeof subjectKeys)[number]>(["file_path", "path"]);

export type SubjectKey = (typeof subjectKeys)[number];

export interface ResolvedSubject {
	key?: SubjectKey;
	subject: string;
	isPath: boolean;
}

export function normalizeSubject(subject: string): string {
	return subject.replaceAll("\\", "/");
}

export function normalizePathSubject(subject: string): string {
	const parts: string[] = [];

	for (const part of normalizeSubject(subject).split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.length > 0 && parts[parts.length - 1] !== "..") {
				parts.pop();
			} else {
				parts.push(part);
			}
			continue;
		}

		parts.push(part);
	}

	return parts.join("/");
}

export function resolveSubject(args: Record<string, unknown>): string {
	return resolveSubjectDetails(args).subject;
}

export function resolveSubjectDetails(args: Record<string, unknown>): ResolvedSubject {
	for (const key of subjectKeys) {
		const value = args[key];
		if (typeof value === "string") {
			const isPath = pathSubjectKeys.has(key);
			return {
				key,
				subject: isPath ? normalizePathSubject(value) : normalizeSubject(value),
				isPath,
			};
		}
	}

	return { subject: "", isPath: false };
}
