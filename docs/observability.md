# Observability Guide

BoxMeOut exports Prometheus metrics, structured logs, and Sentry error tracking for production monitoring.

## Prometheus Metrics

All metrics are exported via `GET /metrics` in Prometheus exposition format. This endpoint is internal-only and should not be exposed publicly.

### HTTP Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `http_request_duration_seconds` | Histogram | `method`, `route`, `status_code` | Duration of HTTP requests in seconds |
| `http_requests_total` | Counter | `method`, `route`, `status_code` | Total number of HTTP requests |

**Histogram buckets:** 10ms, 50ms, 100ms, 250ms, 500ms, 1s, 2.5s, 5s, 10s

### Database Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `db_query_duration_seconds` | Histogram | `operation` | Duration of database queries in seconds |

**Labels:** `operation` = `select`, `insert`, `update`, `delete`

**Histogram buckets:** 1ms, 5ms, 10ms, 50ms, 100ms, 500ms, 1s, 5s

### Cache Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `cache_hits_total` | Counter | — | Total Redis cache hits |
| `cache_misses_total` | Counter | — | Total Redis cache misses |

**Cache hit rate:** `rate(cache_hits_total[5m]) / (rate(cache_hits_total[5m]) + rate(cache_misses_total[5m]))`

### WebSocket Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `websocket_active_connections` | Gauge | — | Currently active WebSocket connections |

### Cron Job Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `cron_sessions_deleted_total` | Counter | — | Expired user sessions deleted by cleanup cron |
| `cron_reset_tokens_deleted_total` | Counter | — | Expired password reset tokens deleted |
| `cron_notifications_soft_deleted_total` | Counter | — | Notification jobs soft-deleted |
| `cron_distributions_archived_total` | Counter | — | Failed distributions archived |

### Node.js Default Metrics

Default `prom-client` metrics are also collected, including:

- `nodejs_eventloop_lag_seconds` — Event loop lag
- `nodejs_active_handles_total` — Active handles
- `nodejs_heap_size_total_bytes` — Heap memory usage
- `process_cpu_seconds_total` — CPU usage

## Prometheus Scrape Configuration

```yaml
scrape_configs:
  - job_name: 'boxmeout'
    scrape_interval: 15s
    static_configs:
      - targets: ['backend:3001']
    metrics_path: /metrics
```

## Structured Logging

BoxMeOut uses [Pino](https://getpino.io/) for structured JSON logging.

**Log levels:** `trace`, `debug`, `info`, `warn`, `error`, `fatal`

**Log fields per request:**

- `req.method` — HTTP method
- `req.url` — Request URL
- `res.statusCode` — Response status
- `responseTime` — Request duration in ms

## Error Tracking

[Sentry](https://sentry.io/) is used for unhandled exception and rejection tracking.

**Configuration:** Set `SENTRY_DSN` in environment variables. Sentry is initialized on startup and captures:

- Unhandled promise rejections
- Uncaught exceptions
- Errors passed to `next(err)` in Express

## Alerting Recommendations

| Alert | PromQL | Threshold |
|-------|--------|-----------|
| High error rate | `rate(http_requests_total{status_code=~"5.."}[5m]) / rate(http_requests_total[5m])` | > 5% |
| Slow requests | `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))` | > 2s |
| Low cache hit rate | `rate(cache_hits_total[5m]) / (rate(cache_hits_total[5m]) + rate(cache_misses_total[5m]))` | < 50% |
| DB query latency | `histogram_quantile(0.95, rate(db_query_duration_seconds_bucket[5m]))` | > 500ms |
| WebSocket overload | `websocket_active_connections` | > 1000 |
