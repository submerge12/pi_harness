import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { NotificationChannel, NotificationMessage } from "../types.ts";

export interface FileLogNotificationChannelOptions {
	filePath: string;
}

export class FileLogNotificationChannel implements NotificationChannel {
	readonly name = "file-log";
	private readonly filePath: string;

	constructor(options: FileLogNotificationChannelOptions) {
		this.filePath = options.filePath;
	}

	async send(message: NotificationMessage): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		await appendFile(this.filePath, `${JSON.stringify(message)}\n`, "utf8");
	}
}
