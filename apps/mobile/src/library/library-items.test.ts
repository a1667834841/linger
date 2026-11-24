import { describe, expect, it } from "vitest";

import {
  dayHeading,
  documentFileName,
  documentTitle,
  groupByDay,
  shortWhen,
} from "./library-items";

const now = new Date(2026, 10, 23, 15, 0);

describe("shortWhen", () => {
  it("reads like a phone list", () => {
    const today = new Date(2026, 10, 23, 9, 5);
    expect(shortWhen(today.toISOString(), now)).toBe(
      today.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }),
    );
    expect(shortWhen(new Date(2026, 10, 22, 23).toISOString(), now)).toBe(
      "Yesterday",
    );
    const monday = new Date(2026, 10, 17, 12);
    expect(shortWhen(monday.toISOString(), now)).toBe(
      monday.toLocaleDateString(undefined, { weekday: "short" }),
    );
    const older = new Date(2025, 2, 3, 12);
    expect(shortWhen(older.toISOString(), now)).toBe(
      older.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
    );
    expect(shortWhen(undefined, now)).toBe("");
    expect(shortWhen("not a date", now)).toBe("");
  });

  it("treats a bare date as a local day", () => {
    expect(shortWhen("2026-11-22", now)).toBe("Yesterday");
  });
});

describe("groupByDay", () => {
  it("puts each day under one heading in first-seen order", () => {
    const items = [
      new Date(2026, 10, 23, 10).toISOString(),
      new Date(2026, 10, 22, 18).toISOString(),
      new Date(2026, 10, 23, 8).toISOString(),
    ];
    const groups = groupByDay(items, (item) => item, now);
    expect(groups.map((group) => [group.title, group.data.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
    ]);
    expect(dayHeading(undefined, now)).toBe("Earlier");
  });
});

describe("document names", () => {
  const base = { format: "pdf", representation_format: "pdf" };
  it("keeps a file's own name and gives a native Document its format", () => {
    expect(
      documentFileName({
        ...base,
        title: "Report.pdf",
        draft_capability: "none",
      }),
    ).toBe("Report.pdf");
    expect(
      documentFileName({ ...base, title: "Report", draft_capability: "none" }),
    ).toBe("Report.pdf");
    const native = {
      format: "blocknote",
      representation_format: "markdown",
      title: "Plan.md",
      draft_capability: "write" as const,
    };
    expect(documentTitle(native)).toBe("Plan");
    expect(documentFileName(native)).toBe("Plan.md");
  });
});
