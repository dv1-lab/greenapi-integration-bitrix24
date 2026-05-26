// GET /health/metrics — snapshot performance метрик в JSON.
//
// Защищён через X-Metrics-Token (env METRICS_TOKEN). Если env не задан —
// endpoint открыт (для разработки). В prod обязательно выставить токен,
// чтобы /metrics не утекал.
//
// Используется для:
//   - сбор baseline (Дмитрий вручную раз в сутки)
//   - подключения внешних monitoring (Prometheus exporter — TODO)
//   - debug «почему этот endpoint медленный»

import { Controller, Get, Headers, HttpException, HttpStatus } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiTags, ApiOperation, ApiHeader } from "@nestjs/swagger";
import { PerfMetricsService } from "../common/perf-metrics.service";

@ApiTags("health")
@Controller("health")
export class MetricsController {
	constructor(
		private readonly metrics: PerfMetricsService,
		private readonly config: ConfigService,
	) {}

	@Get("metrics")
	@ApiOperation({
		summary: "Performance metrics snapshot",
		description:
			"Возвращает per-endpoint latency (p50/p95/p99/avg/min/max), счётчик " +
			"запросов, error rate, status code распределение. In-memory, сбрасывается " +
			"при рестарте adapter'а. Защищено header X-Metrics-Token (env METRICS_TOKEN).",
	})
	@ApiHeader({
		name: "X-Metrics-Token",
		description: "Токен из env METRICS_TOKEN (обязателен в prod)",
		required: false,
	})
	getMetrics(@Headers("x-metrics-token") token: string) {
		const expected = this.config.get<string>("METRICS_TOKEN");
		if (expected && token !== expected) {
			throw new HttpException("invalid metrics token", HttpStatus.UNAUTHORIZED);
		}
		return {
			summary: this.metrics.getSummary(),
			endpoints: this.metrics.getAllMetrics(),
			generatedAt: new Date().toISOString(),
		};
	}
}
