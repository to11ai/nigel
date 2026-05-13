import { registerOTel } from "@vercel/otel";

// Server-side OpenTelemetry registration (Phase 7a). Next.js calls
// `register()` once per worker on cold start, before any route or
// server action executes, so the SDK installs auto-instrumentation
// for `http`, `fetch`, and Node's built-in fetch with zero per-call
// overhead at the call sites.
//
// `@vercel/otel` is preconfigured for Vercel's edge + node runtimes
// and reads `OTEL_EXPORTER_OTLP_*` env vars to pick the exporter. We
// only override `serviceName` here so traces from this project show
// up under a stable name regardless of the deploy URL.
//
// When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset (e.g. local dev), the
// SDK still installs auto-instrumentation but drops the export; this
// matters because the instrumentation hooks (and the resulting span
// context propagation) need to be present so child spans added in
// Phase 7b/7c attach to the right parent regardless of environment.
//
// Datadog setup (the project's observability backend): point
// `OTEL_EXPORTER_OTLP_ENDPOINT` at the Datadog Agent's OTLP HTTP
// receiver (default `http://<agent-host>:4318`) and the Agent forwards
// to Datadog. Set `DD_SERVICE` / `DD_ENV` / `DD_VERSION` env vars
// where the Agent runs so they tag forwarded spans. The Datadog
// Vercel integration provisions the Agent for you.
//
// The OTLP HTTP exporter auto-suffixes `/v1/traces`, `/v1/metrics`,
// and `/v1/logs`; do not include them in `OTEL_EXPORTER_OTLP_ENDPOINT`.
// Auth headers (if any) go in `OTEL_EXPORTER_OTLP_HEADERS` as
// comma-separated `key=value` pairs.
export function register(): void {
  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "nigel-web",
  });
}
