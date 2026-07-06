export interface CheckpointStore {
	beginAttempt?(attempt: number): void;
	finishAttempt?(): void;
	baselineAttempt?(attempt: number, writeScope: readonly string[]): Promise<void> | void;
	snapshot(attempt: number, path: string): Promise<void> | void;
	snapshotCurrent?(path: string): Promise<void> | void;
	restore(fromAttempt: number): Promise<void> | void;
	readFile(path: string): string | undefined;
	writeFile(path: string, content: string): void;
	deleteFile(path: string): void;
}

export interface CheckpointStoreOptions {
	rootDir: string;
	files?: Map<string, string> | Record<string, string>;
}
