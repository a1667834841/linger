// A Routine's schedule in a few words, the way the desktop's Routines list
// reads it: "Daily at 09:00", "Mon, Wed at 18:30", "Every 2 hours".
import type { Routine } from "../api/types";

type Cadence = NonNullable<Routine["cadence"]>;

const DAYS: Record<string, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

function clock(cadence: Cadence): string {
  const hour = String(cadence.hour ?? 0).padStart(2, "0");
  const minute = String(cadence.minute ?? 0).padStart(2, "0");
  return `${hour}:${minute}`;
}

export function describeCadence(cadence: Cadence | undefined): string {
  if (!cadence) return "When something happens";
  switch (cadence.kind) {
    case "daily":
      return `Daily at ${clock(cadence)}`;
    case "weekly": {
      const days = (cadence.weekdays ?? []).map((day) => DAYS[day] ?? day);
      return `${days.join(", ") || "Weekly"} at ${clock(cadence)}`;
    }
    case "every_n_hours":
      return cadence.interval_hours === 1
        ? "Every hour"
        : `Every ${cadence.interval_hours ?? 1} hours`;
    case "every_n_minutes":
      return `Every ${cadence.interval_minutes ?? 10} minutes`;
    case "once":
      return "Once";
    default:
      return "Scheduled";
  }
}
