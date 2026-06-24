import type { NotificationChannel, NotificationMessage, NotificationStore } from "./types.ts";

export interface NotificationManagerOptions {
	channels?: NotificationChannel[];
	store?: NotificationStore;
}

function describeError(error: unknown): string {
	if (error instanceof Error && error.message.length > 0) return error.message;
	return String(error);
}

export interface NotificationDeliveryFailure {
	channelName: string;
	cause: unknown;
}

function describeFailure(failure: NotificationDeliveryFailure): string {
	return `Notification channel "${failure.channelName}" failed: ${describeError(failure.cause)}`;
}

function describeFailures(failures: readonly NotificationDeliveryFailure[]): string {
	if (failures.length === 1) return describeFailure(failures[0]);
	return `Notification channels failed: ${failures.map(describeFailure).join("; ")}`;
}

export class NotificationDeliveryError extends Error {
	readonly channelName: string;
	readonly cause: unknown;
	readonly failures: readonly NotificationDeliveryFailure[];

	constructor(channelName: string, cause: unknown, failures?: readonly NotificationDeliveryFailure[]) {
		const deliveryFailures = failures ?? [{ channelName, cause }];
		super(describeFailures(deliveryFailures));
		this.name = "NotificationDeliveryError";
		this.channelName = channelName;
		this.cause = cause;
		this.failures = deliveryFailures;
	}
}

export class NotificationManager {
	private readonly channels: NotificationChannel[];
	private readonly store?: NotificationStore;

	constructor(options: NotificationManagerOptions = {}) {
		this.channels = [...(options.channels ?? [])];
		this.store = options.store;
	}

	async notify(message: NotificationMessage): Promise<void> {
		const notificationId = this.store ? await this.store.insert(message) : undefined;
		const failures: NotificationDeliveryFailure[] = [];

		for (const channel of this.channels) {
			try {
				await channel.send(message);
			} catch (error) {
				failures.push({ channelName: channel.name, cause: error });
			}
		}

		if (failures.length > 0) {
			const firstFailure = failures[0];
			throw new NotificationDeliveryError(firstFailure.channelName, firstFailure.cause, failures);
		}

		if (notificationId !== undefined) {
			await this.store?.markDelivered(notificationId);
		}
	}

	async getPending(): Promise<NotificationMessage[]> {
		return this.store ? await this.store.getPending() : [];
	}
}
