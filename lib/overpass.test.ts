import { afterEach, describe, expect, it, vi } from "vitest";
import { OSM_CATEGORY_MAP, queryOverpass, resolveOsmTags } from "./overpass";

function response(body: string, ok = true, status = 200) {
  return { ok, status, text: async () => body } as Response;
}

describe("queryOverpass", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns elements from the first endpoint on success", async () => {
    const elements = [{ type: "node", id: 1, tags: { name: "Test" } }];
    const fetchMock = vi.fn().mockResolvedValue(response(JSON.stringify({ elements })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await queryOverpass("dentist", 30, -97);

    expect(result).toEqual(elements);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://overpass-api.de/api/interpreter");
  });

  it("fails over to the second endpoint after the first is exhausted", async () => {
    const elements = [{ type: "node", id: 2, tags: { name: "Second" } }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response("", false, 504))
      .mockResolvedValueOnce(response("", false, 504))
      .mockResolvedValue(response(JSON.stringify({ elements })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await queryOverpass("dentist", 30, -97);

    expect(result).toEqual(elements);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toBe("https://overpass.kumi.systems/api/interpreter");
  }, 5000);

  it("throws after exhausting all endpoints and attempts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response("", false, 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryOverpass("dentist", 30, -97)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(6); // 3 endpoints x 2 attempts
  }, 8000);

  it("treats a non-JSON response as a failure and retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response("not json"))
      .mockResolvedValue(response(JSON.stringify({ elements: [] })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await queryOverpass("dentist", 30, -97);
    expect(result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 3000);
});

describe("resolveOsmTags", () => {
  it("maps known business types to OSM tag pairs", () => {
    expect(resolveOsmTags("plumber")).toEqual(OSM_CATEGORY_MAP.plumber);
    expect(resolveOsmTags("Dentist")).toEqual(OSM_CATEGORY_MAP.dentist);
  });

  it("falls back to generic shop/office tags for unknown types", () => {
    expect(resolveOsmTags("underwater basket weaving")).toEqual([
      ["shop", "yes"],
      ["office", "yes"],
    ]);
  });
});
