import { Controller, Post, Body, HttpCode, HttpStatus, Req, Res, UseGuards } from "@nestjs/common";
import { Request, Response } from "express";
import { Bitrix24Service } from "../bitrix24/bitrix24.service";
import { I2crmTgMirrorService } from "../bitrix24/i2crm-tg-mirror.service";
import { GreenApiWebhook, GreenApiLogger } from "@green-api/greenapi-integration";
import { Bitrix24WebhookDto } from "../bitrix24/dto/bitrix24-webhook.dto";
import { Bitrix24WebhookGuard } from "./guards/bitrix24-webhook.guard";

// i2crm посылает client_id, message_id, external_id и пр. как 64-bit integers
// (могут быть > 2^53). JSON.parse в Node превращает их в Number и теряет
// точность последних цифр. Преобразуем их в строки ДО JSON.parse через regex
// над сырым текстом — единственный способ сохранить точное значение.
const BIG_INT_FIELDS = /(\"(?:client_id|message_id|external_id|account_id|media_id|comment_id|id|account|client)\"\s*:\s*)(\d{15,})/g;

function safeJsonParse(rawText: string): any {
	const safe = rawText.replace(BIG_INT_FIELDS, '$1"$2"');
	return JSON.parse(safe);
}

@Controller("webhooks")
export class WebhooksController {
	private readonly logger = GreenApiLogger.getInstance(WebhooksController.name);

	constructor(
		private readonly bitrix24Service: Bitrix24Service,
		private readonly i2crmTgMirror: I2crmTgMirrorService,
	) {}

	@Post("green-api")
	@HttpCode(HttpStatus.OK)
	async handleGreenApiWebhook(@Body() webhook: GreenApiWebhook, @Res() res: Response): Promise<void> {
		this.logger.debug(`Green API webhook received: ${webhook.typeWebhook}`);

		res.status(HttpStatus.OK).send();

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

	@Post("bitrix24")
	@UseGuards(Bitrix24WebhookGuard)
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
		const body = (req.body || {}) as { phone?: string; igClientId?: string };
		try {
			const result = await this.bitrix24Service.getContactName(body);
			res.json(result);
		} catch (error: any) {
			this.logger.error(`contact-name lookup failed: ${error.message}`);
			res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: error.message });
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
	// Auth: тот же X-Hint-Secret.
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
		try {
			const result = await this.i2crmTgMirror.refreshAllTopics({
				channel: body.channel,
				accountName: body.accountName,
			});
			res.json(result);
		} catch (error: any) {
			this.logger.error(`refresh-ig-topics failed: ${error.message}`);
			res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: error.message });
		}
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