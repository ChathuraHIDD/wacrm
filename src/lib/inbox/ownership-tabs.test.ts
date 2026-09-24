import { describe, expect, it } from "vitest";

import {
  countByOwnershipTab,
  defaultOwnershipTab,
  matchesOwnershipTab,
  ownershipTabsFor,
} from "./ownership-tabs";

const ME = "me";
const threads = [
  { assigned_agent_id: null },
  { assigned_agent_id: undefined },
  { assigned_agent_id: ME },
  { assigned_agent_id: "gina" },
  { assigned_agent_id: "hank" },
];

describe("ownershipTabsFor", () => {
  it("gives agents and viewers Unassigned / Mine / Team", () => {
    expect(ownershipTabsFor("agent")).toEqual(["unassigned", "mine", "team"]);
    expect(ownershipTabsFor("viewer")).toEqual(["unassigned", "mine", "team"]);
  });

  it("gives admins All instead of Mine (they never own customers)", () => {
    expect(ownershipTabsFor("admin")).toEqual(["all", "unassigned", "team"]);
    expect(ownershipTabsFor("owner")).toEqual(["all", "unassigned", "team"]);
  });

  it("opens agents on Mine and admins on All", () => {
    expect(defaultOwnershipTab("agent")).toBe("mine");
    expect(defaultOwnershipTab("admin")).toBe("all");
    expect(defaultOwnershipTab(null)).toBe("unassigned");
  });
});

describe("matchesOwnershipTab", () => {
  it("sorts threads into Unassigned / Mine / Team", () => {
    expect(countByOwnershipTab(threads, ME)).toEqual({ unassigned: 2, mine: 1, team: 2, all: 5 });
  });

  it("narrows to one agent with the admin filter", () => {
    expect(countByOwnershipTab(threads, "admin-1", "gina")).toEqual({
      unassigned: 0,
      mine: 0,
      team: 1,
      all: 1,
    });
    expect(matchesOwnershipTab({ assigned_agent_id: "hank" }, "all", "admin-1", "gina")).toBe(false);
  });

  it("puts nothing in Mine for a signed-out / unknown user", () => {
    expect(matchesOwnershipTab({ assigned_agent_id: null }, "mine", null)).toBe(false);
  });
});
