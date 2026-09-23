# Location Architecture

Location is an environment-fact boundary. The caller supplies a `LocationRequest`; Runtime resolves it before candidate generation and stores the resulting `ResolvedLocation` in `AgentState.environment.location`.

```text
LocationRequest
├─ coords
├─ address
├─ ip
└─ default
       ↓
get_user_location Tool
       ↓
LocationResolver
       ↓
Capability Providers
       ↓
ResolvedLocation
       ↓
Agent Environment
       ↓
Planner
```

`GetUserLocationTool` depends only on `LocationResolver`. `DefaultLocationResolver` selects the capability provider, assigns the final `ResolvedLocation.source`, and applies the existing no-result fallback policy. Provider exceptions propagate as infrastructure failures and are classified by `ToolExecutor`.

The capability interfaces are intentionally separate:

- `GeocodingProvider` resolves an address to `GeoLocation | null`.
- `GeoIpProvider` resolves an IP to `GeoLocation | null`.
- `DefaultLocationProvider` supplies an explicit default location.

The default composition is created by `createDefaultLocationResolver()`. It uses the configured activity-data geocoder, the AMap Geo-IP adapter when configured, and `StaticDefaultLocationProvider` for the zero-configuration development default. A provider may be replaced through `createToolRegistry({ locationResolver })` and `AgentRuntime({ toolRegistry })`.

Browser Geolocation is client-side input acquisition, not a server provider. The browser sends `{ context: { location: { kind: "coords", lat, lng } } }` to the API. The server may also accept explicit `address`, `ip`, or `default` requests. The server does not infer location from `X-Forwarded-For`.

Exact coordinates, address strings, and IP values are redacted from ordinary Runtime tool-call traces and tool-call records. Observability retains only source/shape indicators such as `coordinatesProvided`, `addressProvided`, and `ipProvided`.
