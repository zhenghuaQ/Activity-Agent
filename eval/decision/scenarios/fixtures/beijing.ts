import { ATTRACTIONS, BREAK_PLACES, HOME, RESTAURANTS } from "../../../../src/data/mock.js";
import { buildFixtureData } from "./shared.js";

export const BEIJING_CENTER = { ...HOME, address: "北京 Decision Fixture 中心", city: "北京" };

export function createBeijingFixture(label = "Beijing Fixture"): ReturnType<typeof buildFixtureData> {
  return buildFixtureData(label, BEIJING_CENTER, ATTRACTIONS, RESTAURANTS, BREAK_PLACES);
}
