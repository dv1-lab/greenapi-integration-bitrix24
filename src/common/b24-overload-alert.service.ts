// Cron-задача (через setInterval): каждые 5 мин читает b24Metrics.snapshot()
// и шлёт TG-алерт в админ-чат при превышении пороговых значений.
//
// Цель — поймать разгон нагрузки на B24 ДО блокировки OVERLOAD_LIMIT.
// 18.05 и 28.05 были 2 OVERLOAD блокировки B24 local-app'ов без
// предварительных предупреждений; cron-надзор за метриками — последний
// шанс отреагировать руками (снизить параллелизм / отложить backfill).
//
// Debounce: для каждого (app, severity) — не чаще одного алерта в окно
// (overload 1ч / critical 30мин / warn 1ч). Защита от спама в админ-чат.

import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GreenApiLogger } from "@green-api/greenapi-integration";
import axios from "axios";
import { B24MetricsService } from "./b24-metrics.service";

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // каждые 5 мин
const FIRST_CHECK_DELAY_MS = 60 * 1000;  // первая проверка через минуту после старта
const DEBOUNCE_OVERLOAD_MS = 60 * 60 * 1000;  // overload: 1 раз в час
const DEBOUNCE_CRITICAL_MS = 30 * 60 * 1000;  // critical: раз в 30 мин
const DEBOUNCE_WARN_MS = 60 * 60 * 1000;      // warn: раз в час

@Injectable()
export class B24OverloadAlertService implements OnApplicationBootstrap {
	private readonly logger = GreenApiLogger.getInstance(B24OverloadAlertService.name);
	private lastAlerted = new Map<string, number>();
	private intervalHandle: NodeJS.Timeout | null = null;
	private firstCheckHandle: NodeJS.Timeout | null = null;

	constructor(
		private readonly b24Metrics: B24MetricsService,
		private readonly config: ConfigService,
	) {}

	onApplicationBootstrap(): void {
		if (process.env.NODE_ENV === "test") return;
		if (process.env.B24_OVERLOAD_ALERT_DISABLED === "1") {
			this.logger.info("B24OverloadAlertService disabled via env");
			return;
		}
		this.firstCheckHandle = setTimeout(() => {
			void this.checkAndAlert();
		}, FIRST_CHECK_DELAY_MS);
		this.intervalHandle = setInterval(() => {
			void this.checkAndAlert();
		}, CHECK_INTERVAL_MS);
		this.logger.info(
			`B24OverloadAlertService started: first check in ${FIRST_CHECK_DELAY_MS / 1000}s, ` +
			`then every ${CHECK_INTERVAL_MS / 1000}s`,
		);
	}

	async checkAndAlert(): Promise<void> {
		try {
			const snap = this.b24Metrics.snapshot();
			for (const [app, data] of Object.entries(snap.apps)) {
				// OVERLOAD — высший приоритет (один алерт в час, пока флаг держится)
				if (data.overload_last_24h > 0) {
					this.maybeSend(
						`${app}:overload`, DEBOUNCE_OVERLOAD_MS,
						() => `🚨🚨 B24 ${app}: ${data.overload_last_24h} OVERLOAD_LIMIT за 24ч.\n` +
							`Возможно потребуется создать V2 app (см. social-connector-v2-migration / b24-overload-pattern).`,
					);
				}
				// CRITICAL — нагрузка > critical-порога за час
				if (data.calls_last_1h >= snap.thresholds.per_hour_critical) {
					this.maybeSend(
						`${app}:critical`, DEBOUNCE_CRITICAL_MS,
						() => `🚨 B24 ${app}: ${data.calls_last_1h} calls/час > critical=${snap.thresholds.per_hour_critical}.\n` +
							`Приближаемся к OVERLOAD блокировке. Останови параллельные backfill'ы.\n` +
							`Top: ${this.formatTopMethods(data.top_methods_1h)}`,
					);
				} else if (data.calls_last_1h >= snap.thresholds.per_hour_warn) {
					// WARN — превышен warn-порог
					this.maybeSend(
						`${app}:warn`, DEBOUNCE_WARN_MS,
						() => `⚠️ B24 ${app}: ${data.calls_last_1h} calls/час > warn=${snap.thresholds.per_hour_warn}.\n` +
							`Top: ${this.formatTopMethods(data.top_methods_1h)}`,
					);
				}
			}
		} catch (e: any) {
			this.logger.error(`B24OverloadAlert checkAndAlert failed: ${e?.message || e}`);
		}
	}

	private formatTopMethods(top: Array<{ method: string; count: number; errors: number }>): string {
		return top.slice(0, 5).map((m) => `${m.method}(${m.count})`).join(", ");
	}

	private maybeSend(key: string, debounceMs: number, makeText: () => string): void {
		const now = Date.now();
		const last = this.lastAlerted.get(key) || 0;
		if (now - last < debounceMs) return;
		this.lastAlerted.set(key, now);
		void this.sendAlert(makeText());
	}

	private async sendAlert(text: string): Promise<void> {
		const token = this.config.get<string>("ALERT_BOT_TOKEN");
		const chatId = this.config.get<string>("ALERT_CHAT_ID");
		if (!token || !chatId) {
			this.logger.warn(`b24-overload-alert (no channel configured): ${text}`);
			return;
		}
		try {
			await axios.post(
				`https://api.telegram.org/bot${token}/sendMessage`,
				{
					chat_id: chatId,
					text: `🔌 social-connector b24-load:\n${text}`,
					disable_web_page_preview: true,
				},
				{ timeout: 10000 },
			);
		} catch (e: any) {
			this.logger.error(`b24-overload-alert send failed: ${e?.message || e}`);
		}
	}
}
