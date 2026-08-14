// ============================================================
// src/tools/location.ts — Tool 0: get_user_location
//
// 经定位服务解析出发点。默认零配置回落 HOME；接入前端后可由
// 浏览器 Geolocation 上报经纬度、或手输地址走高德地理编码。
// ============================================================

import type { GeoLocation } from "../../spec/types.js";
import type * as T from "../../spec/tools.js";
import { GET_USER_LOCATION_TOOL } from "../../spec/tools.js";
import { BaseTool } from "./base.js";
import { resolveLocation } from "../location/service.js";

export class GetUserLocationTool extends BaseTool<
  T.GetUserLocationInput,
  T.GetUserLocationOutput
> {
  name = "get_user_location";
  description = GET_USER_LOCATION_TOOL.description;
  inputSchema = GET_USER_LOCATION_TOOL.inputSchema;

  async run(_input: T.GetUserLocationInput): Promise<GeoLocation> {
    const resolved = await resolveLocation({ kind: "default" });
    return resolved.location;
  }
}
