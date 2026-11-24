import { describe, expect, it } from "vitest";

import { describeCadence } from "./routine-cadence";

describe("describeCadence", () => {
  it("reads each schedule kind in a few words", () => {
    expect(
      describeCadence({ kind: "daily", timezone: "UTC", hour: 9, minute: 0 }),
    ).toBe("Daily at 09:00");
    expect(
      describeCadence({
        kind: "weekly",
        timezone: "UTC",
        hour: 18,
        minute: 30,
        weekdays: ["monday", "wednesday"],
      }),
    ).toBe("Mon, Wed at 18:30");
    expect(
      describeCadence({
        kind: "every_n_hours",
        timezone: "UTC",
        interval_hours: 2,
      }),
    ).toBe("Every 2 hours");
    expect(
      describeCadence({
        kind: "every_n_minutes",
        timezone: "UTC",
        interval_minutes: 30,
      }),
    ).toBe("Every 30 minutes");
    expect(describeCadence(undefined)).toBe("When something happens");
  });
});
