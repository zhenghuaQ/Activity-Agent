import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { mergeTurnConstraints } from "../src/conversation/memory.js";
import { ConversationStore } from "../src/conversation/store.js";
import { parseIntent } from "../src/intent/parser.js";
import { decisionFixture } from "./fixtures/decision.js";
import { SearchRestaurantsTool } from "../src/tools/restaurants.js";
import { HOME } from "../src/data/mock.js";

const temporaryFiles: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryFiles.splice(0).map((file) => fs.rm(file, { force: true })));
});

describe("conversation short-term memory", () => {
  it("只保留用户约束，不保留 Runtime 位置事实", () => {
    const first = parseIntent("这周末附近出去玩");
    const second = mergeTurnConstraints(first, parseIntent("想吃日料"), "想吃日料");
    expect(second.distance).toEqual({ preferredMaxKm: 15 });
    expect(second).not.toHaveProperty("homeLocation");
    expect(JSON.stringify(second)).not.toContain("望京");
  });

  it("retains earlier constraints and applies later corrections", () => {
    let memory = parseIntent("我这周末想去上海玩，帮我制定一个计划");
    memory = mergeTurnConstraints(memory, parseIntent("我选美食约会"), "我选美食约会");
    memory = mergeTurnConstraints(memory, parseIntent("哦对，我带我女朋友去，她喜欢日料"), "哦对，我带我女朋友去，她喜欢日料");
    memory = mergeTurnConstraints(memory, parseIntent("预算人均280左右，而且不要太赶"), "预算人均280左右，而且不要太赶");

    expect(memory.destination?.city).toBe("上海");
    expect(memory.group.leadRole).toBe("partner");
    expect(memory.group.preferences.budget).toBe("medium");
    expect(memory.group.preferences.preferredCuisine).toEqual(["日料"]);
    expect(memory.extraHints).toEqual(expect.arrayContaining(["美食", "浪漫", "休闲慢游", "少赶路"]));

    memory = mergeTurnConstraints(memory, parseIntent("不想吃日料了，改吃火锅"), "不想吃日料了，改吃火锅");
    expect(memory.group.preferences.preferredCuisine).toEqual(["火锅"]);
    expect(memory.destination?.city).toBe("上海");
  });

  it("persists a conversation and the accepted candidate across store instances", async () => {
    const file = path.join(tmpdir(), `activity-agent-conversation-${randomUUID()}.json`);
    temporaryFiles.push(file);
    const id = `conversation_${randomUUID()}`;
    const constraints = parseIntent("和女朋友周末约会，想吃日料");
    const fixture = decisionFixture();
    const firstStore = new ConversationStore(file);

    await firstStore.getOrCreate(id, "周末约会");
    await firstStore.appendTurn(id, "user", "text", "和女朋友周末约会，想吃日料");
    await firstStore.completePlan(id, "run_1", constraints, fixture.decision!, fixture.selectedPlan!, "已生成两个方案");
    await firstStore.confirmPlan(id, 1, fixture.decision!.pareto[1].plan.id);

    const restored = await new ConversationStore(file).get(id);
    expect(restored?.memory.constraints?.group.preferences.preferredCuisine).toEqual(["日料"]);
    expect(restored?.memory.acceptedPlanVersion).toBe(1);
    expect(restored?.plans[0].selectedPlan.id).toBe("b");
    expect(restored?.turns.map((turn) => turn.kind)).toEqual(["text", "plan", "choice"]);
  });

  it("checkpoints parsed constraints before a final plan exists", async () => {
    const file = path.join(tmpdir(), `activity-agent-conversation-${randomUUID()}.json`);
    temporaryFiles.push(file);
    const id = `conversation_${randomUUID()}`;
    const store = new ConversationStore(file);
    await store.getOrCreate(id, "上海周末游");
    await store.checkpointConstraints(id, parseIntent("这周末去上海玩"));

    const restored = await new ConversationStore(file).get(id);
    expect(restored?.plans).toHaveLength(0);
    expect(restored?.memory.constraints?.destination?.city).toBe("上海");
    expect(restored?.memory.revision).toBe(1);
  });

  it("ranks a remembered cuisine first without treating preference as a hard filter", async () => {
    const constraints = parseIntent("和女朋友约会，想吃火锅");
    const restaurants = await new SearchRestaurantsTool().run({ group: constraints.group,
      timeWindow: constraints.timeWindow, distance: constraints.distance,
      origin: HOME,
      preferredCuisine: constraints.group.preferences.preferredCuisine });
    expect(restaurants[0].cuisine).toContain("火锅");

    const unavailable = await new SearchRestaurantsTool().run({ group: constraints.group,
      timeWindow: constraints.timeWindow, distance: constraints.distance, origin: HOME, preferredCuisine: ["日料"] });
    expect(unavailable.length).toBeGreaterThan(0);
  });
});
