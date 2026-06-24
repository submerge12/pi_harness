export type NotificationSeverity = "info" | "warning" | "critical";

export interface NotificationMessage {
	title: string;
	body: string;
	agentName: string;
	severity?: NotificationSeverity;
	metadata?: Record<string, unknown>;
}

export interface NotificationChannel {
	name: string;
	send(message: NotificationMessage): Promise<void> | void;
}

export interface NotificationStore {
	insert(message: NotificationMessage): Promise<string> | string;
	markDelivered(id: string): Promise<void> | void;
	getPending(): Promise<NotificationMessage[]> | NotificationMessage[];
}
