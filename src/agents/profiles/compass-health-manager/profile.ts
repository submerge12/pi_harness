/**
 * WO-HS-10 / M13: compass-health-manager — long-horizon observer.
 *
 * Reads aggregate projections only (daily states over a window). Produces
 * findings + policy proposals; never writes health facts and never changes
 * plans. Every conclusion must cite its evidence window and denominator.
 */
import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolRegistration } from "../../../tools/types.ts";
import type { AgentProfile } from "../../profile.ts";

const BFF_BASE = process.env["PI_HEALTH_BFF_URL"] ?? "http://127.0.0.1:8000";
const BFF_TOKEN = process.env["PI_HEALTH_BFF_TOKEN"] ?? "";

async function bffGet(path: string): Promise<unknown> {
  const headers: Record<string, string> = { "X-Actor": "manager" };
  if (BFF_TOKEN) headers["Authorization"] = `Bearer ${BFF_TOKEN}`;
  const response = await fetch(`${BFF_BASE}${path}`, { headers });
  try {
    return await response.json();
  } catch {
    return { error: `http_${response.status}` };
  }
}

function jsonToolResult(payload: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

const managerTools: ToolRegistration[] = [
  {
    accessLevel: "read-only",
    tool: {
      name: "manager_read_daily_state_window",
      label: "Read Daily State Window",
      description:
        "Read daily health states for the last N days (aggregate observation window). Cite this window in every finding.",
      parameters: Type.Object({
        days: Type.Optional(Type.Number({ description: "window length, default 14" })),
      }),
      async execute(_id, params): Promise<AgentToolResult<unknown>> {
        const p = params as { days?: number };
        const days = Math.min(Math.max(p.days ?? 14, 1), 90);
        const dates: unknown[] = [];
        for (let i = 0; i < days; i++) {
          const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
          dates.push(await bffGet(`/api/domain/v1/daily-state?date=${d}`));
        }
        return jsonToolResult({ window_days: days, states: dates });
      },
    },
  },
];

const SYSTEM_PROMPT = [
  "# Compass Health — manager (long-horizon observer)",
  "",
  "You analyse multi-day health state windows to find behavioural patterns:",
  "recommendations repeatedly ignored, training completion trends, recurring",
  "pain, repeated questions.",
  "",
  "Hard rules:",
  "1. Every finding MUST cite its evidence window (dates) and denominator",
  "   (e.g. '3 of 5 planned sessions').",
  "2. Fewer than 3 data points -> report insufficient_data instead of a trend.",
  "3. You output FINDINGS and PROPOSALS only. You cannot modify plans, write",
  "   facts, or activate anything.",
].join("\n");

const managerProfileAdapter = {
  name: "compass-health-manager",
  description:
    "Read-only long-horizon observer producing cited findings and policy proposals; no write capability.",
  systemPrompt: SYSTEM_PROMPT,
  tools: [() => managerTools],
  policy: {
    defaults: {
      "read-only": "allow",
      write: "deny",
      destructive: "deny",
      network: "deny",
    },
  },
  install: async () => undefined,
  skills: [],
  templates: [],
} satisfies AgentProfile;

export const compassHealthManagerProfile = managerProfileAdapter as AgentProfile;
export default compassHealthManagerProfile;
