import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const agentEvents = pgTable("agent_events", {
	id: uuid("id").primaryKey().defaultRandom(),
	sessionId: text("session_id").notNull(),
	agentName: text("agent_name").notNull(),
	parentId: text("parent_id"),
	eventType: text("event_type").notNull(),
	payload: jsonb("payload").notNull(),
	createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const notifications = pgTable("notifications", {
	id: uuid("id").primaryKey().defaultRandom(),
	agentName: text("agent_name").notNull(),
	channel: text("channel").notNull(),
	title: text("title").notNull(),
	body: text("body").notNull(),
	metadata: jsonb("metadata").notNull(),
	status: text("status").notNull(),
	createdAt: timestamp("created_at").notNull().defaultNow(),
	deliveredAt: timestamp("delivered_at"),
});
