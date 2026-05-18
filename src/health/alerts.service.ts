import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { GreenApiLogger } from "@green-api/greenapi-integration";

// Тонкая обёртка над Telegram bot API sendMessage для админ-алертов.
// Канал берётся из env ALERT_BOT_TOKEN / ALERT_CHAT_ID. Если не задано —
// падаем в WARN-лог и не шлём (чтобы dev-окружение не упало без конфига).
//
// Шаблон одинаков с wa-tg-bridge `alerts.py` — оба бота отправляют в один
// чат @agent_dv_bot и одинаково префиксят источник.
@Injectable()
export class AlertsService {
	private readonly logger = GreenApiLogger.getInstance(AlertsService.name);
	private readonly token: string | undefined;
	private readonly chatId: string | undefined;

	constructor(config: ConfigService) {
		this.token = config.get<string>("ALERT_BOT_TOKEN");
		this.chatId = config.get<string>("ALERT_CHAT_ID");
	}

	get enabled(): boolean {
		return !!(this.token && this.chatId);
	}

	async send(text: string): Promise<void> {
		if (!this.enabled) {
			this.logger.warn(`ALERT (no channel configured): ${text}`);
			return;
		}
		try {
			await axios.post(
				`https://api.telegram.org/bot${this.token}/sendMessage`,
				{
					chat_id: this.chatId,
					text: `⚠️ greenapi-b24:\n${text}`,
					disable_web_page_preview: true,
				},
				{ timeout: 10000 },
			);
		} catch (e: any) {
			this.logger.error(`alert send failed: ${e?.message || e}`);
		}
	}
}
