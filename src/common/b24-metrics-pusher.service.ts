// Пушер метрик нагрузки B24 на дашборд (dv-dashboard /api/b24-metrics/push).
// Каждые 5 мин берёт окно событий с прошлого пуша (windowSince) и шлёт по
// приложению (social / customer360) порцию счётчиков по контракту дашборда.
// Источник правды нагрузки B24 у нас — собственный B24MetricsService (у B24
// нет API учёта вызовов). Пуш fire-and-forget: его падение не трогает adapter.

import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GreenApiLogger } from "@green-api/greenapi-integration";
import axios from "axios";
import { B24MetricsService } from "./b24-metrics.service";

const PUSH_INTERVAL_MS = 5 * 60 * 1000; // каждые 5 мин (совпадает с окном)

@Injectable()
export class B24MetricsPusherService implements OnApplicationBootstrap {
	private readonly logger = GreenApiLogger.getInstance(B24MetricsPusherService.name);
	private lastTs = Date.now();
	private intervalHandle: NodeJS.Timeout | null = null;

	constructor(
		private readonly b24Metrics: B24MetricsService,
		private readonly config: ConfigService,
	) {}

	onApplicationBootstrap(): void {
		if (process.env.NODE_ENV === "test") return;
		if (process.env.B24_METRICS_PUSH_DISABLED === "1") {
			this.logger.info("B24MetricsPusher disabled via env");
			return;
		}
		const url = this.config.get<string>("B24_METRICS_PUSH_URL");
		const token = this.config.get<string>("B24_METRICS_PUSH_TOKEN");
		if (!url || !token) {
			this.logger.info("B24MetricsPusher disabled (no B24_METRICS_PUSH_URL/TOKEN)");
			return;
		}
		this.lastTs = Date.now();
		this.intervalHandle = setInterval(() => void this.pushOnce(), PUSH_INTERVAL_MS);
		this.logger.info(`B24MetricsPusher started: every ${PUSH_INTERVAL_MS / 1000}s → ${url}`);
	}

	async pushOnce(): Promise<void> {
		const url = this.config.get<string>("B24_METRICS_PUSH_URL");
		const token = this.config.get<string>("B24_METRICS_PUSH_TOKEN");
		if (!url || !token) return;
		try {
			const { now, apps } = this.b24Metrics.windowSince(this.lastTs);
			const windowSec = Math.max(1, Math.round((now - this.lastTs) / 1000));
			this.lastTs = now;
			for (const [app, data] of Object.entries(apps)) {
				await axios
					.post(
						url,
						{ app, window_sec: windowSec, calls: data.calls, top_methods: data.topMethods },
						{ timeout: 10_000, headers: { "x-metrics-push-token": token } },
					)
					.catch((e: any) => {
						this.logger.warn(`b24-metrics push ${app} failed: ${e?.message || e}`);
					});
			}
		} catch (e: any) {
			this.logger.error(`b24-metrics pushOnce failed: ${e?.message || e}`);
		}
	}
}
