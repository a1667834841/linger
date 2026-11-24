// What the run status line shows for each Agent Run in a Room, built from
// `agent_run.status_changed` and the Run's runtime presentation events the
// way Web's Dock does.
import type {
  RoomRunStatus,
  RuntimePresentationEventRecord,
} from "../api/types";

export interface RunView {
  readonly run: RoomRunStatus;
  /** The short line under the Agent's name. */
  readonly line: string;
  /** The last presentation event ordinal folded into line. */
  readonly appliedOrdinal: string | undefined;
}

/** A Run the Agent is still working on: active and not yet replied. */
export function isWorking(run: RoomRunStatus): boolean {
  return run.status === "active" && !run.replied;
}

/** Keeps the newer of two snapshots of one Run; equal ordinals take the incoming one. */
export function mergeRun(
  current: RunView | undefined,
  incoming: RoomRunStatus,
): RunView {
  if (current && incoming.event_ordinal < current.run.event_ordinal)
    return current;
  return {
    run: incoming,
    line: current?.line ?? "Working",
    appliedOrdinal: current?.appliedOrdinal,
  };
}

/** Whether the Run has presentation events the view has not read yet. */
export function needsEvents(view: RunView): boolean {
  if (!isWorking(view.run)) return false;
  const applied =
    view.appliedOrdinal === undefined ? 0 : Number(view.appliedOrdinal);
  return view.run.event_ordinal > applied;
}

export function applyPresentationEvents(
  view: RunView,
  records: readonly RuntimePresentationEventRecord[],
  publishedThrough: string,
): RunView {
  let line = view.line;
  const titles = new Map<string, string>();
  for (const record of records) {
    const event = record.event;
    switch (event.type) {
      case "status.changed":
        if (event.status === "thinking")
          line = event.title ? event.title : "Thinking";
        else if (event.status === "queued")
          line = event.title ? event.title : "Queued";
        else if (event.status === "working") line = "Working";
        break;
      case "activity.started":
        titles.set(event.activity_id, event.title);
        line = event.title;
        break;
      case "activity.updated":
        if (event.detail) line = event.detail;
        break;
      case "plan.updated": {
        const step = event.steps.find(
          (candidate) => candidate.status === "in_progress",
        );
        if (step) line = step.content;
        break;
      }
      default:
        break;
    }
  }
  return { ...view, line, appliedOrdinal: publishedThrough };
}
