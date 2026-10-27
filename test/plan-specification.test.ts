import { describe, expect, it, vi } from "vitest";
import type { ProviderContext } from "../spec/datasource.js";
import type { PlaceSearchRequest } from "../spec/place-search.js";
import type { Plan, Place, Restaurant } from "../spec/types.js";
import { mergeTurnConstraints } from "../src/conversation/memory.js";
import { evaluatePlanHardConstraints } from "../src/constraints/engine.js";
import { buildEffectivePlanCompletenessRequirements, evaluatePlanCompleteness } from "../src/constraints/plan-completeness.js";
import { parseIntent } from "../src/intent/parser.js";
import { ActivityPlanner } from "../src/planner/activity-planner.js";
import { buildActivityPlanTemplate, composePlanAssignments, resolvePlanSpecification } from "../src/planner/plan-composition.js";
import { AgentRun } from "../src/runtime/agent-run.js";
import { createAgentState } from "../spec/agent.js";
import { applyReplanPatch } from "../src/runtime/replanner.js";
import { GenerateFollowUpTool } from "../src/tools/followup.js";

vi.mock("../src/llm/followup.js", () => ({ generateFollowUpWithLLM: vi.fn(async () => []) }));
import { MockProvider } from "../src/data/providers/mock-provider.js";
import { createToolRegistry } from "../src/tools/registry.js";

class SearchRecorder extends MockProvider {
  readonly categories: string[][] = [];
  override async searchPlaces(request: PlaceSearchRequest, context?: ProviderContext) {
    this.categories.push([...(request.intent.categories ?? [])]);
    return super.searchPlaces(request, context);
  }
}

describe("typed PlanSpecification Phase C foundation", () => {
  it("parses only explicit structural intent and leaves vague pace/variety unguessed", () => {
    expect(parseIntent("逛两个景点，不吃饭").planSpecification).toEqual({ activityCount: 2, mealPolicy: "none" });
    expect(parseIntent("吃饭可有可无").planSpecification).toEqual({ mealPolicy: "optional" });
    expect(parseIntent("安排吃饭").planSpecification).toEqual({ mealPolicy: "required" });
    expect(parseIntent("只进行一个简单活动").planSpecification).toEqual({ activityCount: 1 });
    expect(parseIntent("多逛几个地方，不要太赶").planSpecification).toBeUndefined();
    expect(resolvePlanSpecification(undefined)).toEqual({ requested: {},
      activityCount: { value: 1, source: "domain_default" }, mealPolicy: { value: "required", source: "domain_default" } });
    expect(buildActivityPlanTemplate(resolvePlanSpecification(undefined))).toEqual({
      id: "activity-default", slots: [
        { slotId: "primary_activity", role: "activity", min: 1, max: 1 },
        { slotId: "rest", role: "rest", min: 0, max: 1 },
        { slotId: "meal", role: "meal", min: 1, max: 1 },
      ],
    });
  });

  it("retains structure across turns and allows explicit typed corrections", () => {
    let constraints = parseIntent("逛两个地方，不吃饭");
    constraints = mergeTurnConstraints(constraints, parseIntent("想看本地特色"), "想看本地特色");
    expect(constraints.planSpecification).toEqual({ activityCount: 2, mealPolicy: "none" });
    constraints = mergeTurnConstraints(constraints, parseIntent("一个地方就够，还是安排一顿饭吧"), "一个地方就够，还是安排一顿饭吧");
    expect(constraints.planSpecification).toEqual({ activityCount: 1, mealPolicy: "required" });
    expect(constraints.group.preferences.dietaryRestrictions).toEqual([]);
  });

  it("does not generate meal-dependent follow-up questions for none or optional meal", async () => {
    const tool = new GenerateFollowUpTool();
    const elderly = parseIntent("带老人出去玩");
    elderly.extraHints = ["展览"];
    elderly.group.preferences.budget = "medium";
    const none = { ...elderly, planSpecification: { mealPolicy: "none" as const } };
    const optional = { ...elderly, planSpecification: { mealPolicy: "optional" as const } };
    expect(await tool.run({ constraints: none })).toEqual([]);
    expect(await tool.run({ constraints: optional })).toEqual([]);
    expect((await tool.run({ constraints: { ...elderly, planSpecification: { mealPolicy: "required" } } }))
      .map(question => question.id)).toEqual(["elderly_dietary"]);
  });

  it("enforces explicit activity count as a user min and max, not the default template max", () => {
    const constraints = parseIntent("逛两个景点，不吃饭");
    const template = buildActivityPlanTemplate(resolvePlanSpecification(constraints.planSpecification));
    const requirements = buildEffectivePlanCompletenessRequirements(template, constraints);
    const activity = {
      id: "place", name: "公园", type: "attraction" as const, address: "北京", distanceKm: 1, rating: 4.5,
      crowdTags: [], localFeatures: [], location: { lat: 39.9, lng: 116.4, address: "北京", city: "北京" },
    };
    const build = (places: typeof activity[]): Plan => ({ id: "p", scenario: "family", leadRole: "friends_group",
      activities: places.map((place, index) => ({ order: index + 1, place: { ...place, id: `${place.id}-${index}` },
        scheduledStart: `1${index}:00`, scheduledEnd: `1${index + 1}:00`, status: "scheduled" })),
      totalDurationHours: 2, totalTransitMinutes: 0, feasibilityScore: 80, summary: "test" });
    expect(evaluatePlanCompleteness(build([activity, activity]), requirements).passed).toBe(true);
    expect(evaluatePlanCompleteness(build([activity]), requirements).passed).toBe(false);
    expect(evaluatePlanCompleteness(build([activity, activity, activity]), requirements).passed).toBe(false);

    const defaultConstraints = parseIntent("周末出去玩");
    const defaultReqs = buildEffectivePlanCompletenessRequirements(
      buildActivityPlanTemplate(resolvePlanSpecification(undefined)), defaultConstraints);
    expect(defaultReqs.requirements.find(requirement => requirement.role === "activity")?.maxCount).toBeUndefined();
  });

  it("keeps optional meal alternatives structural-valid and treats dietary requirements as not applicable without meal", () => {
    const constraints = parseIntent("吃饭可有可无");
    constraints.group.preferences.dietaryRestrictions = ["免海鲜"];
    constraints.group.preferences.preferredCuisine = ["日料"];
    const template = buildActivityPlanTemplate(resolvePlanSpecification(constraints.planSpecification));
    const activityPlace: Place = {
      id: "activity", name: "公园", type: "attraction", address: "北京", distanceKm: 1, rating: 4.5,
      crowdTags: [], localFeatures: [], location: { lat: 39.9, lng: 116.4, address: "北京", city: "北京" },
    };
    const mealPlace: Restaurant = {
      id: "meal", name: "日料店", type: "restaurant", address: "北京", distanceKm: 1, rating: 4.5,
      crowdTags: [], localFeatures: [], location: { lat: 39.9, lng: 116.4, address: "北京", city: "北京" },
      cuisine: "日料", tags: [], avgDurationMinutes: 60, hasQueue: false, queueCount: 0,
      dietaryOptions: true, supportedDietaryRestrictions: ["免海鲜"],
    };
    const pools = new Map<"activity" | "meal", readonly Place[]>([["activity", [activityPlace]], ["meal", [mealPlace]]]);
    const assignments = composePlanAssignments(template, pools, {
      enabledSlotIds: new Set(["primary_activity", "meal"]), requiredSlotIds: new Set(["primary_activity"]),
    });
    expect(assignments.map(assignment => assignment.find(slot => slot.role === "meal")?.places.length ?? 0).sort()).toEqual([0, 1]);

    const requirements = buildEffectivePlanCompletenessRequirements(template, constraints);
    const activityOnly: Plan = { id: "activity-only", scenario: "family", leadRole: "friends_group",
      activities: [{ order: 1, place: activityPlace, scheduledStart: "14:00", scheduledEnd: "16:00", status: "scheduled" }],
      totalDurationHours: 2, totalTransitMinutes: 0, feasibilityScore: 80, summary: "公园" };
    expect(evaluatePlanHardConstraints(activityOnly, constraints, requirements).passed).toBe(true);
    const withMeal: Plan = { ...activityOnly, id: "activity-with-meal", activities: [
      activityOnly.activities[0]!, { order: 2, place: mealPlace, scheduledStart: "16:00", scheduledEnd: "17:00", status: "scheduled" },
    ] };
    expect(evaluatePlanHardConstraints(withMeal, constraints, requirements).passed).toBe(true);
  });

  it("runs activity-only through the real Planner and never calls restaurant search", async () => {
    const rawText = "不吃饭，只逛一个地方，不能吃海鲜，喜欢日料";
    const provider = new SearchRecorder();
    const run = AgentRun.create({ rawText }, { runId: "plan_spec_activity_only" });
    const result = await new ActivityPlanner({ maxReplans: 0 }).run(run, {
      parseFn: parseIntent,
      toolRegistry: createToolRegistry({ dataProvider: provider }),
    });
    expect(result.success).toBe(true);
    expect(result.state.termination).toEqual({ reason: "plan_selected", code: "PLAN_SELECTED" });
    expect(provider.categories.some(categories => categories.includes("restaurant"))).toBe(false);
    expect(result.state.selectedPlan?.activities.some(activity => activity.place.type === "restaurant")).toBe(false);
    expect(result.state.selectedPlan?.activities.filter(activity => ["attraction", "walking"].includes(activity.place.type))).toHaveLength(1);
    expect(result.state.selectedPlan?.activities.every(activity => ["attraction", "walking", "break"].includes(activity.place.type))).toBe(true);
    expect(result.state.resolvedPlanSpecification).toMatchObject({ activityCount: { value: 1, source: "user" }, mealPolicy: { value: "none", source: "user" } });
    expect(result.state.planCompletenessRequirements?.requirements.find(requirement => requirement.role === "meal"))
      .toMatchObject({ minCount: 0, maxCount: 0, source: "user" });
    expect(result.state.selectedPlan?.explanation?.highlights.join(" ")).not.toMatch(/餐厅|菜系|饮食/);
    expect(result.state.constraints?.group.preferences.dietaryRestrictions).toContain("免海鲜");
    expect(result.state.constraints?.group.preferences.preferredCuisine).toContain("日料");
    expect(result.state.selectedPlan?.score?.dimensions.find(dimension => dimension.dimension === "preference")?.reason)
      .not.toMatch(/日料|菜系|未满足/);
    expect(evaluatePlanHardConstraints(result.state.selectedPlan!, result.state.constraints!, result.state.planCompletenessRequirements).passed).toBe(true);
    expect(run.state.decisionTrace?.planStructure?.templateId).toBe("activity-1-meal-none");
  });

  it("does not downgrade explicit multi-activity requests when route sequencing is unavailable", async () => {
    const constraints = parseIntent("逛两个景点，不吃饭");
    const result = await new ActivityPlanner({ maxReplans: 0 }).run(
      AgentRun.create({ rawText: "逛两个景点，不吃饭" }, { runId: "plan_spec_multi" }),
      { parseFn: () => constraints, toolRegistry: createToolRegistry({ dataProvider: new MockProvider() }) },
    );
    expect(result.success).toBe(false);
    expect(result.state.termination?.reason).toBe("no_feasible_plan");
    expect(result.state.planningNotes?.some(note => note.includes("MULTI_ACTIVITY_SEQUENCE_GAP"))).toBe(true);
  });

  it("never assigns the same semantic Place twice to two same-role slots", () => {
    const duplicate = { id: "same", name: "park", type: "attraction" as const, address: "北京", distanceKm: 1, rating: 4,
      crowdTags: [], localFeatures: [], location: { lat: 1, lng: 1, address: "北京", city: "北京" } };
    const template = { id: "two-activities", slots: [
      { slotId: "activity-1", role: "activity" as const, min: 1, max: 1 },
      { slotId: "activity-2", role: "activity" as const, min: 1, max: 1 },
    ] };
    expect(composePlanAssignments(template, new Map([["activity", [duplicate, { ...duplicate }]]] as const))).toEqual([]);
  });

  it("preserves resolved structure and acceptance requirements across a replan", () => {
    const constraints = parseIntent("逛两个景点，不吃饭");
    const state = createAgentState({ rawText: "逛两个景点，不吃饭" });
    const resolved = resolvePlanSpecification(constraints.planSpecification);
    const requirements = buildEffectivePlanCompletenessRequirements(buildActivityPlanTemplate(resolved), constraints);
    state.planning = { stage: "candidate_generation", constraints, resolvedPlanSpecification: resolved,
      planCompletenessRequirements: requirements, errors: [] };
    const replanned = applyReplanPatch(state, { searchRadiusKm: 20 });
    expect(replanned.planning.resolvedPlanSpecification).toEqual(resolved);
    expect(replanned.planning.planCompletenessRequirements).toEqual(requirements);
    expect(replanned.planning.constraints?.planSpecification).toEqual({ activityCount: 2, mealPolicy: "none" });
  });
});
