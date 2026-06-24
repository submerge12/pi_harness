import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ConsoleNotificationChannel,
	FileLogNotificationChannel,
	NotificationManager,
	type NotificationMessage,
	type NotificationStore,
} from "../../src/notifications/index.ts";

class MemoryNotificationStore implements NotificationStore {
	records: Array<NotificationMessage & { id: string; status: "pending" | "delivered" }> = [];

	async insert(message: NotificationMessage): Promise<string> {
		const id = `notification-${this.records.length + 1}`;
		this.records.push({ ...message, id, status: "pending" });
		return id;
	}

	async markDelivered(id: string): Promise<void> {
		const record = this.records.find((entry) => entry.id === id);
		if (record) record.status = "delivered";
	}

	async getPending(): Promise<NotificationMessage[]> {
		return this.records.filter((entry) => entry.status === "pending");
	}
}

describe("NotificationManager", () => {
	it("persists a notification and sends it through every channel", async () => {
		const sent: NotificationMessage[] = [];
		const store = new MemoryNotificationStore();
		const manager = new NotificationManager({
			channels: [
				{
					name: "memory",
					send: async (message) => {
						sent.push(message);
					},
				},
			],
			store,
		});

		await manager.notify({
			agentName: "travel",
			title: "Commute alert",
			body: "Rain starts before arrival.",
			severity: "warning",
			metadata: { tripId: "trip-1" },
		});

		expect(sent).toEqual([
			{
				agentName: "travel",
				title: "Commute alert",
				body: "Rain starts before arrival.",
				severity: "warning",
				metadata: { tripId: "trip-1" },
			},
		]);
		expect(store.records).toMatchObject([{ id: "notification-1", status: "delivered" }]);
	});

	it("leaves a stored notification pending when a channel fails", async () => {
		const store = new MemoryNotificationStore();
		const manager = new NotificationManager({
			channels: [
				{
					name: "broken",
					send: async () => {
						throw new Error("network down");
					},
				},
			],
			store,
		});

		await expect(
			manager.notify({
				agentName: "coding",
				title: "Review needed",
				body: "The unit test failed.",
				severity: "critical",
			}),
		).rejects.toThrow('Notification channel "broken" failed: network down');

		expect(store.records).toMatchObject([{ id: "notification-1", status: "pending" }]);
		await expect(manager.getPending()).resolves.toMatchObject([
			{
				agentName: "coding",
				title: "Review needed",
				body: "The unit test failed.",
				severity: "critical",
			},
		]);
	});

	it("attempts later channels and leaves the notification pending when a middle channel fails", async () => {
		const attemptedChannels: string[] = [];
		const successfulChannels: string[] = [];
		const store = new MemoryNotificationStore();
		const message: NotificationMessage = {
			agentName: "coding",
			title: "Review needed",
			body: "The unit test failed.",
			severity: "critical",
		};
		const manager = new NotificationManager({
			channels: [
				{
					name: "audit-log",
					send: async (sentMessage) => {
						attemptedChannels.push("audit-log");
						if (sentMessage === message) successfulChannels.push("audit-log");
					},
				},
				{
					name: "email",
					send: async () => {
						attemptedChannels.push("email");
						throw new Error("smtp down");
					},
				},
				{
					name: "webhook",
					send: async (sentMessage) => {
						attemptedChannels.push("webhook");
						if (sentMessage === message) successfulChannels.push("webhook");
					},
				},
			],
			store,
		});

		await expect(manager.notify(message)).rejects.toThrow('Notification channel "email" failed: smtp down');

		expect(attemptedChannels).toEqual(["audit-log", "email", "webhook"]);
		expect(successfulChannels).toEqual(["audit-log", "webhook"]);
		expect(store.records).toMatchObject([{ id: "notification-1", status: "pending" }]);
		await expect(manager.getPending()).resolves.toMatchObject([message]);
	});

	it("returns no pending notifications when no store is configured", async () => {
		const manager = new NotificationManager();

		await expect(manager.getPending()).resolves.toEqual([]);
	});
});

describe("ConsoleNotificationChannel", () => {
	it("writes a concise notification line through the configured output", async () => {
		const lines: string[] = [];
		const channel = new ConsoleNotificationChannel({ output: (line) => lines.push(line) });

		await channel.send({
			agentName: "ops",
			title: "Deploy blocked",
			body: "Approval is required.",
			severity: "warning",
		});

		expect(lines).toEqual(["[warning] ops: Deploy blocked - Approval is required."]);
	});
});

describe("FileLogNotificationChannel", () => {
	it("appends notifications as JSONL and creates the parent directory", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-harness-notifications-"));
		const filePath = join(directory, "nested", "notifications.jsonl");
		const channel = new FileLogNotificationChannel({ filePath });

		const firstMessage: NotificationMessage = {
			agentName: "research",
			title: "Source ready",
			body: "The report can be cited.",
			metadata: { sourceId: "source-1" },
		};
		const secondMessage: NotificationMessage = {
			agentName: "research",
			title: "Source stale",
			body: "Refresh before citing.",
			severity: "warning",
		};

		await channel.send(firstMessage);
		await channel.send(secondMessage);

		const lines = (await readFile(filePath, "utf8")).trim().split("\n");
		expect(lines.map((line) => JSON.parse(line))).toEqual([firstMessage, secondMessage]);
	});
});
