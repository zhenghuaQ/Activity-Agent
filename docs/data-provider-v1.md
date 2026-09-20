# Activity Data Provider v1

Activity-Agent 只负责理解需求、生成候选和做决策。目的地解析、景点、餐厅和茶歇数据由可替换的 Provider 提供。

## 设计约束

- Provider 是只读接口，不包含预订、下单或支付。
- 明确目的地后，Provider 不得用其他城市的数据静默兜底。
- 每个地点必须包含 `source.providerId`、`source.externalId` 和 `source.fetchedAt`。
- API Key 由 Provider 自己管理，不进入 Planner、Event 或浏览器。
- 稳定契约为 `ActivityDataProviderV1`，当前 `apiVersion` 固定为 `1`。

## 本地 TypeScript Provider

实现 [`ActivityDataProviderV1`](../spec/datasource.ts)，然后在应用首次规划前注册：

```ts
import { registerDataProvider } from "../src/data/index.js";
import { CommunityProvider } from "../examples/providers/community-provider.js";

process.env.ACTIVITY_DATA_PROVIDER = "community";
registerDataProvider("community", () => new CommunityProvider(catalog));
```

项目不会根据环境变量加载任意本地代码；宿主必须显式 import 和注册，以避免远程代码执行风险。

## HTTP Provider

配置：

```env
ACTIVITY_DATA_PROVIDER=http
ACTIVITY_DATA_PROVIDER_URL=https://your-provider.example
ACTIVITY_DATA_PROVIDER_ID=my-provider
ACTIVITY_DATA_PROVIDER_TOKEN=optional-token
ACTIVITY_DATA_PROVIDER_TIMEOUT_MS=10000
```

请求都携带 `X-Activity-Provider-Version: 1`，响应必须使用：

```json
{ "apiVersion": 1, "data": {} }
```

接口：

- `POST /v1/resolve-destination`，请求 `{ "query": DestinationQuery }`
- `POST /v1/places/attractions/search`，请求 `{ "query": PlaceQuery }`
- `POST /v1/places/restaurants/search`
- `POST /v1/places/breaks/search`
- `GET /v1/places/attractions/:id`
- `GET /v1/places/restaurants/:id`
- `POST /v1/geocode`，请求 `{ "address": string }`

`401/403`、`404`、`429` 会分别映射为认证失败、目的地不支持和限流错误。网络失败不会跨城市降级。

## 合规测试

```ts
import { runProviderConformance } from "../src/data/index.js";

const report = await runProviderConformance(provider, {
  destination: { city: "上海" },
  radiusKm: 20,
});
if (!report.passed) console.error(report.issues);
```

合规测试以 Provider 为黑盒，检查版本、能力声明、目的地一致性、搜索半径和数据来源。项目内置 Mock Provider 也运行同一套测试。

## 候选生成流程

```text
用户目的地
  → resolve_destination
  → SearchArea（城市、中心点、置信度）
  → 景点/餐厅/茶歇并行搜索
  → 标准 Place 数据
  → Candidate Generator / Constraint Engine
```

如果 Provider 不支持目的地，规划会以 `E_DESTINATION_UNSUPPORTED` 结束，不会生成错误城市的方案。
