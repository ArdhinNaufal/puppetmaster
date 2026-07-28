import type { Approval, Mission } from "../api.js";

export interface MissionAcknowledgement {
  status: string;
  acknowledgedAt: string;
}

const RESULT_STATUSES = new Set(["succeeded", "failed"]);
const OPEN_APPROVAL_STATUSES = new Set(["pending", "open", "awaiting_approval"]);

/** Terminal mission states that produce a result an operator can acknowledge. */
export function isMissionResult(mission: Pick<Mission, "status">): boolean {
  return RESULT_STATUSES.has(mission.status);
}

/** Immediate-action work is never hidden by the result acknowledgement gate. */
export function isUrgentMission(
  mission: Pick<Mission, "id" | "status">,
  approvals: Pick<Approval, "missionId" | "status">[],
): boolean {
  return mission.status === "awaiting_approval" || approvals.some(
    (approval) => approval.missionId === mission.id && OPEN_APPROVAL_STATUSES.has(approval.status),
  );
}

export function isAcknowledgedResult(
  mission: Pick<Mission, "status">,
  acknowledgement: MissionAcknowledgement | undefined,
): boolean {
  return isMissionResult(mission) && acknowledgement?.status === mission.status;
}

/** The active pane gate: live/urgent work stays visible; acknowledged results do not. */
export function shouldShowMissionInPane(
  mission: Pick<Mission, "id" | "status">,
  acknowledgement: MissionAcknowledgement | undefined,
  approvals: Pick<Approval, "missionId" | "status">[],
): boolean {
  return !isAcknowledgedResult(mission, acknowledgement) || isUrgentMission(mission, approvals);
}
