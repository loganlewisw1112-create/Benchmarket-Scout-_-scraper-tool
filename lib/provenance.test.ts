import { describe, expect, it } from "vitest";
import { dedupeSourceIds, ProvenanceRegistry } from "./provenance";

describe("ProvenanceRegistry", () => {
  it("assigns stable sequential IDs and emits the exact real-only envelope", () => {
    const registry = new ProvenanceRegistry("2026-07-19T10:00:00.000Z");
    const inputId = registry.add({
      kind: "user_input",
      provider: "User submission",
      title: "Analysis request",
      businessName: "Acme",
      status: "used",
    });
    const homepageId = registry.add({
      kind: "homepage",
      provider: "Public business website",
      title: "Acme homepage",
      url: "https://EXAMPLE.com/path/#section",
      businessName: "Acme",
      status: "used",
    });

    expect(inputId).toBe("S1");
    expect(homepageId).toBe("S2");
    expect(registry.build()).toEqual({
      policy: "real-only",
      containsSyntheticData: false,
      sources: [
        {
          id: "S1",
          kind: "user_input",
          provider: "User submission",
          title: "Analysis request",
          businessName: "Acme",
          accessedAt: "2026-07-19T10:00:00.000Z",
          status: "used",
        },
        {
          id: "S2",
          kind: "homepage",
          provider: "Public business website",
          title: "Acme homepage",
          url: "https://EXAMPLE.com/path/#section",
          businessName: "Acme",
          accessedAt: "2026-07-19T10:00:00.000Z",
          status: "used",
        },
      ],
    });
  });

  it("deduplicates canonical URLs even when labels differ and supports status updates", () => {
    const registry = new ProvenanceRegistry("2026-07-19T10:00:00.000Z");
    const first = registry.add({
      kind: "homepage",
      provider: "Website",
      title: "Home",
      url: "https://example.com/about/",
      status: "used",
    });
    const duplicate = registry.add({
      kind: "linked_page",
      provider: "Website",
      title: "About",
      url: "https://EXAMPLE.com/about#team",
      status: "used",
    });
    registry.update(first, { status: "limited" });

    expect(duplicate).toBe(first);
    expect(registry.build().sources).toHaveLength(1);
    expect(registry.build().sources[0].status).toBe("limited");
  });

  it("deduplicates record source ID lists without reordering them", () => {
    expect(dedupeSourceIds(["S2", "S1", "S2", "S3", "S1"])).toEqual([
      "S2",
      "S1",
      "S3",
    ]);
  });
});
