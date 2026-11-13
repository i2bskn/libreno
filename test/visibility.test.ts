import { describe, expect, it } from "vitest";
import type { SpaceKind } from "../src/api/types";
import { widensVisibility } from "../src/spaces/visibility";

describe("widensVisibility", () => {
  // Two different spaces of each pair of kinds.
  it.each<[SpaceKind, SpaceKind, boolean]>([
    ["personal", "personal", false],
    ["personal", "admin", true],
    ["personal", "members", true],
    ["personal", "everyone", true],
    ["admin", "personal", false],
    ["admin", "admin", false],
    ["admin", "members", true],
    ["admin", "everyone", true],
    ["members", "personal", false],
    ["members", "admin", false],
    // The members of two members spaces may differ, and they are not compared.
    ["members", "members", true],
    ["members", "everyone", true],
    ["everyone", "personal", false],
    ["everyone", "admin", false],
    ["everyone", "members", false],
    ["everyone", "everyone", false],
  ])("from %s to %s is %s", (from, to, expected) => {
    expect(widensVisibility({ id: "from", kind: from }, { id: "to", kind: to })).toBe(expected);
  });

  it.each<SpaceKind>(["personal", "admin", "members", "everyone"])("within the same %s space is false", (kind) => {
    expect(widensVisibility({ id: "same", kind }, { id: "same", kind })).toBe(false);
  });
});
