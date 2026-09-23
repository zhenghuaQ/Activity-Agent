import { ATTRACTIONS, BREAK_PLACES, RESTAURANTS } from "../../../../src/data/mock.js";
import { buildFixtureData } from "./shared.js";

export const SHANGHAI_CENTER = {
  lat: 31.2304,
  lng: 121.4737,
  address: "上海 Decision Fixture 中心",
  city: "上海",
  district: "黄浦区",
};

export function createShanghaiFixture(label = "Shanghai Fixture"): ReturnType<typeof buildFixtureData> {
  return buildFixtureData(label, SHANGHAI_CENTER, ATTRACTIONS, RESTAURANTS, BREAK_PLACES);
}
