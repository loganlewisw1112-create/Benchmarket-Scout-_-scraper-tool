// Extends vitest's expect with @testing-library/jest-dom matchers
// (toBeInTheDocument, toBeDisabled, ...). Harmless no-op for node-env
// lib tests; component tests rely on it.
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// RTL's automatic cleanup needs a global afterEach, which vitest only
// provides with globals: true — register it explicitly instead so each
// test starts from an empty DOM. No-op for node-env lib tests.
afterEach(() => {
  cleanup();
});
