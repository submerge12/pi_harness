export interface CronLikeSchedule {
	intervalMinutes?: number;
	cron?: string;
	timezone?: string;
}

export interface ScheduledTaskDefinition {
	id: string;
	agentProfile: string;
	taskType: "proactive_check";
	schedule: CronLikeSchedule;
	enabled?: boolean;
}

export interface ScheduledTaskResult {
	taskId: string;
	agentProfile: string;
	success: boolean;
	output?: string;
	error?: string;
	startedAt: string;
	finishedAt: string;
}

export interface SchedulerConfig {
	enabled?: boolean;
	checkIntervalMs?: number;
	tasks?: readonly ScheduledTaskDefinition[];
}
