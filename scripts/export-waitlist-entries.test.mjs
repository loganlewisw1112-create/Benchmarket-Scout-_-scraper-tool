import { describe, expect, it } from "vitest";
import {
  csvEscape,
  mergeWaitlistEntriesByEmail,
} from "./export-waitlist-entries.mjs";

describe("mergeWaitlistEntriesByEmail", () => {
  it("keeps the earliest signup context and aggregates later feedback", () => {
    const entries = [
      {
        email: "Person@Example.com",
        at: "2026-07-19T08:00:00.000Z",
        source: "landing",
        reportId: "first-report",
        campaign: "launch",
        message: "  First thought  ",
      },
      {
        email: "person@example.com",
        at: "2026-07-19T09:00:00.000Z",
        source: "feedback",
        reportId: "later-report",
        campaign: "replacement-must-not-win",
        message: "Second thought",
      },
    ];

    expect(mergeWaitlistEntriesByEmail(entries)).toEqual([
      {
        email: "Person@Example.com",
        at: "2026-07-19T08:00:00.000Z",
        source: "landing",
        reportId: "first-report",
        campaign: "launch",
        message:
          '[feedback {"at":"2026-07-19T08:00:00.000Z","source":"landing","reportId":"first-report"}]\n' +
          "First thought\n\n" +
          '[feedback {"at":"2026-07-19T09:00:00.000Z","source":"feedback","reportId":"later-report"}]\n' +
          "Second thought",
      },
    ]);
  });

  it("keeps all non-empty messages in event order and one row per normalized email", () => {
    const entries = [
      {
        email: "first@example.com",
        at: "2026-07-19T08:00:00.000Z",
        message: "same feedback",
      },
      {
        email: " FIRST@example.com ",
        at: "2026-07-19T09:00:00.000Z",
        message: "   ",
      },
      {
        email: "other@example.com",
        at: "2026-07-19T09:30:00.000Z",
      },
      {
        email: "first@example.com",
        at: "2026-07-19T10:00:00.000Z",
        message: "same feedback",
      },
    ];

    expect(mergeWaitlistEntriesByEmail(entries)).toEqual([
      {
        email: "first@example.com",
        at: "2026-07-19T08:00:00.000Z",
        message:
          '[feedback {"at":"2026-07-19T08:00:00.000Z","source":null,"reportId":null}]\n' +
          "same feedback\n\n" +
          '[feedback {"at":"2026-07-19T10:00:00.000Z","source":null,"reportId":null}]\n' +
          "same feedback",
      },
      {
        email: "other@example.com",
        at: "2026-07-19T09:30:00.000Z",
      },
    ]);
  });
});

describe("csvEscape", () => {
  it.each([
    ["=1+1", "'=1+1"],
    ["  +SUM(A1:A2)", "'  +SUM(A1:A2)"],
    ["\t@command", "'\t@command"],
    [" \t-10", "' \t-10"],
    ["\r=command", '"\'\r=command"'],
  ])("neutralizes spreadsheet formula vector %j", (input, expected) => {
    expect(csvEscape(input)).toBe(expected);
  });

  it("leaves safe values intact and still applies normal CSV quoting", () => {
    expect(csvEscape("ordinary text")).toBe("ordinary text");
    expect(csvEscape("text,with comma")).toBe('"text,with comma"');
    expect(csvEscape('text "with quote"')).toBe('"text ""with quote"""');
  });
});
