// ============================================================
// src/tools/location.ts — Tool 0: get_user_location
//
// 经定位服务解析出发点。默认策略由注入的 LocationResolver 提供；
// 接入前端后可由浏览器 Geolocation 上报经纬度、或手输地址走地理编码。
// ============================================================

import type { LocationRequest } from "../../spec/location.js";
import type * as T from "../../spec/tools.js";
import type { ToolOutput } from "../../spec/tool-response.js";
import { GET_USER_LOCATION_TOOL } from "../../spec/tools.js";
import { BaseTool, err, ok } from "./base.js";
import type { LocationResolver } from "../../spec/location.js";
import { createDefaultLocationResolver } from "../location/service.js";

class InvalidLocationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLocationInputError";
  }
}

function invalid(message: string): never {
  throw new InvalidLocationInputError(message);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateCoords(input: T.GetUserLocationInput): LocationRequest {
  if (!finiteNumber(input.lat)) invalid("coords.lat 必须是 finite number");
  if (!finiteNumber(input.lng)) invalid("coords.lng 必须是 finite number");
  if (input.lat < -90 || input.lat > 90) invalid("coords.lat 必须位于 [-90, 90]");
  if (input.lng < -180 || input.lng > 180) invalid("coords.lng 必须位于 [-180, 180]");
  if (input.address !== undefined && typeof input.address !== "string") {
    invalid("coords.address 必须是字符串");
  }
  if (input.city !== undefined && typeof input.city !== "string") {
    invalid("coords.city 必须是字符串");
  }
  return {
    kind: "coords",
    lat: input.lat,
    lng: input.lng,
    ...(input.address !== undefined ? { address: input.address } : {}),
    ...(input.city !== undefined ? { city: input.city } : {}),
  };
}

function validateAddress(input: T.GetUserLocationInput): LocationRequest {
  if (typeof input.address !== "string" || input.address.trim().length === 0) {
    invalid("address 必须是非空字符串");
  }
  if (input.city !== undefined && typeof input.city !== "string") {
    invalid("address.city 必须是字符串");
  }
  return {
    kind: "address",
    address: input.address.trim(),
    ...(input.city !== undefined ? { city: input.city } : {}),
  };
}

/** 将 Tool 层扁平 DTO 规范化为 Location Service 的正式请求。 */
export function normalizeLocationRequest(input: T.GetUserLocationInput = {}): LocationRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    invalid("定位输入必须是对象");
  }

  switch (input.kind) {
    case "coords":
      return validateCoords(input);
    case "address":
      return validateAddress(input);
    case "ip":
      if (input.ip !== undefined && typeof input.ip !== "string") {
        invalid("ip 必须是字符串");
      }
      return { kind: "ip", ...(input.ip !== undefined ? { ip: input.ip } : {}) };
    case "default":
      return { kind: "default" };
    case undefined:
      break;
    default:
      invalid("kind 必须是 coords、address、ip 或 default");
  }

  const hasLat = input.lat !== undefined;
  const hasLng = input.lng !== undefined;
  const hasAddress = input.address !== undefined;
  const hasIp = input.ip !== undefined;
  const inferredModes = [hasLat || hasLng, hasAddress, hasIp].filter(Boolean).length;

  if (inferredModes === 0) return { kind: "default" };
  if (inferredModes > 1) invalid("未指定 kind 时只能提供一种定位输入");
  if (hasLat || hasLng) return validateCoords(input);
  if (hasAddress) return validateAddress(input);
  if (hasIp) {
    if (typeof input.ip !== "string") invalid("ip 必须是字符串");
    return { kind: "ip", ip: input.ip };
  }
  return { kind: "default" };
}

export class GetUserLocationTool extends BaseTool<
  T.GetUserLocationInput,
  T.GetUserLocationOutput
> {
  constructor(private readonly resolver: LocationResolver = createDefaultLocationResolver()) {
    super();
  }

  name = "get_user_location";
  description = GET_USER_LOCATION_TOOL.description;
  inputSchema = GET_USER_LOCATION_TOOL.inputSchema;

  protected async run(input: T.GetUserLocationInput): Promise<T.GetUserLocationOutput | ToolOutput<T.GetUserLocationOutput>> {
    let request: LocationRequest;
    try {
      request = normalizeLocationRequest(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err("E_PARAM_INVALID", message);
    }
    const resolved = await this.resolver.resolve(request);
    return ok(
      `定位解析完成（来源：${resolved.source}）`,
      resolved,
    );
  }
}
