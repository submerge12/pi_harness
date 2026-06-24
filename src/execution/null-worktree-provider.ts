import type { WorktreeLease, WorktreeProvider, WriteScope } from "./types.ts";
import { validateWriteScope } from "./write-scope.ts";

export interface NullWorktreeProviderOptions {
	dir?: string;
	allowEmptyWriteScope?: boolean;
}

export function createNullWorktreeProvider(options: NullWorktreeProviderOptions = {}): WorktreeProvider {
	return {
		async acquire(_baselineSha: string, writeScope: WriteScope): Promise<WorktreeLease> {
			return {
				dir: options.dir ?? ".",
				writeScope: validateWriteScope(writeScope, { allowEmpty: options.allowEmptyWriteScope }),
				async dispose() {
					return undefined;
				},
			};
		},
	};
}
