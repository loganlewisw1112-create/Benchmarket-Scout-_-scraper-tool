import { afterEach, describe, expect, it } from "vitest";
import { isMaintenanceMode, MAINTENANCE_RESPONSE } from "./maintenance";

const originalValue = process.env.MAINTENANCE_MODE;

afterEach(() => {
  if (originalValue === undefined) delete process.env.MAINTENANCE_MODE;
  else process.env.MAINTENANCE_MODE = originalValue;
});

describe("maintenance mode", () => {
  it("only activates for an explicit true value", () => {
    process.env.MAINTENANCE_MODE = " true ";
    expect(isMaintenanceMode()).toBe(true);

    process.env.MAINTENANCE_MODE = "false";
    expect(isMaintenanceMode()).toBe(false);

    delete process.env.MAINTENANCE_MODE;
    expect(isMaintenanceMode()).toBe(false);
  });

  it("uses a stable machine-readable error code", () => {
    expect(MAINTENANCE_RESPONSE.code).toBe("MAINTENANCE");
  });
});

