import type { NotificationChannel, NotificationMessage } from "../types.ts";

export interface ConsoleNotificationChannelOptions {
	output?: (line: string) => void;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export class ConsoleNotificationChannel implements NotificationChannel {
	readonly name = "console";
	private readonly output: (line: string) => void;

	constructor(options: ConsoleNotificationChannelOptions = {}) {
		this.output = options.output ?? console.log;
	}

	send(message: NotificationMessage): void {
		const severity = message.severity ?? "info";
		const prefix = `[${severity}] ${oneLine(message.agentName)}: ${oneLine(message.title)}`;
		const body = oneLine(message.body);
		this.output(body.length > 0 ? `${prefix} - ${body}` : prefix);
	}
}
