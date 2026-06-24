import type { AgentProfile, AgentToolFactoryContext } from "../agents/profile.ts";
import { getProfile } from "../agents/registry.ts";
import type { ScheduledTaskDefinition, ScheduledTaskResult, SchedulerConfig } from "./types.ts";

const DEFAULT_CHECK_INTERVAL_MS = 60_000;
const SUMMARY_LIMIT = 500;

export interface SchedulerNotificationMessage {
	agentName: string;
	title: string;
	body: string;
}

export interface SchedulerNotificationManager {
	send(message: SchedulerNotificationMessage): void | Promise<void>;
}

export type SchedulerProfileResolver = (name: string) => AgentProfile | Promise<AgentProfile>;
export type SchedulerSetTimeout = (callback: () => void, delayMs: number) => unknown;
export type SchedulerClearTimeout = (handle: unknown) => void;

export interface SchedulerOptions {
	config: SchedulerConfig;
	context: AgentToolFactoryContext;
	notifications?: SchedulerNotificationManager;
	profileResolver?: SchedulerProfileResolver;
	now?: () => Date;
	setTimeout?: SchedulerSetTimeout;
	clearTimeout?: SchedulerClearTimeout;
}

interface DateParts {
	minute: number;
	hour: number;
	dayOfMonth: number;
	month: number;
	weekday: number;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isUtcTimezone(timezone: string | undefined): boolean {
	return timezone?.toUpperCase() === "UTC";
}

function dateParts(date: Date, timezone: string | undefined): DateParts {
	if (isUtcTimezone(timezone)) {
		return {
			minute: date.getUTCMinutes(),
			hour: date.getUTCHours(),
			dayOfMonth: date.getUTCDate(),
			month: date.getUTCMonth() + 1,
			weekday: date.getUTCDay(),
		};
	}
	return {
		minute: date.getMinutes(),
		hour: date.getHours(),
		dayOfMonth: date.getDate(),
		month: date.getMonth() + 1,
		weekday: date.getDay(),
	};
}

function matchesCronField(field: string, value: number): boolean {
	if (field === "*") return true;
	return field.split(",").some((part) => {
		const parsed = Number(part);
		return Number.isInteger(parsed) && parsed === value;
	});
}

function matchesCron(cron: string, now: Date, timezone: string | undefined): boolean {
	const fields = cron.trim().split(/\s+/);
	if (fields.length !== 5) return false;
	const [minute, hour, dayOfMonth, month, weekday] = fields;
	if (!minute || !hour || !dayOfMonth || !month || !weekday) return false;
	const parts = dateParts(now, timezone);
	return (
		matchesCronField(minute, parts.minute) &&
		matchesCronField(hour, parts.hour) &&
		matchesCronField(dayOfMonth, parts.dayOfMonth) &&
		matchesCronField(month, parts.month) &&
		matchesCronField(weekday, parts.weekday)
	);
}

function ranThisMinute(now: Date, lastRun: Date | undefined): boolean {
	if (!lastRun) return false;
	return Math.floor(now.getTime() / 60_000) === Math.floor(lastRun.getTime() / 60_000);
}

function summarize(output: string): string {
	return output.length <= SUMMARY_LIMIT ? output : `${output.slice(0, SUMMARY_LIMIT - 3)}...`;
}

export class Scheduler {
	private readonly options: SchedulerOptions;
	private readonly context: AgentToolFactoryContext;
	private readonly notifications?: SchedulerNotificationManager;
	private readonly profileResolver: SchedulerProfileResolver;
	private readonly now: () => Date;
	private readonly setTimer: SchedulerSetTimeout;
	private readonly clearTimer: SchedulerClearTimeout;
	private readonly lastRuns = new Map<string, Date>();
	private readonly runningTaskIds = new Set<string>();
	private timer: unknown;
	private stopped = true;

	constructor(options: SchedulerOptions) {
		this.options = options;
		this.context = options.context;
		this.notifications = options.notifications;
		this.profileResolver = options.profileResolver ?? getProfile;
		this.now = options.now ?? (() => new Date());
		this.setTimer = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
		this.clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	}

	start(): void {
		if (this.options.config.enabled === false || !this.stopped) return;
		this.stopped = false;
		this.scheduleNext(0);
	}

	stop(): void {
		this.stopped = true;
		if (this.timer === undefined) return;
		this.clearTimer(this.timer);
		this.timer = undefined;
	}

	isDue(task: ScheduledTaskDefinition, now: Date = this.now(), lastRun = this.lastRuns.get(task.id)): boolean {
		if (task.enabled === false) return false;
		const intervalMinutes = task.schedule.intervalMinutes;
		let intervalDue = false;
		if (intervalMinutes !== undefined && intervalMinutes > 0) {
			intervalDue = !lastRun || now.getTime() - lastRun.getTime() >= intervalMinutes * 60_000;
		}
		const cron = task.schedule.cron;
		const cronDue = cron ? !ranThisMinute(now, lastRun) && matchesCron(cron, now, task.schedule.timezone) : false;
		return intervalDue || cronDue;
	}

	async runDueSchedules(now: Date = this.now()): Promise<readonly ScheduledTaskResult[]> {
		const tasks = (this.options.config.tasks ?? []).filter((task) => this.isDue(task, now));
		const runnable = tasks.filter((task) => !this.runningTaskIds.has(task.id));
		return await Promise.all(runnable.map((task) => this.runTask(task.id)));
	}

	async runTask(taskId: string): Promise<ScheduledTaskResult> {
		const task = (this.options.config.tasks ?? []).find((candidate) => candidate.id === taskId);
		if (!task) return this.failureResult(taskId, "", `Scheduled task not found: ${taskId}`);
		if (this.runningTaskIds.has(taskId)) {
			return this.failureResult(task.id, task.agentProfile, `Scheduled task is already running: ${taskId}`);
		}
		this.runningTaskIds.add(taskId);
		const startedAt = this.now();
		try {
			const profile = await this.profileResolver(task.agentProfile);
			if (!profile.proactiveCheck) {
				throw new Error(`Agent profile ${task.agentProfile} does not define proactiveCheck`);
			}
			const output = await profile.proactiveCheck(this.context);
			await this.notifications?.send({
				agentName: task.agentProfile,
				title: `Scheduled check: ${task.id}`,
				body: summarize(output),
			});
			return {
				taskId: task.id,
				agentProfile: task.agentProfile,
				success: true,
				output,
				startedAt: startedAt.toISOString(),
				finishedAt: this.now().toISOString(),
			};
		} catch (error) {
			return {
				taskId: task.id,
				agentProfile: task.agentProfile,
				success: false,
				error: errorMessage(error),
				startedAt: startedAt.toISOString(),
				finishedAt: this.now().toISOString(),
			};
		} finally {
			this.lastRuns.set(taskId, this.now());
			this.runningTaskIds.delete(taskId);
		}
	}

	private failureResult(taskId: string, agentProfile: string, error: string): ScheduledTaskResult {
		const timestamp = this.now().toISOString();
		return { taskId, agentProfile, success: false, error, startedAt: timestamp, finishedAt: timestamp };
	}

	private scheduleNext(delayMs = this.options.config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS): void {
		if (this.stopped) return;
		this.timer = this.setTimer(() => {
			void this.tick();
		}, delayMs);
	}

	private async tick(): Promise<void> {
		this.timer = undefined;
		try {
			await this.runDueSchedules();
		} finally {
			this.scheduleNext();
		}
	}
}
