import { Controller, Post, Body, HttpCode, HttpStatus, Req, Res, UseGuards } from "@nestjs/common";
import { Request, Response } from "express";
import { Bitrix24Service } from "../bitrix24/bitrix24.service";
import { I2crmTgMirrorService } from "../bitrix24/i2crm-tg-mirror.service";
import { TgBotMirrorService } from "../bitrix24/tg-bot-mirror.service";
import { GreenApiWebhook, GreenApiLogger } from "@green-api/greenapi-integration";
import { Bitrix24WebhookDto } from "../bitrix24/dto/bitrix24-webhook.dto";
import { Bitrix24WebhookGuard } from "./guards/bitrix24-webhook.guard";
import { PrismaService } from "../prisma/prisma.service";
import { ApiTags, ApiOperation, ApiExcludeEndpoint } from "@nestjs/swagger";

// i2crm посылает client_id, message_id, external_id и пр. как 64-bit integers
// (могут быть > 2^53). JSON.parse в Node превращает их в Number и теряет
// точность последних цифр. Преобразуем их в строки ДО JSON.parse через regex
// над сырым текстом — единственный способ сохранить точное значение.
const BIG_INT_FIELDS = /(\"(?:client_id|message_id|external_id|account_id|media_id|comment_id|id|account|client)\"\s*:\s*)(\d{15,})/g;

function safeJsonParse(rawText: string): any {
	const safe = rawText.replace(BIG_INT_FIELDS, '$1"$2"');
	return JSON.parse(safe);
}

@ApiTags("webhooks")
@Controller("webhooks")
export class WebhooksController {
	private readonly logger = GreenApiLogger.getInstance(WebhooksController.name);

	constructor(
		private readonly bitrix24Service: Bitrix24Service,
		private readonly i2crmTgMirror: I2crmTgMirrorService,
		private readonly tgBotMirror: TgBotMirrorService,
		private readonly prisma: PrismaService,
	) {}

	@Post("green-api")
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: "Green API webhook ingestion",
		description:
			"Главный webhook от Green API: incomingMessageReceived, outgoingMessageStatus, " +
			"stateInstanceChanged, и др. Обрабатывает все 5 WA/MAX/TG-bot инстансов. " +
			"Outgoing-status (sent/delivered/read) проксируется в B24 как часики. " +
			"См. SEQUENCES.md #1.",
	})
	async handleGreenApiWebhook(@Body() webhook: GreenApiWebhook, @Res() res: Response): Promise<void> {
		this.logger.debug(`Green API webhook received: ${webhook.typeWebhook}`);

		res.status(HttpStatus.OK).send();

		// Customer-360 / Social Connector: проксируем outgoingMessageStatus в B24
		// чтобы B24 видел галочки sent/delivered/read. Делаем ДО SDK-фильтра,
		// потому что SDK по умолчанию отбрасывает этот тип webhook'а.
		if (webhook.typeWebhook === "outgoingMessageStatus") {
			try {
				await this.bitrix24Service.handleOutgoingMessageStatus(webhook);
			} catch (error: any) {
				this.logger.warn(`outgoingMessageStatus handler failed: ${error.message}`);
			}
			return;
		}

		// Outgoing-from-mobile: оператор написал клиенту с мобильного WhatsApp
		// (не из B24). Green API шлёт outgoingAPIMessageReceived с sendByApi=true
		// и sender=наш wid. Adapter SDK Skipping — мы обрабатываем сами, чтобы
		// в B24 был след сообщения в timeline сделки/лида клиента.
		if (webhook.typeWebhook === "outgoingAPIMessageReceived") {
			try {
				await this.bitrix24Service.handleOutgoingFromMobile(webhook);
			} catch (error: any) {
				this.logger.warn(`outgoingAPIMessageReceived handler failed: ${error.message}`);
			}
			return;
		}

		// Outgoing-from-device: менеджер написал клиенту прямо из приложения
		// мессенджера (Telegram/MAX офисного аккаунта), минуя B24. Зеркалим в
		// открытую линию как is_self_message, чтобы ответ был виден в B24-диалоге.
		if (webhook.typeWebhook === "outgoingMessageReceived") {
			try {
				await this.bitrix24Service.handleOutgoingFromDevice(webhook);
			} catch (error: any) {
				this.logger.warn(`outgoingMessageReceived handler failed: ${error.message}`);
			}
			return;
		}

		// Автоответ «нерабочее время» на входящие WA/TG/MAX — фоном,
		// не блокирует и не влияет на основной relay в B24.
		if (webhook.typeWebhook === "incomingMessageReceived") {
			this.bitrix24Service.maybeOffHoursAutoReply(webhook).catch((error: any) =>
				this.logger.warn(`off-hours auto-reply failed: ${error.message}`),
			);
		}

		try {
			await this.bitrix24Service.handleGreenApiWebhook(webhook, [
				"incomingMessageReceived",
				"stateInstanceChanged",
				"incomingCall",
			]);
		} catch (error: any) {
			this.logger.error(`Error processing Green API webhook:`, error);
		}
	}

	@Post("i2crm")
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: "i2crm webhook (Instagram Direct + Comments)",
		description:
			"Incoming events от i2crm Public API: channel ∈ {instdir, instcom}. " +
			"Раздаёт в handleI2crmIncoming (см. SEQUENCES.md #3). Использует raw " +
			"JSON parser для сохранения 64-bit IDs клиентов IG (BigInt fields).",
	})
	async handleI2crmWebhook(@Req() req: Request, @Res() res: Response): Promise<void> {
		// Используем raw body (saved by express.json verify в main.ts) — парсим
		// числовые ID-поля как строки чтобы не терять последние цифры на
		// 64-bit integers. NestJS default-парсер использует JSON.parse, который
		// округляет числа > 2^53 (Instagram client_id может быть 19-значным).
		let body: any;
		try {
			const rawBuf = (req as any).rawBody as Buffer | undefined;
			const text = rawBuf ? rawBuf.toString("utf-8") : JSON.stringify(req.body || {});
			body = safeJsonParse(text);
		} catch (e: any) {
			this.logger.error(`[i2crm webhook] body parse failed: ${e.message}`);
			body = req.body;
		}
		this.logger.info("[i2crm webhook] payload", body);
		// Сразу 200 чтобы i2crm не ретраил при долгой обработке
		res.status(HttpStatus.OK).json({ success: true });
		try {
			const result = await this.bitrix24Service.handleI2crmIncoming(body);
			if (!result.success) {
				this.logger.warn(`[i2crm webhook] skipped: ${result.reason}`);
			}
		} catch (error: any) {
			this.logger.error("[i2crm webhook] handler error", error);
		}
	}

	// Telegram Bot webhook от Telegram Bot API. Поддерживаются несколько
	// бот-инстансов: путь /webhooks/telegram-bot/:name определяет инстанс.
	// Legacy /webhooks/telegram-bot (без имени) — это @begovoy_bot, для
	// обратной совместимости со старым setWebhook.
	// Защита: secret_token, который мы задаём при setWebhook для каждого бота,
	// Telegram шлёт его в заголовке X-Telegram-Bot-Api-Secret-Token.
	@Post("telegram-bot/:name")
	@HttpCode(HttpStatus.OK)
	async handleTelegramBotByName(@Req() req: Request, @Res() res: Response): Promise<void> {
		const name = String((req.params as any)?.name || "begovoy");
		await this._tgBotWebhook(req, res, name);
	}

	@Post("telegram-bot")
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: "Telegram bot webhook (legacy single-instance)",
		description:
			"Legacy endpoint для @begovoy_bot до multi-instance. Для multi-instance " +
			"используется /webhooks/telegram-bot/:name (одна линия = один бот).",
	})
	async handleTelegramBotWebhook(@Req() req: Request, @Res() res: Response): Promise<void> {
		await this._tgBotWebhook(req, res, "begovoy");
	}

	private async _tgBotWebhook(req: Request, res: Response, name: string): Promise<void> {
		// Secret-token у каждого бота свой: TG_BOT_<NAME>_WEBHOOK_SECRET
		// (для begovoy fallback на legacy TG_BOT_WEBHOOK_SECRET).
		const envKey = name === "begovoy"
			? "TG_BOT_WEBHOOK_SECRET"
			: `TG_BOT_${name.toUpperCase()}_WEBHOOK_SECRET`;
		const expected = process.env[envKey] || (name === "begovoy" ? "" : process.env.TG_BOT_WEBHOOK_SECRET || "");
		const given = String(req.headers["x-telegram-bot-api-secret-token"] || "");
		if (expected && given !== expected) {
			this.logger.warn(`[telegram-bot:${name}] rejected: bad secret token`);
			// 200, чтобы Telegram не ретраил мусорный запрос.
			res.status(HttpStatus.OK).json({ ok: true });
			return;
		}
		// Сразу 200 — Telegram ждёт быстрый ответ, иначе ретраит и копит очередь.
		res.status(HttpStatus.OK).json({ ok: true });
		const update = req.body || {};
		try {
			const result = await this.bitrix24Service.handleTelegramBotIncoming(update, name);
			if (!result.success) {
				this.logger.warn(`[telegram-bot:${name}] skipped: ${result.reason}`);
			}
		} catch (error: any) {
			this.logger.error(`[telegram-bot:${name}] handler error`, error);
		}
	}

	@Post("bitrix24")
	@UseGuards(Bitrix24WebhookGuard)
	@ApiOperation({
		summary: "Bitrix24 webhook (events + connector messages)",
		description:
			"Webhook от B24: ONIMCONNECTORMESSAGEADD (outgoing от оператора → клиенту), " +
			"ONIMCONNECTORSTATUSDELETE, ONAPPUNINSTALL, и др. Также принимает SAVE " +
			"от placement SETTING_CONNECTOR (сохранение настроек инстанса). Защищён " +
			"Bitrix24WebhookGuard (проверяет applicationToken).",
	})
	async handleBitrix24ConnectorWebhook(@Body() body: Bitrix24WebhookDto, @Res() res: Response): Promise<void> {
		this.logger.debug(`Bitrix24 webhook received`, body);

		try {
			const result = await this.bitrix24Service.processWebhook(body);
			res.json(result);
		} catch (error: any) {
			const errorResponse = this.mapError(error);
			res.status(errorResponse.statusCode).json(errorResponse.body);
		}
	}

	// Internal endpoint для wa-tg-bridge: оператор написал ответ в супергруппе
	// зеркала наших Telegram-ботов (TG begovoy_bot / 1Б Поддержка) — bridge
	// ловит это в TG-группе и пересылает сюда. Мы по (groupId, topicId)
	// находим chatId клиента и отправляем через нужный бот-инстанс.
	// Auth: X-Hint-Secret.
	@Post("internal/tg-bot-reply")
	@HttpCode(HttpStatus.OK)
	async tgBotReply(@Req() req: Request, @Res() res: Response): Promise<void> {
		const expected = process.env.BRIDGE_HINT_SECRET || "";
		const given = String(req.headers["x-hint-secret"] || "");
		if (expected && given !== expected) {
			res.status(HttpStatus.UNAUTHORIZED).json({ error: "unauthorized" });
			return;
		}
		const body = (req.body || {}) as {
			groupId?: string; topicId?: number; text?: string; operatorName?: string;
		};
		const groupId = String(body.groupId || "");
		const topicId = Number(body.topicId || 0);
		const text = String(body.text || "").trim();
		if (!groupId || !topicId || !text) {
			res.status(HttpStatus.BAD_REQUEST).json({ error: "groupId, topicId, text required" });
			return;
		}
		const botName = this.bitrix24Service.getTgBotByGroupId(groupId);
		if (!botName) {
			res.status(HttpStatus.OK).json({ ok: false, reason: `groupId ${groupId} не привязан к tg-bot инстансу` });
			return;
		}
		const chatId = await this.tgBotMirror.findChatIdByTopic(groupId, topicId);
		if (!chatId) {
			res.status(HttpStatus.OK).json({ ok: false, reason: `нет связи topic ${topicId} → клиент в group ${groupId}` });
			return;
		}
		try {
			const result = await this.bitrix24Service.sendFromTgBot(
				botName, chatId, text, body.operatorName,
			);
			res.json(result);
		} catch (e: any) {
			this.logger.error(`tg-bot-reply send failed: ${e.message}`);
			res.status(HttpStatus.OK).json({ ok: false, error: e.message });
		}
	}

	// Internal endpoint для wa-tg-bridge: /nnn в супергруппе TG-бот зеркала
	// (begovoy / support) → timeline-comment во внутренней сущности клиента в B24.
	// У TG-бот клиента нет phone — резолвим через UF_CRM_TG_CHAT_ID.
	// Auth: X-Hint-Secret.
	@Post("internal/tg-bot-note")
	@HttpCode(HttpStatus.OK)
	async tgBotNote(@Req() req: Request, @Res() res: Response): Promise<void> {
		const expected = process.env.BRIDGE_HINT_SECRET || "";
		const given = String(req.headers["x-hint-secret"] || "");
		if (expected && given !== expected) {
			res.status(HttpStatus.UNAUTHORIZED).json({ error: "unauthorized" });
			return;
		}
		const body = (req.body || {}) as {
			groupId?: string; topicId?: number; text?: string; author?: string;
		};
		const groupId = String(body.groupId || "");
		const topicId = Number(body.topicId || 0);
		const text = String(body.text || "").trim();
		const author = String(body.author || "").trim();
		if (!groupId || !topicId || !text) {
			res.status(HttpStatus.BAD_REQUEST).json({ error: "groupId, topicId, text required" });
			return;
		}
		const botName = this.bitrix24Service.getTgBotByGroupId(groupId);
		if (!botName) {
			res.status(HttpStatus.OK).json({ ok: false, reason: `groupId ${groupId} не привязан к tg-bot инстансу` });
			return;
		}
		const chatId = await this.tgBotMirror.findChatIdByTopic(groupId, topicId);
		if (!chatId) {
			res.status(HttpStatus.OK).json({ ok: false, reason: `нет связи topic ${topicId} → клиент в group ${groupId}` });
			return;
		}
		const prefix = author ? `📝 Заметка от ${author}:\n` : "📝 Заметка:\n";
		const result = await this.bitrix24Service.addTimelineCommentByTgChat(chatId, prefix + text);
		res.json(result);
	}

	// Internal endpoint для wa-tg-bridge: получить ФИО клиента из B24 по phone
	// (для WA/MAX/TG) или igClientId (для Instagram). Авторизация общим секретом
	// BRIDGE_HINT_SECRET (он же используется для operator-hint). Контейнер
	// доступен только в Docker-сети, наружу не торчит.
	@Post("internal/contact-name")
	@HttpCode(HttpStatus.OK)
	async getContactName(@Req() req: Request, @Res() res: Response): Promise<void> {
		const expected = process.env.BRIDGE_HINT_SECRET || "";
		const given = String(req.headers["x-hint-secret"] || "");
		if (expected && given !== expected) {
			res.status(HttpStatus.UNAUTHORIZED).json({ error: "unauthorized" });
			return;
		}
		const body = (req.body || {}) as { phone?: string; igClientId?: string; tgChatId?: string; maxChatId?: string };
		try {
			const result = await this.bitrix24Service.getContactName(body);
			res.json(result);
		} catch (error: any) {
			this.logger.error(`contact-name lookup failed: ${error.message}`);
			res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: error.message });
		}
	}

	// Internal endpoint: добавить timeline-comment в открытый лид/сделку клиента
	// (по phone). Используется bridge для avatar_changed события (Customer-360
	// Этап 5): PHOTO в B24 НЕ меняем, только оставляем след в timeline. Auth:
	// X-Hint-Secret.
	@Post("internal/timeline-comment")
	@HttpCode(HttpStatus.OK)
	async timelineComment(@Req() req: Request, @Res() res: Response): Promise<void> {
		const expected = process.env.BRIDGE_HINT_SECRET || "";
		const given = String(req.headers["x-hint-secret"] || "");
		if (expected && given !== expected) {
			res.status(HttpStatus.UNAUTHORIZED).json({ error: "unauthorized" });
			return;
		}
		const body = (req.body || {}) as {
			phone?: string; channel?: string; text?: string;
		};
		const phone = String(body.phone || "").trim();
		const text = String(body.text || "").trim();
		if (!phone || !text) {
			res.status(HttpStatus.BAD_REQUEST).json({ error: "phone and text required" });
			return;
		}
		try {
			const result = await this.bitrix24Service.addTimelineCommentByPhone(phone, text);
			res.json(result);
		} catch (error: any) {
			this.logger.warn(`timeline-comment failed: ${error.message}`);
			res.status(HttpStatus.OK).json({ ok: false, reason: error.message });
		}
	}

	// Internal endpoint: перепривязать UF_CRM_PB_CUSTOMER_UUID на лидах/
	// контактах/сделках B24 с одного customer-UUID на другой. Используется
	// customer-service при cutover («разъединение клиента по дате»). Auth:
	// X-Hint-Secret.
	@Post("internal/repoint-b24-uuid")
	@HttpCode(HttpStatus.OK)
	async repointB24Uuid(@Req() req: Request, @Res() res: Response): Promise<void> {
		const expected = process.env.BRIDGE_HINT_SECRET || "";
		const given = String(req.headers["x-hint-secret"] || "");
		if (expected && given !== expected) {
			res.status(HttpStatus.UNAUTHORIZED).json({ error: "unauthorized" });
			return;
		}
		const body = (req.body || {}) as {
			newUuid?: string;
			leadIds?: number[];
			contactIds?: number[];
			dealIds?: number[];
		};
		if (!body.newUuid) {
			res.status(HttpStatus.BAD_REQUEST).json({ error: "newUuid required" });
			return;
		}
		try {
			const result = await this.bitrix24Service.repointCustomerUuid({
				newUuid: body.newUuid,
				leadIds: body.leadIds || [],
				contactIds: body.contactIds || [],
				dealIds: body.dealIds || [],
			});
			res.json(result);
		} catch (error: any) {
			this.logger.warn(`repoint-b24-uuid failed: ${error.message}`);
			res.status(HttpStatus.OK).json({ ok: false, reason: error.message });
		}
	}

	// Internal endpoint: положить транскрипт звонка timeline-комментом в B24 —
	// в лид/сделку/контакт клиента (поиск по UF_CRM_PB_CUSTOMER_UUID).
	// Используется customer-360 calls-transcribe. Auth: X-Hint-Secret.
	@Post("internal/transcript-to-b24")
	@HttpCode(HttpStatus.OK)
	async transcriptToB24(@Req() req: Request, @Res() res: Response): Promise<void> {
		const expected = process.env.BRIDGE_HINT_SECRET || "";
		const given = String(req.headers["x-hint-secret"] || "");
		if (expected && given !== expected) {
			res.status(HttpStatus.UNAUTHORIZED).json({ error: "unauthorized" });
			return;
		}
		const body = (req.body || {}) as { customerUuid?: string; text?: string };
		const customerUuid = String(body.customerUuid || "").trim();
		const text = String(body.text || "").trim();
		if (!customerUuid || !text) {
			res.status(HttpStatus.BAD_REQUEST).json({ error: "customerUuid and text required" });
			return;
		}
		try {
			const result = await this.bitrix24Service.addTranscriptToB24(customerUuid, text);
			res.json(result);
		} catch (error: any) {
			this.logger.warn(`transcript-to-b24 failed: ${error.message}`);
			res.status(HttpStatus.OK).json({ ok: false, reason: error.message });
		}
	}

	// Internal endpoint: резолвит лид/контакт B24 по идентификаторам клиента
	// Customer-360 (uuid / tgChatId / maxChatId / phone). Используется
	// KBD-карточкой wa-tg-bridge для кликабельных ссылок. Auth: X-Hint-Secret.
	@Post("internal/b24-entities")
	@HttpCode(HttpStatus.OK)
	async b24Entities(@Req() req: Request, @Res() res: Response): Promise<void> {
		const expected = process.env.BRIDGE_HINT_SECRET || "";
		const given = String(req.headers["x-hint-secret"] || "");
		if (expected && given !== expected) {
			res.status(HttpStatus.UNAUTHORIZED).json({ error: "unauthorized" });
			return;
		}
		const body = (req.body || {}) as {
			uuid?: string; phone?: string; tgChatId?: string; maxChatId?: string;
		};
		try {
			const result = await this.bitrix24Service.resolveB24Entities({
				uuid: body.uuid,
				phone: body.phone,
				tgChatId: body.tgChatId,
				maxChatId: body.maxChatId,
			});
			res.json(result);
		} catch (error: any) {
			this.logger.warn(`b24-entities failed: ${error.message}`);
			res.status(HttpStatus.OK).json({ leadId: null, contactId: null });
		}
	}

	// Internal endpoint: установить PHOTO у B24-контакта/лида (если поле пустое).
	// Используется avatar_sync воркером wa-tg-bridge: он скачивает аватарку
	// из мессенджера и шлёт base64 сюда. Auth: X-Hint-Secret.
	@Post("internal/b24-set-photo")
	@HttpCode(HttpStatus.OK)
	async setB24Photo(@Req() req: Request, @Res() res: Response): Promise<void> {
		const expected = process.env.BRIDGE_HINT_SECRET || "";
		const given = String(req.headers["x-hint-secret"] || "");
		if (expected && given !== expected) {
			res.status(HttpStatus.UNAUTHORIZED).json({ error: "unauthorized" });
			return;
		}
		const body = (req.body || {}) as {
			kind?: string; id?: number; filename?: string; base64?: string;
		};
		const kind = body.kind === "lead" ? "lead" : "contact";
		const id = Number(body.id);
		const filename = String(body.filename || "avatar.jpg");
		const base64 = String(body.base64 || "");
		if (!id || !base64) {
			res.status(HttpStatus.BAD_REQUEST).json({ error: "id and base64 required" });
			return;
		}
		try {
			const result = await this.bitrix24Service.setEntityPhotoIfEmpty(
				kind, id, filename, base64,
			);
			res.json(result);
		} catch (e: any) {
			this.logger.error(`b24-set-photo failed: ${e.message}`);
			res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
				result: "skipped", reason: e.message,
			});
		}
	}

	// Internal endpoint: backfill pinned-карточек в существующих IG-топиках.
	// Идёт фоновой задачей с rate-limit delay_sec секунд между топиками.
	// Идемпотентен через state.pinnedCards. Auth: X-Hint-Secret.
	@Post("internal/backfill-ig-pinned-cards")
	@HttpCode(HttpStatus.OK)
	async backfillIgPinnedCards(@Req() req: Request, @Res() res: Response): Promise<void> {
		const expected = process.env.BRIDGE_HINT_SECRET || "";
		const given = String(req.headers["x-hint-secret"] || "");
		if (expected && given !== expected) {
			res.status(HttpStatus.UNAUTHORIZED).json({ error: "unauthorized" });
			return;
		}
		const body = (req.body || {}) as { delay_sec?: number };
		const delaySec = Math.max(5, Number(body.delay_sec) || 30);
		// Запускаем фоновой задачей, отвечаем сразу.
		this.i2crmTgMirror.backfillExistingTopicCards(delaySec).then(
			(r) => this.logger.info(`IG backfill done: ${JSON.stringify(r)}`),
			(e) => this.logger.error(`IG backfill failed: ${e.message}`),
		);
		res.json({ started: true, delay_sec: delaySec });
	}

	// B24 event.bind webhook: принимает события ONCRMLEADADD/UPDATE и т.д.
	// Зарегистрированы через /internal/register-b24-events.
	// Безопасность: проверяем auth.application_token соответствует тому, что
	// мы сохранили при OAuth install (User.applicationToken). B24 шлёт его
	// в payload каждого event.bind webhook'а — если совпадает, это легитимный
	// колбэк от нашего портала. Иначе — мусор от стороннего источника, skip
	// (без 401 — B24 ретраил бы и засорял логи).
	@Post("b24-event")
	@HttpCode(HttpStatus.OK)
	async b24Event(@Req() req: Request, @Res() res: Response): Promise<void> {
		// ACK сразу — B24 ждёт быстрый 200 OK иначе ретраит
		res.json({ result: true });
		const rawEvent = String(req.query?.event || req.body?.event || "").toUpperCase();
		const auth = (req.body && (req.body as any).auth) || {};
		const portalDomain = String(auth.domain || "").trim();
		const applicationToken = String(auth.application_token || "").trim();
		if (!portalDomain || !applicationToken) {
			this.logger.warn(`b24-event ${rawEvent} rejected: missing auth.domain or auth.application_token`);
			return;
		}
		try {
			const user = await this.prisma.findUser(portalDomain);
			if (!user) {
				this.logger.warn(`b24-event ${rawEvent} rejected: unknown portal ${portalDomain}`);
				return;
			}
			if (user.applicationToken !== applicationToken) {
				this.logger.warn(
					`b24-event ${rawEvent} rejected: application_token mismatch for ${portalDomain}`,
				);
				return;
			}
		} catch (e: any) {
			this.logger.error(`b24-event ${rawEvent} auth-check failed: ${e.message}`);
			return;
		}
		try {
			const result = await this.bitrix24Service.handleB24CrmEvent(rawEvent, req.body);
			if (!result.ok) {
				this.logger.warn(`b24-event ${rawEvent} skipped: ${result.reason}`);
			}
		} catch (error: any) {
			this.logger.error(`b24-event ${rawEvent} failed: ${error.message}`);
		}
	}

	// Internal endpoint: запустить orphan-lead linker на конкретном лиде.
	// Используется для постфактум-починки лидов созданных через native
	// B24 OpenLine UI (см. task #68 / ADR 2026-05-26-orphan-lead-linker).
	// Сам код тот же что в ONCRMLEADADD path, но входная точка — REST.
	// Auth: X-Hint-Secret.
	@Post("internal/relink-orphan-lead")
	@HttpCode(HttpStatus.OK)
	async relinkOrphanLead(@Req() req: Request, @Res() res: Response): Promise<void> {
		const expected = process.env.BRIDGE_HINT_SECRET || "";
		const given = String(req.headers["x-hint-secret"] || "");
		if (expected && given !== expected) {
			res.status(HttpStatus.UNAUTHORIZED).json({ error: "unauthorized" });
			return;
		}
		const leadId = Number((req.body || {}).leadId);
		if (!leadId) {
			res.status(HttpStatus.BAD_REQUEST).json({ error: "leadId required" });
			return;
		}
		try {
			const result = await this.bitrix24Service.relinkOrphanLeadById(leadId);
			res.json({ leadId, ...result });
		} catch (error: any) {
			this.logger.error(`relink-orphan-lead failed: ${error.message}`);
			res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: error.message });
		}
	}

	// Internal endpoint: постфактум-перенос UF_CRM_*_CHAT_ID с уже
	// сконвертированного лида на привязанный контакт (task #69 / ADR
	// 2026-05-26-convert-propagate-chat-ids). Используется для починки
	// кейсов произошедших до деплоя listener'а. Auth: X-Hint-Secret.
	@Post("internal/propagate-chat-ids")
	@HttpCode(HttpStatus.OK)
	async propagateChatIds(@Req() req: Request, @Res() res: Response): Promise<void> {
		const expected = process.env.BRIDGE_HINT_SECRET || "";
		const given = String(req.headers["x-hint-secret"] || "");
		if (expected && given !== expected) {
			res.status(HttpStatus.UNAUTHORIZED).json({ error: "unauthorized" });
			return;
		}
		const leadId = Number((req.body || {}).leadId);
		if (!leadId) {
			res.status(HttpStatus.BAD_REQUEST).json({ error: "leadId required" });
			return;
		}
		try {
			const result = await this.bitrix24Service.propagateChatIdsByLeadId(leadId);
			res.json({ leadId, ...result });
		} catch (error: any) {
			this.logger.error(`propagate-chat-ids failed: ${error.message}`);
			res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: error.message });
		}
	}

	// Internal endpoint: одноразово регистрирует все CRM event.bind через
	// OAuth-токен adapter'а. Идемпотентно. Auth: X-Hint-Secret.
	@Post("internal/register-b24-events")
	@HttpCode(HttpStatus.OK)
	async registerB24Events(@Req() req: Request, @Res() res: Response): Promise<void> {
		const expected = process.env.BRIDGE_HINT_SECRET || "";
		const given = String(req.headers["x-hint-secret"] || "");
		if (expected && given !== expected) {
			res.status(HttpStatus.UNAUTHORIZED).json({ error: "unauthorized" });
			return;
		}
		const handlerBaseUrl = (req.body?.handlerBaseUrl || process.env.B24_EVENTS_HANDLER_BASE || "https://social.9wb.ru").replace(/\/+$/, "");
		try {
			const result = await this.bitrix24Service.registerB24CrmEvents(handlerBaseUrl);
			res.json({ handlerBaseUrl, result });
		} catch (error: any) {
			this.logger.error(`register-b24-events failed: ${error.message}`);
			res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: error.message });
		}
	}

	// Internal endpoint: один батч бэкфилла UF_CRM_PB_CUSTOMER_UUID. Запускается
	// по cron каждые 15 минут (через systemd timer на сервере). Делает по 20
	// entity за раз с rate-limit 2 sec → 40 sec/батч, нагрузка минимальная.
	// Auth: X-Hint-Secret.
	@Post("internal/sync-customer-uuid")
	@HttpCode(HttpStatus.OK)
	async syncCustomerUuid(@Req() req: Request, @Res() res: Response): Promise<void> {
		const expected = process.env.BRIDGE_HINT_SECRET || "";
		const given = String(req.headers["x-hint-secret"] || "");
		if (expected && given !== expected) {
			res.status(HttpStatus.UNAUTHORIZED).json({ error: "unauthorized" });
			return;
		}
		const body = (req.body || {}) as {
			entity?: "lead" | "contact" | "both";
			limit?: number;
			rateMsec?: number;
		};
		const entity = body.entity || "both";
		const limit = body.limit;
		const rateMsec = body.rateMsec;
		try {
			const results: any[] = [];
			if (entity === "lead" || entity === "both") {
				results.push(
					await this.bitrix24Service.syncCustomerUuidBatch({ entity: "lead", limit, rateMsec }),
				);
			}
			if (entity === "contact" || entity === "both") {
				results.push(
					await this.bitrix24Service.syncCustomerUuidBatch({ entity: "contact", limit, rateMsec }),
				);
			}
			res.json({ results });
		} catch (error: any) {
			this.logger.error(`sync-customer-uuid failed: ${error.message}`);
			res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: error.message });
		}
	}

	// Internal endpoint: идемпотентно создать UF_CRM_PB_CUSTOMER_UUID на lead /
	// contact / deal. Используется один раз при инициализации Customer-360
	// (Этап 1). Auth: X-Hint-Secret.
	@Post("internal/init-uf-fields")
	@HttpCode(HttpStatus.OK)
	async initUfFields(@Req() req: Request, @Res() res: Response): Promise<void> {
		const expected = process.env.BRIDGE_HINT_SECRET || "";
		const given = String(req.headers["x-hint-secret"] || "");
		if (expected && given !== expected) {
			res.status(HttpStatus.UNAUTHORIZED).json({ error: "unauthorized" });
			return;
		}
		const fieldName = "UF_CRM_PB_CUSTOMER_UUID";
		const opts = { label: "Customer UUID", xmlId: "PB_CUSTOMER_UUID", maxLength: 36 };
		try {
			const [lead, contact, deal] = await Promise.all([
				this.bitrix24Service.ensureUfField("lead", fieldName, opts),
				this.bitrix24Service.ensureUfField("contact", fieldName, opts),
				this.bitrix24Service.ensureUfField("deal", fieldName, opts),
			]);
			res.json({ lead, contact, deal });
		} catch (error: any) {
			this.logger.error(`init-uf-fields failed: ${error.message}`);
			res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: error.message });
		}
	}

	// Internal endpoint: массовое переименование всех IG-тем (refresh_all для IG).
	// Идёт по state.topics в i2crm-tg-mirror, для каждой темы дёргает B24 за
	// актуальным ФИО, формирует новое имя в текущем формате и edit'ит топик.
	// Fire-and-forget: задача запускается в фоне, endpoint возвращает started:true
	// сразу. Прогресс/итог — в логах adapter'а (level=info). Auth: X-Hint-Secret.
	@Post("internal/refresh-ig-topics")
	@HttpCode(HttpStatus.OK)
	async refreshIgTopics(@Req() req: Request, @Res() res: Response): Promise<void> {
		const expected = process.env.BRIDGE_HINT_SECRET || "";
		const given = String(req.headers["x-hint-secret"] || "");
		if (expected && given !== expected) {
			res.status(HttpStatus.UNAUTHORIZED).json({ error: "unauthorized" });
			return;
		}
		const body = (req.body || {}) as { channel?: string; accountName?: string };
		this.i2crmTgMirror.refreshAllTopics({
			channel: body.channel,
			accountName: body.accountName,
		}).then(
			(r) => this.logger.info(`refresh-ig-topics done: ${JSON.stringify(r)}`),
			(e) => this.logger.error(`refresh-ig-topics failed: ${e.message}`),
		);
		res.json({ started: true });
	}

	// Internal endpoint: массовое переименование тем-зеркал TG-ботов
	// (@begovoy_bot, @begovoy1support_bot, ...). Приводит к стандарту
	// «TG · <botName> · <ФИО из B24>». Auth: X-Hint-Secret.
	// Body: {botName?: "begovoy" | "support"} — фильтр по конкретному боту,
	// по умолчанию обрабатываются темы всех ботов.
	// Fire-and-forget — см. refreshIgTopics.
	@Post("internal/refresh-tg-bot-topics")
	@HttpCode(HttpStatus.OK)
	async refreshTgBotTopics(@Req() req: Request, @Res() res: Response): Promise<void> {
		const expected = process.env.BRIDGE_HINT_SECRET || "";
		const given = String(req.headers["x-hint-secret"] || "");
		if (expected && given !== expected) {
			res.status(HttpStatus.UNAUTHORIZED).json({ error: "unauthorized" });
			return;
		}
		const body = (req.body || {}) as { botName?: string };
		this.tgBotMirror.refreshAllTopics({
			botName: body.botName,
		}).then(
			(r) => this.logger.info(`refresh-tg-bot-topics done: ${JSON.stringify(r)}`),
			(e) => this.logger.error(`refresh-tg-bot-topics failed: ${e.message}`),
		);
		res.json({ started: true });
	}

	// Internal endpoint: повторная доставка pending-событий i2crm в B24.
	// Используется после восстановления B24 из OVERLOAD_LIMIT — webhook'и от i2crm
	// уже сохранены в I2crmEventLog со status='pending', этот вызов берёт их
	// (FIFO по receivedAt) и пробует доставить ещё раз. Auth: X-Hint-Secret.
	@Post("internal/i2crm-replay")
	@HttpCode(HttpStatus.OK)
	async replayI2crm(@Req() req: Request, @Res() res: Response): Promise<void> {
		const expected = process.env.BRIDGE_HINT_SECRET || "";
		const given = String(req.headers["x-hint-secret"] || "");
		if (expected && given !== expected) {
			res.status(HttpStatus.UNAUTHORIZED).json({ error: "unauthorized" });
			return;
		}
		const body = (req.body || {}) as { limit?: number; since?: string; dryRun?: boolean };

		let since: Date | undefined;
		if (body.since) {
			const d = new Date(body.since);
			if (isNaN(d.getTime())) {
				res.status(HttpStatus.BAD_REQUEST).json({ error: "invalid since (expected ISO8601)" });
				return;
			}
			since = d;
		}

		try {
			const result = await this.bitrix24Service.replayPendingI2crmEvents({
				limit: body.limit,
				since,
				dryRun: body.dryRun === true,
			});
			res.json(result);
		} catch (error: any) {
			this.logger.error(`i2crm-replay failed: ${error.message}`);
			res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: error.message });
		}
	}

	private mapError(error: any) {
		const mappings = [
			{
				pattern: "Missing required parameters",
				status: HttpStatus.BAD_REQUEST,
				message: "Please ensure all required fields are filled correctly.",
			},
			{
				pattern: "Invalid instance ID",
				status: HttpStatus.BAD_REQUEST,
				message: "Instance ID must be 10-12 digits. Please check your GREEN-API console.",
			},
			{
				pattern: "Invalid API token",
				status: HttpStatus.BAD_REQUEST,
				message: "API token seems invalid. Please check your GREEN-API console.",
			},
			{
				pattern: "User not found",
				status: HttpStatus.NOT_FOUND,
				message: "Please reinstall the Bitrix24 app from the Market.",
			},
			{
				pattern: "GREEN-API validation failed",
				status: HttpStatus.BAD_REQUEST,
				message: "Invalid GREEN-API credentials. Please verify your Instance ID and API Token.",
			},
			{pattern: "is already being used by different line", status: HttpStatus.CONFLICT, message: error.message},
			{
				pattern: "Authentication failed",
				status: HttpStatus.UNAUTHORIZED,
				message: "Your Bitrix24 authentication has expired. Please reinstall the app from Bitrix24 Market.",
			},
			{
				pattern: "Token expired",
				status: HttpStatus.UNAUTHORIZED,
				message: "Your Bitrix24 session has expired. Please refresh the page and try again.",
			},
			{
				pattern: "BITRIX24_API_ERROR",
				status: HttpStatus.BAD_GATEWAY,
				message: "Failed to communicate with Bitrix24. Please try again.",
			},
		];

		const match = mappings.find(m => error.message.includes(m.pattern));
		const statusCode = match?.status || HttpStatus.INTERNAL_SERVER_ERROR;
		const message = match?.message || "Configuration failed. Please try again.";

		return {
			statusCode,
			body: {
				success: false,
				message,
				error: match?.pattern || "An unexpected error occurred",
				details: process.env.NODE_ENV === "development" ? {originalMessage: error.message} : undefined,
			},
		};
	}
}