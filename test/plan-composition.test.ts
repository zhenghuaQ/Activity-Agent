import { describe, expect, it } from "vitest";
import { createBeijingFixture } from "../eval/decision/scenarios/fixtures/beijing.js";
import {
  ACTIVITY_PLAN_TEMPLATE,
  composePlanAssignments,
  getAssignedPlaces,
  searchRoleToPlanSlotRole,
  type PlanTemplate,
} from "../src/planner/plan-composition.js";
import type { Place } from "../spec/types.js";

const fixture = createBeijingFixture();
const activity = (id: string): Place => ({ ...structuredClone(fixture.attractions[0]!), id });
const meal = (id: string): Place => ({ ...structuredClone(fixture.restaurants[0]!), id });
const rest = (id: string): Place => ({ ...structuredClone(fixture.breakPlaces[0]!), id });
const ids = (assignments: ReturnType<typeof composePlanAssignments>) => assignments.map(assignment =>
  assignment.map(slot => [slot.slotId, slot.places.map(place => place.id)]));

describe("slot-driven plan composition", () => {
  it("declares current activity, optional rest, and meal slots in legacy timeline order", () => {
    expect(ACTIVITY_PLAN_TEMPLATE.slots).toEqual([
      { slotId: "primary_activity", role: "activity", min: 1, max: 1 },
      { slotId: "rest", role: "rest", min: 0, max: 1 },
      { slotId: "meal", role: "meal", min: 1, max: 1 },
    ]);
  });

  it("maps Search task role vocabulary to semantic Plan slot roles", () => {
    expect(searchRoleToPlanSlotRole("primary_activity")).toBe("activity");
    expect(searchRoleToPlanSlotRole("meal")).toBe("meal");
    expect(searchRoleToPlanSlotRole("rest")).toBe("rest");
    expect(searchRoleToPlanSlotRole("museum")).toBeUndefined();
  });

  it("enumerates optional slot with and without its candidates", () => {
    const pools = new Map([["activity", [activity("a")]], ["meal", [meal("m")]], ["rest", [rest("r")]]] as const);
    const withRest = composePlanAssignments(ACTIVITY_PLAN_TEMPLATE, pools);
    expect(withRest).toHaveLength(2);
    expect(withRest.map(assignment => assignment.find(slot => slot.role === "rest")?.places.length ?? 0)).toEqual([0, 1]);

    const withoutRest = composePlanAssignments(ACTIVITY_PLAN_TEMPLATE,
      new Map([["activity", [activity("a")]], ["meal", [meal("m")]]] as const));
    expect(withoutRest).toHaveLength(1);
    expect(withoutRest[0]?.flatMap(slot => slot.places.map(place => place.id))).toEqual(["a", "m"]);
  });

  it("returns no complete assignment when any required pool is empty", () => {
    expect(composePlanAssignments(ACTIVITY_PLAN_TEMPLATE,
      new Map([["activity", [activity("a")]], ["meal", []]] as const))).toEqual([]);
  });

  it("is stable under candidate pool permutation and uses canonical Place IDs", () => {
    const first = new Map([["activity", [activity("b"), activity("a")]], ["meal", [meal("y"), meal("x")]]] as const);
    const reversed = new Map([["activity", [activity("a"), activity("b")]], ["meal", [meal("x"), meal("y")]]] as const);
    const options = { enabledSlotIds: new Set(["primary_activity", "meal"]), requiredSlotIds: new Set(["primary_activity", "meal"]) };
    expect(ids(composePlanAssignments(ACTIVITY_PLAN_TEMPLATE, first, options)))
      .toEqual(ids(composePlanAssignments(ACTIVITY_PLAN_TEMPLATE, reversed, options)));
    expect(ids(composePlanAssignments(ACTIVITY_PLAN_TEMPLATE, first, options))).toEqual([
      [["primary_activity", ["a"]], ["meal", ["x"]]],
      [["primary_activity", ["a"]], ["meal", ["y"]]],
      [["primary_activity", ["b"]], ["meal", ["x"]]],
      [["primary_activity", ["b"]], ["meal", ["y"]]],
    ]);
  });

  it("supports a non-default template with two same-role activity slots", () => {
    const custom: PlanTemplate = { id: "two-activities", slots: [
      { slotId: "activity_1", role: "activity", min: 1, max: 1 },
      { slotId: "activity_2", role: "activity", min: 1, max: 1 },
      { slotId: "meal", role: "meal", min: 1, max: 1 },
    ] };
    const assignments = composePlanAssignments(custom,
      new Map([["activity", [activity("b"), activity("a")]], ["meal", [meal("m")]]] as const));
    expect(assignments).toHaveLength(2);
    expect(ids(assignments)).toEqual([
      [["activity_1", ["a"]], ["activity_2", ["b"]], ["meal", ["m"]]],
      [["activity_1", ["b"]], ["activity_2", ["a"]], ["meal", ["m"]]],
    ]);
    expect(getAssignedPlaces(assignments[0]!)).toEqual([activity("a"), activity("b"), meal("m")]);
  });

  it("honors a 2..2 slot cardinality by assigning two distinct candidates", () => {
    const doubleActivity: PlanTemplate = { id: "double-activity", slots: [
      { slotId: "activity_pair", role: "activity", min: 2, max: 2 },
      { slotId: "meal", role: "meal", min: 1, max: 1 },
    ] };
    const assignments = composePlanAssignments(doubleActivity,
      new Map([["activity", [activity("c"), activity("a"), activity("b")]], ["meal", [meal("m")]]] as const));
    expect(assignments).toHaveLength(3);
    expect(assignments.map(assignment => assignment[0]?.places.map(place => place.id))).toEqual([
      ["a", "b"], ["a", "c"], ["b", "c"],
    ]);
  });

  it("does not inspect quality or hard-constraint fields", () => {
    const impossibleByDistance = { ...activity("far"), distanceKm: 999, rating: 1 };
    const assignments = composePlanAssignments(ACTIVITY_PLAN_TEMPLATE,
      new Map([["activity", [impossibleByDistance]], ["meal", [meal("m")]]] as const),
      { enabledSlotIds: new Set(["primary_activity", "meal"]), requiredSlotIds: new Set(["primary_activity", "meal"]) });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.[0]?.places[0]?.id).toBe("far");
  });

  it("matches the legacy default-template candidate identity set", () => {
    const activityPool = [activity("a2"), activity("a1")];
    const mealPool = [meal("m2"), meal("m1")];
    const restPool = [rest("r1")];
    const legacy = activityPool.flatMap(a => mealPool.map(m => [a.id, m.id]));
    const assignment = composePlanAssignments(ACTIVITY_PLAN_TEMPLATE,
      new Map([["activity", activityPool], ["meal", mealPool], ["rest", restPool]] as const),
      { enabledSlotIds: new Set(["primary_activity", "meal"]), requiredSlotIds: new Set(["primary_activity", "meal"]) });
    const actual = assignment.map(value => [
      value.find(slot => slot.role === "activity")!.places[0]!.id,
      value.find(slot => slot.role === "meal")!.places[0]!.id,
    ]);
    expect(new Set(actual.map(value => JSON.stringify(value)))).toEqual(new Set(legacy.map(value => JSON.stringify(value))));
  });
});
