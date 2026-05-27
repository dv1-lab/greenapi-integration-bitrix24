import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { GreenApiLogger, GreenApiWebhook, MessageWebhook } from "@green-api/greenapi-integration";
import axios from "axios";
import { PrismaService } from "../prisma/prisma.service";
import { Bitrix24Service } from "../bitrix24/bitrix24.service";
import { greenApiUrl } from "../common/green-api-url";

/**
 * Task #71 — Startup backfill incoming.
 *
 * При запуске adapter после downtime (DDoS hip.hosting 26-27.05.2026,
 * см. REGRESSIONS) — догнать пропущенные incoming-сообщения Green API
 * (WA/MAX/TG-номер магазина) за период простоя.
 *
 * Логика:
 *   1. Через 30 сек после `onApplicationBootstrap` (даём Nest + Prisma
 *      окончательно прогреться) — для каждого активного Green API инстанса:
 *   2. POST `/lastIncomingMessages?minutes=N` — Green API возвращает массив
 *      incoming-сообщений за указанный период (макс 1440 = 24 часа).
 *   3. Для каждого сообщения проверяем по `idMessage` в таблице
 *      `IncomingMessage` — обработано ли уже. Если да — skip.
 *   4. Если нет — конструируем синтетический `MessageWebhook` и подаём в
 *      `bitrix24Service.handleGreenApiWebhook` (как будто webhook пришёл
 *      сейчас). B24 идемпотентен по `external_message_id` — дубль не создаст.
 *   5. Между обращениями к Green API API — пауза 200ms (rate-limit).
 *   6. Логируем итог: восстановлено X, пропущено как дубль Y, ошибок Z.
 *
 * Не покрывает:
 *   - Instagram (i2crm) — отдельная подзадача, нужен другой API.
 *   - TG-боты (@begovoy_bot) — у них long-polling, сами догоняют через
 *     offset, backfill не нужен.
 *   - Downtime > 24 часов — Green API archive протух.
 *
 * Disable: env `BACKFILL_STARTUP_DISABLED=1` (на случай если надо
 * быстро отключить если что-то пойдёт не так в проде).
 */
@Injectable()
export class StartupBackfillService implements OnApplicationBootstrap {
	private readonly logger = GreenApiLogger.getInstance(StartupBackfillService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly bitrix24Service: Bitrix24Service,
	) {}

	onApplicationBootstrap(): void {
		if (process.env.BACKFILL_STARTUP_DISABLED === "1") {
			this.logger.info("startup-backfill: disabled via BACKFILL_STARTUP_DISABLED=1");
			return;
		}
		// Запускаем фоном с задержкой 30 сек — даём системе прогреться,
		// open-lines подтянуть конфиги, prisma пул соединений. Не блокируем
		// startup.
		setTimeout(() => {
			this.runBackfill().catch((e) => {
				this.logger.error(`startup-backfill: unexpected error: ${e?.message || e}`);
			});
		}, 30_000);
	}

	/** Главный метод. Выполняется один раз через 30 сек после старта. */
	async runBackfill(): Promise<{ instances: number; recovered: number; skipped: number; errors: number }> {
		const minutes = Number(process.env.BACKFILL_STARTUP_MINUTES) || 1440;
		this.logger.info(`startup-backfill: starting (period=${minutes} min)`);

		const instances = await (this.prisma as any).instance.findMany({
			where: { stateInstance: "authorized" },
			include: { user: true },
		});
		if (!instances || instances.length === 0) {
			this.logger.info("startup-backfill: no authorized instances, nothing to do");
			return { instances: 0, recovered: 0, skipped: 0, errors: 0 };
		}

		let totalRecovered = 0;
		let totalSkipped = 0;
		let totalErrors = 0;

		for (const inst of instances) {
			try {
				const r = await this.backfillInstance(inst, minutes);
				totalRecovered += r.recovered;
				totalSkipped += r.skipped;
				totalErrors += r.errors;
			} catch (e: any) {
				totalErrors++;
				this.logger.error(
					`startup-backfill: instance ${inst.idInstance} failed: ${e?.message || e}`,
				);
			}
			// Пауза между инстансами — не нагружаем сервер
			await new Promise((res) => setTimeout(res, 500));
		}

		this.logger.info(
			`startup-backfill: done — instances=${instances.length} recovered=${totalRecovered} skipped=${totalSkipped} errors=${totalErrors}`,
		);
		return { instances: instances.length, recovered: totalRecovered, skipped: totalSkipped, errors: totalErrors };
	}

	/** Обработка одного инстанса. */
	private async backfillInstance(
		inst: { idInstance: bigint; apiTokenInstance: string; settings: any },
		minutes: number,
	): Promise<{ recovered: number; skipped: number; errors: number }> {
		const idInstance = String(inst.idInstance);
		const apiUrl = greenApiUrl(idInstance);
		const apiToken = inst.apiTokenInstance;

		// Retry на transient network/DNS-ошибки: после downtime hip.hosting
		// networking может ещё не стабилизироваться (EAI_AGAIN/getaddrinfo).
		// Без retry backfill тихо провалится — было 27.05.2026 (см. REGRESSIONS).
		let messages: any[] = [];
		let lastErr: any = null;
		const maxAttempts = 3;
		const baseDelayMs = 30_000;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				const r = await axios.get(
					`${apiUrl}/waInstance${idInstance}/lastIncomingMessages/${apiToken}`,
					{ params: { minutes }, timeout: 30_000 },
				);
				messages = Array.isArray(r.data) ? r.data : [];
				lastErr = null;
				break;
			} catch (e: any) {
				lastErr = e;
				const msg = String(e?.code || e?.message || e);
				const isTransient = /EAI_AGAIN|getaddrinfo|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET/i.test(msg);
				if (!isTransient || attempt === maxAttempts) break;
				const delayMs = baseDelayMs * Math.pow(2, attempt - 1); // 30s → 60s → 120s
				this.logger.warn(
					`startup-backfill: lastIncomingMessages for ${idInstance} attempt ${attempt}/${maxAttempts} transient error: ${msg}; retry in ${Math.round(delayMs/1000)}s`,
				);
				await new Promise((res) => setTimeout(res, delayMs));
			}
		}
		if (lastErr) {
			this.logger.warn(
				`startup-backfill: lastIncomingMessages for ${idInstance} failed after ${maxAttempts} attempts: ${lastErr?.message || lastErr}`,
			);
			return { recovered: 0, skipped: 0, errors: 1 };
		}
		if (messages.length === 0) {
			this.logger.info(`startup-backfill: ${idInstance} — no messages in last ${minutes} min`);
			return { recovered: 0, skipped: 0, errors: 0 };
		}

		// Берём все idMessage за раз и проверяем какие уже в БД.
		const idMessages = messages.map((m) => String(m.idMessage)).filter(Boolean);
		const known: any[] = await (this.prisma as any).incomingMessage.findMany({
			where: { idMessage: { in: idMessages } },
			select: { idMessage: true },
		});
		const knownSet = new Set(known.map((k) => k.idMessage));

		let recovered = 0;
		let skipped = 0;
		let errors = 0;

		for (const m of messages) {
			const idMessage = String(m.idMessage || "");
			if (!idMessage) continue;
			if (knownSet.has(idMessage)) {
				skipped++;
				continue;
			}
			try {
				const webhook = this.synthesizeWebhook(inst, m);
				await this.bitrix24Service.handleGreenApiWebhook(webhook, ["incomingMessageReceived"]);
				// Записываем как обработанное чтобы не дёргать повторно при следующем
				// рестарте (на случай если backfill отработал но webhook-запись
				// в IncomingMessage не успела пройти из-за race).
				await (this.prisma as any).incomingMessage.createMany({
					data: [{
						idMessage,
						idInstance: BigInt(idInstance),
						chatId: String(m.chatId || ""),
						timestamp: Number(m.timestamp) || Math.floor(Date.now() / 1000),
						source: "backfill_startup",
					}],
					skipDuplicates: true,
				});
				recovered++;
				// Rate-limit между обработками — не нагружаем B24/Green API/MySQL.
				await new Promise((res) => setTimeout(res, 200));
			} catch (e: any) {
				errors++;
				this.logger.warn(
					`startup-backfill: process ${idMessage} failed: ${e?.message || e}`,
				);
			}
		}

		this.logger.info(
			`startup-backfill: instance ${idInstance} — total=${messages.length} recovered=${recovered} skipped=${skipped} errors=${errors}`,
		);
		return { recovered, skipped, errors };
	}

	/** Сборка `MessageWebhook` из элемента `lastIncomingMessages`. Формат
	 *  массива отличается от webhook-формата (нет typeWebhook/instanceData);
	 *  достраиваем недостающие поля. Структура достаточная для того чтобы
	 *  пройти через `handleGreenApiWebhook` + `bitrix24.transformer`. */
	private synthesizeWebhook(
		inst: { idInstance: bigint; settings: any },
		m: any,
	): GreenApiWebhook {
		const idInstance = Number(inst.idInstance);
		const wid = String((inst.settings as any)?.wid || "");
		const provider = String((inst.settings as any)?.provider || "wa").toLowerCase();
		const typeInstance =
			provider === "max" ? "max"
			: provider === "telegram" ? "telegram"
			: "whatsapp";

		const webhook: MessageWebhook = {
			typeWebhook: "incomingMessageReceived",
			instanceData: { idInstance, wid, typeInstance },
			timestamp: Number(m.timestamp) || Math.floor(Date.now() / 1000),
			idMessage: String(m.idMessage),
			senderData: {
				chatId: String(m.chatId || ""),
				sender: String(m.senderId || m.chatId || ""),
				chatName: String(m.chatName || ""),
				senderName: String(m.senderName || m.chatName || ""),
				...(m.senderContactName ? { senderContactName: String(m.senderContactName) } : {}),
			},
			messageData: this.synthesizeMessageData(m),
		};
		return webhook;
	}

	/** Поднимаем messageData из плоского формата `lastIncomingMessages`
	 *  в формат webhook (`{ typeMessage, textMessageData: {textMessage} }` etc).
	 *  Покрываем основные типы; экзотика валится на SDK transformer как и
	 *  realtime webhook'и. */
	private synthesizeMessageData(m: any): any {
		const typeMessage = String(m.typeMessage || "textMessage");
		switch (typeMessage) {
			case "textMessage":
			case "extendedTextMessage":
				return {
					typeMessage,
					textMessageData: { textMessage: String(m.textMessage || "") },
				};
			case "imageMessage":
			case "videoMessage":
			case "documentMessage":
			case "audioMessage":
				return {
					typeMessage,
					fileMessageData: {
						downloadUrl: String(m.downloadUrl || ""),
						caption: String(m.caption || ""),
						fileName: String(m.fileName || ""),
						mimeType: String(m.mimeType || ""),
					},
				};
			default:
				// Не падаем на неподдерживаемом типе — оставляем как есть, пусть
				// transformer/handler разберётся (или skip'нет).
				return { typeMessage, ...(m.messageData || {}) };
		}
	}
}
