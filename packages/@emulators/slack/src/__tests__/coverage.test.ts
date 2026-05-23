import { describe, expect, it } from "vitest";
import { slackCoverageMatrix } from "./slack-coverage.js";

describe("Slack coverage matrix", () => {
  it("has unique method entries", () => {
    const methods = slackCoverageMatrix.map((entry) => entry.method);
    expect(new Set(methods).size).toBe(methods.length);
  });

  it("maps every current endpoint to at least one test file", () => {
    const currentEntries = slackCoverageMatrix.filter((entry) => entry.status !== "not_started");
    expect(currentEntries.length).toBeGreaterThan(0);

    for (const entry of currentEntries) {
      expect(entry.route).toMatch(/^(GET|POST) /);
      expect(entry.testedBy.length, entry.method).toBeGreaterThan(0);
    }
  });

  it("keeps planned gaps explicit", () => {
    const planned = slackCoverageMatrix.filter((entry) => entry.status === "not_started");
    expect(planned.map((entry) => entry.method)).toEqual(
      expect.arrayContaining(["chat.postEphemeral", "files.getUploadURLExternal", "views.publish"]),
    );
    for (const entry of planned) {
      expect(entry.notes).toMatch(/Planned|future/i);
    }
  });
});
