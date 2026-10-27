import type { CrowdTag, Plan, StructuredConstraints } from "../../spec/types.js";

export interface GroupSuitabilityResult {
  applicable: boolean;
  score?: number;
  matched: number;
  total: number;
  evidence: string[];
}

interface Signal {
  name: string;
  acceptedTags: CrowdTag[];
}

/** Convert only explicit, non-default group context to signals supported by the current Place schema. */
function getSignals(constraints: StructuredConstraints): Signal[] {
  const { group } = constraints;
  const { ageGroup, leadRole, scenario } = group;
  const signals: Signal[] = [];

  // Parser defaults are family + friends_group + adults. That combination alone
  // is not evidence that the user specified a group context.
  if (scenario === "friends") signals.push({ name: "friends", acceptedTags: ["friends"] });
  if (scenario === "couple") signals.push({ name: "couple", acceptedTags: ["couple"] });
  if (scenario === "solo") signals.push({ name: "solo", acceptedTags: ["solo"] });

  if (scenario === "family" || leadRole === "kids" || leadRole === "elderly" || leadRole === "mixed_family") {
    if (leadRole === "kids") signals.push({ name: "family_kids", acceptedTags: ["family_kids"] });
    if (leadRole === "elderly") signals.push({ name: "family_elderly", acceptedTags: ["family_elderly"] });
    if (leadRole === "mixed_family") signals.push({ name: "family_mixed", acceptedTags: ["family_mixed"] });
  }

  if (ageGroup.youngChildren > 0) signals.push({ name: "kids", acceptedTags: ["kids", "family_kids"] });
  if (ageGroup.teens > 0) signals.push({ name: "teens", acceptedTags: ["teens"] });
  if (ageGroup.seniors > 0) signals.push({ name: "seniors", acceptedTags: ["seniors", "family_elderly", "family_mixed"] });

  const unique = new Map(signals.map(signal => [signal.name, signal]));
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Plan-level soft group suitability based solely on structured Place.crowdTags.
 * Each active signal measures the share of visited places carrying explicit
 * matching evidence; unknown places receive no reward but remain feasible.
 */
export function evaluatePlanGroupSuitability(
  plan: Plan,
  constraints: StructuredConstraints,
): GroupSuitabilityResult {
  const signals = getSignals(constraints);
  if (signals.length === 0) return { applicable: false, matched: 0, total: 0, evidence: [] };

  const places = plan.activities.map(activity => activity.place);
  if (places.length === 0) {
    return { applicable: true, score: 0, matched: 0, total: signals.length, evidence: [] };
  }

  const signalScores = signals.map(signal => {
    const matchedPlaces = places.filter(place => signal.acceptedTags.some(tag => place.crowdTags.includes(tag)));
    return { signal: signal.name, matchedPlaces: matchedPlaces.length, totalPlaces: places.length };
  });
  const score = signalScores.reduce((sum, item) => sum + item.matchedPlaces / item.totalPlaces, 0) / signals.length;
  const matched = signalScores.filter(item => item.matchedPlaces > 0).length;
  const evidence = signalScores.map(item => `${item.signal}:${item.matchedPlaces}/${item.totalPlaces}`);
  return { applicable: true, score, matched, total: signals.length, evidence };
}
