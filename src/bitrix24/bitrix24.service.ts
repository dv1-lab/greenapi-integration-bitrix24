import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios, { AxiosInstance } from "axios";

import { greenApiUrl as greenApiUrlForInstance } from "../common/green-api-url";
import {
	BaseAdapter,
	IntegrationError,
	NotFoundError,
	Settings,
	StateInstanceWebhook,
	GreenApiLogger, SendResponse, generateRandomToken, GreenApiWebhook,
} from "@green-api/greenapi-integration";
import { Bitrix24Transformer } from "./bitrix24.transformer";
import { I2crmTgMirrorService } from "./i2crm-tg-mirror.service";
import { TgBotMirrorService } from "./tg-bot-mirror.service";
import { MediaCacheService } from "./media-cache.service";
import { PrismaService } from "../prisma/prisma.service";
import {
	Bitrix24MessagePayload,
	Bitrix24PlatformMessage,
	ConnectorConfigurationRequest, ConnectorConfigurationResponse,
	WebhookProcessResult,
} from "../types";
import { Bitrix24WebhookDto } from "./dto/bitrix24-webhook.dto";
import type { Instance, User } from "@prisma/client";
import { mask } from "../common/mask";
import {
	validateI2crmIncoming,
	buildI2crmUserId,
	buildI2crmChatId,
	envKeyForI2crmLine,
	buildI2crmFinalText,
	extractI2crmMediaFile,
	extractB24SessionInfo,
	normalizePhoneE164,
	formatI2crmQuoted,
	type I2crmChannel,
} from "../common/i2crm-payload";
import {
	shouldSkipOutgoingStatus,
	isValidOutgoingStatus,
	isOutgoingExpired,
} from "../common/outgoing-status";
import * as emoji from "node-emoji";

export interface EnsureLeadResult {
	contactId?: number;
	contactName?: string;
	contactLastName?: string;
	createdLeadId?: number;
	customerUuid?: string;
}

// Автоответ на входящие в нерабочее время. Магазин работает ежедневно
// 10:00–19:00 МСК; вне этого окна клиент получает это сообщение один раз
// за нерабочий период (см. maybeOffHoursAutoReply).
const OFF_HOURS_REPLY_TEXT =
	"Здравствуйте! Спасибо, что написали в «Первый Беговой» 🙌\n\n" +
	"Сейчас нерабочее время — мы на связи ежедневно с 10:00 до 19:00 по Москве.\n\n" +
	"Ваше сообщение получено, менеджер обязательно ответит вам в рабочие часы. " +
	"Вы можете прямо сейчас задать здесь все интересующие вопросы — мы ответим " +
	"на них, как только начнётся рабочий день.";

// TTL для записи OutgoingMessage: Green API после доставки не шлёт более
// чем 24 часа.
const OUTGOING_MAP_TTL_MS = 24 * 3600 * 1000;

// Per-portal mutex для token refresh — без него два concurrent 401-ответа
// (например, две параллельные imconnector.send.messages на один портал)
// оба запустили бы refreshAccessToken, перезатёрли друг друга в БД и
// пошли retry'ить с разными токенами. См. agent-аудит 2026-05-19.
type RefreshKey = string;  // portalDomain или portalDomain:appKind
const _refreshLocks: Map<RefreshKey, Promise<string>> = new Map();

// Авто-поля времени B24 — меняются при каждом касании сущности. Исключаем из
// диф-сравнения снимков, иначе любое ONCRM*UPDATE выглядит как «изменилось»
// и дедупликация событий не работает.
const SNAPSHOT_IGNORE_FIELDS = new Set<string>([
	"ID", "DATE_MODIFY", "TIMESTAMP_X", "MODIFY_BY_ID",
	"LAST_ACTIVITY_TIME", "LAST_ACTIVITY_BY", "LAST_COMMUNICATION_TIME",
	"MOVED_TIME", "MOVED_BY_ID", "DATE_CREATE", "DATE_CLOSED",
	// STATUS_SEMANTIC_ID (P/F/S) — внутренний дубль статуса; меняется вместе
	// со STATUS_ID, отдельной строкой в ленте только шумит.
	"STATUS_SEMANTIC_ID",
]);

// RU-подписи частых полей CRM-сущностей для диф-сообщений «было → стало».
// Неизвестные поля (в т.ч. UF_*) показываются сырым именем.
const FIELD_LABELS: Record<string, string> = {
	STATUS_ID: "Статус", STAGE_ID: "Стадия", ASSIGNED_BY_ID: "Ответственный",
	CREATED_BY_ID: "Создал", TITLE: "Название", NAME: "Имя",
	LAST_NAME: "Фамилия", SECOND_NAME: "Отчество", OPPORTUNITY: "Сумма",
	CURRENCY_ID: "Валюта", SOURCE_ID: "Источник",
	SOURCE_DESCRIPTION: "Описание источника", STATUS_DESCRIPTION: "Описание статуса",
	COMMENTS: "Комментарий", COMPANY_TITLE: "Компания", POST: "Должность",
	PHONE: "Телефон", EMAIL: "E-mail", WEB: "Сайт", IM: "Мессенджер",
	OPENED: "Доступен всем", BEGINDATE: "Дата начала", CLOSEDATE: "Дата завершения",
	IS_RETURN_CUSTOMER: "Повторное обращение", ADDRESS: "Адрес",
	UTM_SOURCE: "UTM source", UTM_MEDIUM: "UTM medium", UTM_CAMPAIGN: "UTM campaign",
};

@Injectable()
export class Bitrix24Service extends BaseAdapter<
	Bitrix24WebhookDto,
	Bitrix24PlatformMessage,
	User,
	Instance
> {
	private readonly logger = GreenApiLogger.getInstance(Bitrix24Service.name);
	private _outgoingCleanupInterval: NodeJS.Timeout | null = null;
	private _tokenRefreshInterval: NodeJS.Timeout | null = null;
	// Initial setTimeout handles — отменяем в onModuleDestroy, иначе
	// зависают в event loop (в тестах ловятся как «log after tests done»).
	private _outgoingCleanupKickoff: NodeJS.Timeout | null = null;
	private _tokenRefreshKickoff: NodeJS.Timeout | null = null;

	constructor(
		protected readonly bitrix24Transformer: Bitrix24Transformer,
		protected readonly prisma: PrismaService,
		private readonly configService: ConfigService,
		private readonly i2crmTgMirror: I2crmTgMirrorService,
		private readonly tgBotMirror: TgBotMirrorService,
		private readonly mediaCache: MediaCacheService,
	) {
		super(bitrix24Transformer, prisma);
		// В юнит-тестах не запускаем фоновые таймеры — иначе они срабатывают
		// после teardown'а Prisma-mock'а и Jest ловит log-after-tests warning.
		if (process.env.NODE_ENV === "test") {
			return;
		}
		// Cleanup expired OutgoingMessage записей раз в час. Делаем через
		// setInterval а не cron, чтобы не вводить новую инфру. Первый запуск
		// через 5 минут после старта (даём миграциям прокатиться).
		this._outgoingCleanupInterval = setInterval(
			() => { void this.cleanupExpiredOutgoingMessages(); },
			60 * 60 * 1000,
		);
		this._outgoingCleanupKickoff = setTimeout(
			() => { void this.cleanupExpiredOutgoingMessages(); }, 5 * 60 * 1000,
		);
		// Проактивное обновление B24-токена: рефрешим заранее, до истечения.
		// Без этого токен протухал в БД между ленивыми refresh-on-401, и
		// read-only потребители (calls-poll синхронизатора звонков берёт токен
		// из той же User-строки) ловили expired_token.
		this._tokenRefreshInterval = setInterval(
			() => { void this._proactiveTokenRefresh(); },
			15 * 60 * 1000,
		);
		this._tokenRefreshKickoff = setTimeout(
			() => { void this._proactiveTokenRefresh(); }, 60 * 1000,
		);
	}

	onModuleDestroy() {
		if (this._outgoingCleanupKickoff) {
			clearTimeout(this._outgoingCleanupKickoff);
			this._outgoingCleanupKickoff = null;
		}
		if (this._tokenRefreshKickoff) {
			clearTimeout(this._tokenRefreshKickoff);
			this._tokenRefreshKickoff = null;
		}
		if (this._outgoingCleanupInterval) {
			clearInterval(this._outgoingCleanupInterval);
			this._outgoingCleanupInterval = null;
		}
		if (this._tokenRefreshInterval) {
			clearInterval(this._tokenRefreshInterval);
			this._tokenRefreshInterval = null;
		}
	}

	private async refreshAccessToken(user: User, minTtlMs = 30_000): Promise<string> {
		if (!user.refreshToken) {
			throw new IntegrationError("No refresh token available", "UNAUTHORIZED");
		}
		const key: RefreshKey = `${user.portalDomain}:social`;
		const existing = _refreshLocks.get(key);
		if (existing) {
			// Кто-то уже рефрешит — ждём его результат вместо параллельного запуска.
			return existing;
		}
		const promise = (async () => {
			try {
				// Re-read user из БД — другой инстанс мог уже обновить токен.
				const fresh = await this.prisma.findUser(user.portalDomain);
				if (fresh && fresh.tokenExpiresAt && new Date(fresh.tokenExpiresAt).getTime() > Date.now() + minTtlMs) {
					this.logger.info(`Token fresh for ${user.portalDomain} (TTL>${Math.round(minTtlMs / 1000)}s), skip refresh`);
					return fresh.accessToken;
				}
				const response = await axios.post(`https://oauth.bitrix.info/oauth/token/`, null, {
					params: {
						grant_type: "refresh_token",
						client_id: this.configService.get<string>("BITRIX24_CLIENT_ID"),
						client_secret: this.configService.get<string>("BITRIX24_CLIENT_SECRET"),
						refresh_token: user.refreshToken,
					},
				});
				const {access_token, refresh_token, expires_in} = response.data;
				const expiresAt = expires_in ? new Date(Date.now() + expires_in * 1000) : undefined;
				await this.prisma.updateUserTokens(
					user.id,
					access_token,
					refresh_token,
					expiresAt,
				);
				this.logger.info(`Token refreshed for portal: ${user.portalDomain}`);
				return access_token;
			} catch (error: any) {
				this.logger.error(
					`Failed to refresh token for ${user.portalDomain}:`,
					mask(error.response?.data || { message: error.message }) as any,
				);
				throw new IntegrationError("Failed to refresh access token", "UNAUTHORIZED");
			}
		})();
		_refreshLocks.set(key, promise);
		try {
			return await promise;
		} finally {
			_refreshLocks.delete(key);
		}
	}

	/**
	 * Проактивное обновление B24-токена: если до истечения < 15 мин — рефрешим
	 * заранее. Иначе токен протухал в БД между ленивыми refresh-on-401, и
	 * read-only потребители (calls-poll customer-360 берёт accessToken из той
	 * же User-строки) ловили expired_token. Запускается по интервалу из
	 * конструктора.
	 */
	private async _proactiveTokenRefresh(): Promise<void> {
		try {
			const users = await (this.prisma as any).user.findMany({ take: 1 });
			const user = users[0];
			if (!user) return;
			await this.refreshAccessToken(user, 15 * 60 * 1000);
		} catch (e: any) {
			this.logger.warn(`proactive token refresh failed: ${e?.message || e}`);
		}
	}

	private async _refreshOAuthAppToken(app: any): Promise<string> {
		if (!app?.refreshToken) {
			throw new IntegrationError("No refresh token for OAuth app", "UNAUTHORIZED");
		}
		const key: RefreshKey = `${app.portalDomain}:${app.appKind}`;
		const existing = _refreshLocks.get(key);
		if (existing) {
			return existing;
		}
		const promise = (async () => {
			try {
				// Re-read app из БД — другой запрос мог уже обновить токен.
				const fresh = await this.prisma.findOAuthApp(app.portalDomain, app.appKind);
				if (fresh && fresh.tokenExpiresAt && new Date(fresh.tokenExpiresAt).getTime() > Date.now() + 30_000) {
					this.logger.info(`OAuthApp[${app.appKind}] token already fresh for ${app.portalDomain}, skip refresh`);
					return fresh.accessToken;
				}
				const response = await axios.post(`https://oauth.bitrix.info/oauth/token/`, null, {
					params: {
						grant_type: "refresh_token",
						client_id: app.clientId,
						client_secret: app.clientSecret,
						refresh_token: app.refreshToken,
					},
				});
				const { access_token, refresh_token, expires_in } = response.data;
				const expiresAt = expires_in ? new Date(Date.now() + expires_in * 1000) : undefined;
				await this.prisma.updateOAuthAppTokens(
					app.portalDomain, app.appKind, access_token, refresh_token, expiresAt,
				);
				this.logger.info(`OAuthApp[${app.appKind}] token refreshed for ${app.portalDomain}`);
				return access_token;
			} catch (error: any) {
				this.logger.error(
					`Failed to refresh OAuthApp[${app.appKind}] token for ${app.portalDomain}:`,
					mask(error.response?.data || { message: error.message }) as any,
				);
				throw new IntegrationError("Failed to refresh OAuth app token", "UNAUTHORIZED");
			}
		})();
		_refreshLocks.set(key, promise);
		try {
			return await promise;
		} finally {
			_refreshLocks.delete(key);
		}
	}

	private async callBitrix24Method(
		portalDomain: string,
		method: string,
		params: Record<string, any> = {},
		accessToken?: string,
		retryCount: number = 0,
		appKind: "social" | "customer360" = "social",
	): Promise<unknown> {
		// Customer-360 split (см. memory customer_360_split_b24): если для этого
		// портала установлено отдельное приложение `customer360`, используем его
		// токен для CRM-операций. Иначе fallback на стандартного social User —
		// это даёт graceful degradation пока split не настроен в B24 admin.
		let app: any = null;
		let user: User | null = null;
		if (!accessToken && appKind === "customer360") {
			app = await this.prisma.findOAuthApp(portalDomain, "customer360");
		}
		if (!app) {
			user = await this.prisma.findUser(portalDomain);
		}
		let token = accessToken || app?.accessToken || user?.accessToken;

		if (!token) {
			throw new IntegrationError(`No access token for portal ${portalDomain}`, "UNAUTHORIZED");
		}

		try {
			const url = `https://${portalDomain}/rest/${method}?auth=${token}`;
			// Маскируем токен в логах — он попадает в docker logs/transcript.
			const safeUrl = url.replace(/(auth=)[^&]+/, "$1<masked>");
			this.logger.debug(`Calling Bitrix24 method: ${method}`, {url: safeUrl, params, app: app ? "customer360" : "social"});

			const response = await axios.post(url, params);

			// Логируем результат для диагностики (особенно полезно для imconnector.send.messages,
			// где B24 возвращает per-message статусы — успех ≠ привязка к CRM).
			if (method === "imconnector.send.messages") {
				this.logger.info(`B24 response for ${method}`, {result: response.data?.result});
			}

			if (response.data.error) {
				if (response.data.error === "expired_token" && retryCount === 0) {
					this.logger.warn(`Token expired for ${portalDomain} (${app ? "customer360" : "social"}), attempting refresh...`);
					try {
						let newToken: string;
						if (app?.refreshToken) {
							newToken = await this._refreshOAuthAppToken(app);
						} else if (user?.refreshToken) {
							newToken = await this.refreshAccessToken(user);
						} else {
							throw new Error("No refresh token");
						}
						return this.callBitrix24Method(portalDomain, method, params, newToken, retryCount + 1, appKind);
					} catch (refreshError) {
						this.logger.error(`Token refresh failed for ${portalDomain}:`, refreshError);
						throw new IntegrationError("Authentication failed - please reinstall the app", "UNAUTHORIZED");
					}
				}
				throw new Error(`Bitrix24 API Error: ${response.data.error_description || response.data.error}`);
			}

			return response.data.result;
		} catch (error: any) {
			if (error.response?.status === 401 && retryCount === 0) {
				this.logger.warn(`HTTP 401 error for ${portalDomain} (${app ? "customer360" : "social"}), attempting token refresh...`);
				try {
					let newToken: string;
					if (app?.refreshToken) {
						newToken = await this._refreshOAuthAppToken(app);
					} else if (user?.refreshToken) {
						newToken = await this.refreshAccessToken(user);
					} else {
						throw new Error("No refresh token");
					}
					return this.callBitrix24Method(portalDomain, method, params, newToken, retryCount + 1, appKind);
				} catch (refreshError) {
					this.logger.error(`Token refresh failed for ${portalDomain}:`, refreshError);
					throw new IntegrationError("Authentication failed - please reinstall the app", "UNAUTHORIZED");
				}
			}

			this.logger.error(`Bitrix24 API call failed: ${method}`, error.response?.data || error.message);
			throw new IntegrationError(
				`Bitrix24 API call failed: ${error.message}`,
				"BITRIX24_API_ERROR",
				error.response?.status || 500,
			);
		}
	}

	async createPlatformClient(_portalDomain: string): Promise<AxiosInstance> {
		return axios.create();
	}

	// ===== health-check helpers ==========================================
	// Используются B24HealthCheckService — проверяют что коннектор
	// social_connector зарегистрирован в портале и активирован на каждой
	// маппированной линии. Инкапсулируют callBitrix24Method (он private),
	// чтобы health-check не знал о token refresh / retry.

	/**
	 * imconnector.list → массив CONNECTOR ID, зарегистрированных в портале.
	 * Возвращает [] при ошибке (не throw'аем — health-check сам логирует).
	 */
	/**
	 * Публичный wrapper для widget — отправка зеркала в B24 open line через
	 * imconnector.send.messages с OAuth-токеном Social Connector V2 из БД.
	 * Inbound webhook для этого метода не работает («Application context required»),
	 * нужен именно app-OAuth.
	 */
	async sendImconnectorMessage(portalDomain: string, payload: Record<string, any>): Promise<unknown> {
		return this.callBitrix24Method(portalDomain, "imconnector.send.messages", payload);
	}

	/**
	 * Auto-take open-line session для оператора (фикс #47 widget MAX).
	 *
	 * Корень #47: после `imconnector.send.messages` B24 создаёт chat-user `sc_<id>`
	 * и сессию, но она висит в очереди «Неотвеченные» — пока кто-то явно её не
	 * заберёт. Этот метод делает «забрать» автоматически от лица отправляющего
	 * оператора, чтобы диалог сразу попадал в «В работе» и появлялся в правой
	 * панели карточки сделки/лида.
	 *
	 * Алгоритм:
	 *   1. operatorId = user.current?auth=<authId> (user-auth от widget).
	 *   2. Retry-loop (5 × 1.5с, B24 создаёт chat 0-3с после send.messages):
	 *      `im.recent.list TYPE=lines` → ищем item где chat.entity_id содержит
	 *      `social_connector|<line>|<userKey>|<sessionId>` — наш userKey.
	 *   3. imopenlines.operator.answer CHAT_ID=<num> USER_ID=<operatorId>.
	 *      Если 400 → fallback imopenlines.session.join CHAT_ID=<num>.
	 *
	 * Не throw'аем — auto-take это нерegрессивное улучшение, ошибка не должна
	 * ломать widget /send response. Каждый шаг логируется с trace-id чтобы
	 * чинить регрессии 6-го уровня (когда B24 поменяет API).
	 */
	// In-memory дедуп для postContextMessage. Не персистится — chat-id'ы
	// открытых линий редко переиспользуются, перезапуск adapter раз в сутки
	// норма. Trim до 5000 при росте сверх 10000 элементов.
	private readonly _contextMessagePosted = new Set<number>();

	/**
	 * Фикс B (#47): системное сообщение со ссылками лид/сделка/контакт в начало
	 * open-line диалога. Оператор сразу видит куда «прыгнуть» из карточки чата —
	 * раньше панель показывала только связь с лидом-дубликатом, теперь — со
	 * сделкой/реальным контактом.
	 *
	 * Идемпотентность: пер chat-id в памяти adapter. После рестарта повтор возможен
	 * (раз в сутки норма). chatId — числовой ID из im.recent.list (то что отдаёт
	 * autoTakeSession.chatId).
	 *
	 * Использует im.message.add SYSTEM=Y — сообщение от имени системного бота,
	 * не от оператора. BB-коды [URL=...] для кликабельных ссылок.
	 */
	async postContextMessage(
		portalDomain: string,
		chatId: number,
		ctx: {
			contactId?: number;
			contactName?: string;
			openEntity?: { kind: "deal" | "lead"; id: number; title?: string };
			channelLabel?: string;
			customerUuid?: string;
		},
	): Promise<{ posted?: boolean; reason?: string }> {
		if (!chatId) return { reason: "no chatId" };
		if (this._contextMessagePosted.has(chatId)) return { reason: "already posted" };
		this._contextMessagePosted.add(chatId);
		// Trim чтобы Set не рос неограниченно. 10k → 5k последних — простая стратегия,
		// конкретные id не важны, мы только хотим не отправлять подряд второй раз.
		if (this._contextMessagePosted.size > 10000) {
			const arr = [...this._contextMessagePosted];
			this._contextMessagePosted.clear();
			arr.slice(-5000).forEach((id) => this._contextMessagePosted.add(id));
		}

		const portalUrl = `https://${portalDomain}`;
		const lines: string[] = ["[B]📎 Контекст клиента[/B]"];
		if (ctx.contactId) {
			const label = ctx.contactName ? `${ctx.contactName} (карточка)` : "карточка контакта";
			lines.push(`👤 [URL=${portalUrl}/crm/contact/details/${ctx.contactId}/]${label}[/URL]`);
		}
		if (ctx.openEntity) {
			const kindLabel = ctx.openEntity.kind === "deal" ? "💼 Открытая сделка" : "📋 Открытый лид";
			const label = ctx.openEntity.title || `№${ctx.openEntity.id}`;
			lines.push(`${kindLabel}: [URL=${portalUrl}/crm/${ctx.openEntity.kind}/details/${ctx.openEntity.id}/]${label}[/URL]`);
		}
		if (ctx.customerUuid) {
			const dashUrl = this.configService.get<string>("DV_DASHBOARD_URL") || "https://dashboard.9wb.ru";
			// DV Dashboard: страница клиента — /customer/<uuid>, не /customer-360/<uuid>
			// (последний — индекс с cohorts/waiting, 404 на UUID).
			lines.push(`🧭 [URL=${dashUrl}/customer/${ctx.customerUuid}]Customer-360[/URL]`);
		}
		if (ctx.channelLabel) {
			lines.push(`[I]Канал: ${ctx.channelLabel}[/I]`);
		}
		if (lines.length === 1) {
			// Ничего кроме заголовка — нет смысла слать.
			this._contextMessagePosted.delete(chatId);
			return { reason: "no context to show" };
		}

		const text = lines.join("\n");
		try {
			await this.callBitrix24Method(portalDomain, "im.message.add", {
				DIALOG_ID: `chat${chatId}`,
				MESSAGE: text,
				SYSTEM: "Y",
				URL_PREVIEW: "N",
			});
			this.logger.info(
				`postContextMessage: chat ${chatId} ← context (contact=${ctx.contactId || "-"}, ` +
				`entity=${ctx.openEntity?.kind || "-"}/${ctx.openEntity?.id || "-"}, ` +
				`uuid=${ctx.customerUuid || "-"})`,
			);
			return { posted: true };
		} catch (e: any) {
			this.logger.warn(`postContextMessage: failed for chat ${chatId}: ${e?.message || e}`);
			this._contextMessagePosted.delete(chatId); // позволим повторить позже
			return { reason: e?.message || "post failed" };
		}
	}

	async autoTakeSession(
		portalDomain: string,
		operatorAuthId: string,
		userKey: string,
		opts: { displayName?: string; line?: number; knownChatId?: number } = {},
	): Promise<{ chatId?: number; operatorId?: number; ok?: boolean; reason?: string }> {
		const trace = Math.random().toString(36).slice(2, 8);
		try {
			// 1. operatorId через user.current с user-auth (authId из widget body).
			let operatorId: number | undefined;
			try {
				const r = await axios.get(
					`https://${portalDomain}/rest/user.current?auth=${encodeURIComponent(operatorAuthId)}`,
					{ timeout: 8000 },
				);
				const uid = Number(r.data?.result?.ID || r.data?.result?.id || 0);
				if (uid > 0) operatorId = uid;
			} catch (e: any) {
				this.logger.warn(`autoTake[${trace}]: user.current failed: ${e.response?.data?.error_description || e.message}`);
				return { reason: "user.current failed" };
			}
			if (!operatorId) {
				this.logger.warn(`autoTake[${trace}]: operatorId not resolved from authId`);
				return { reason: "no operatorId" };
			}

			// 2. Быстрый путь: если widget уже извлёк chat_id из ответа
			// imconnector.send.messages (DATA.RESULT[0].session.CHAT_ID) — используем
			// его напрямую. im.recent.list от app-context не видит свежесозданные
			// chat-users (проверено 25.05 — autoTake fail'ил с `chat not found`).
			let chatId: number | undefined = opts.knownChatId && opts.knownChatId > 0
				? opts.knownChatId
				: undefined;

			// 3. Fallback: retry-loop по im.recent.list (только если knownChatId не
			// передан — для совместимости с местами вызова где session не возвращена).
			if (!chatId) {
				let target: any = null;
				for (let attempt = 0; attempt < 5; attempt++) {
					await new Promise((res) => setTimeout(res, 1500));
					try {
						const recent: any = await this.callBitrix24Method(portalDomain, "im.recent.list", {
							TYPE: "lines", LIMIT: 50,
						});
						const items: any[] = recent?.items || recent || [];
						target = items.find((i: any) => {
							const entityId = String(i?.chat?.entity_id || "");
							return entityId.includes(userKey);
						});
						if (target) break;
					} catch (e: any) {
						this.logger.warn(`autoTake[${trace}]: im.recent.list attempt ${attempt + 1} failed: ${e?.message || e}`);
					}
				}
				if (!target) {
					this.logger.warn(`autoTake[${trace}]: chat for userKey=${userKey} not in im.recent.list after 5 attempts`);
					return { operatorId, reason: "chat not found" };
				}
				chatId = Number(target.chat_id);
			}
			if (!chatId) {
				this.logger.warn(`autoTake[${trace}]: no numeric chat_id resolved for userKey=${userKey}`);
				return { operatorId, reason: "no chat_id" };
			}

			// 3. operator.answer; если не сработал — fallback session.join.
			// ВАЖНО: вызываем через USER-auth (authId оператора), а не через
			// app-OAuth токен. App-OAuth attachит сессию к bot-user'у adapter'а
			// (= «Технический Пользователь» B24), независимо от USER_ID в params.
			// Чтобы B24 видел «оператор сам забрал диалог» — нужен его authId
			// прямо в URL (?auth=<operatorAuthId>).
			const callAsOperator = async (method: string, params: Record<string, any>) => {
				const url = `https://${portalDomain}/rest/${method}?auth=${encodeURIComponent(operatorAuthId)}`;
				const r = await axios.post(url, params, { timeout: 15000 });
				if (r.data?.error) {
					throw new Error(`B24 ${method}: ${r.data.error_description || r.data.error}`);
				}
				return r.data?.result;
			};
			try {
				await callAsOperator("imopenlines.operator.answer", { CHAT_ID: chatId, USER_ID: operatorId });
				this.logger.info(`autoTake[${trace}]: chat ${chatId} → operator ${operatorId} (userKey=${userKey}) via user-auth`);
				return { chatId, operatorId, ok: true };
			} catch (e1: any) {
				this.logger.warn(`autoTake[${trace}]: operator.answer (user-auth) failed: ${e1.message}, trying session.join`);
				try {
					await callAsOperator("imopenlines.session.join", { CHAT_ID: chatId });
					this.logger.info(`autoTake[${trace}]: chat ${chatId} joined via session.join (userKey=${userKey}) via user-auth`);
					return { chatId, operatorId, ok: true };
				} catch (e2: any) {
					this.logger.warn(`autoTake[${trace}]: session.join (user-auth) also failed: ${e2.message}`);
					return { chatId, operatorId, reason: "both methods failed" };
				}
			}
		} catch (err: any) {
			this.logger.warn(`autoTake[${trace}]: unexpected error: ${err?.message || err}`);
			return { reason: err?.message || "unexpected" };
		}
	}

	async listConnectors(portalDomain: string): Promise<string[]> {
		const result = (await this.callBitrix24Method(portalDomain, "imconnector.list", {})) as unknown;
		if (Array.isArray(result)) return result.map((x) => String(x));
		// imconnector.list возвращает { "<connector_id>": "<display_label>" }.
		// ID — это ключи, не values. Был баг: Object.values() возвращал labels
		// ("Social Connector"), а проверка includes("social_connector") — false.
		if (result && typeof result === "object") return Object.keys(result as Record<string, unknown>);
		return [];
	}

	/**
	 * imconnector.status для пары CONNECTOR+LINE → { CONFIGURED, STATUS, ACTIVE_STATUS }.
	 * connectorId по умолчанию social_connector.
	 */
	async getConnectorStatus(
		portalDomain: string,
		line: number,
		connectorId = "social_connector",
	): Promise<{ CONFIGURED?: boolean; STATUS?: boolean; ACTIVE_STATUS?: boolean }> {
		const result = (await this.callBitrix24Method(portalDomain, "imconnector.status", {
			CONNECTOR: connectorId,
			LINE: line,
		})) as { CONFIGURED?: boolean; STATUS?: boolean; ACTIVE_STATUS?: boolean } | null;
		return result || {};
	}

	/**
	 * Активирует коннектор на открытой линии: imconnector.activate + data.set.
	 * Идемпотентно — повторный вызов на уже активной линии безвреден. Adapter
	 * штатно активирует линию только при настройке через SETTING_CONNECTOR;
	 * health-check зовёт этот метод для само-восстановления линий, где коннектор
	 * не активирован (типовой случай — добавили новый номер, активацию забыли).
	 */
	async activateConnectorOnLine(
		portalDomain: string,
		line: number,
		connectorId = "social_connector",
	): Promise<void> {
		await this.callBitrix24Method(portalDomain, "imconnector.activate", {
			CONNECTOR: connectorId,
			LINE: line,
			ACTIVE: 1,
		});
		const appUrl = this.configService.get<string>("APP_URL");
		await this.callBitrix24Method(portalDomain, "imconnector.connector.data.set", {
			CONNECTOR: connectorId,
			LINE: line,
			DATA: {
				id: `${connectorId}_line_${line}`,
				url: `${appUrl}/webhooks/bitrix24`,
				name: "Social Connector",
				description: "Universal messenger connector",
			},
		});
	}

	// Простой мьютекс на phone, чтобы два одновременных webhook'а от Green API не
	// создали два дублирующих лида до того как первый успеет завершить crm.lead.add.
	private readonly _ensureLeadLocks = new Map<string, Promise<EnsureLeadResult>>();

	/**
	 * Гарантирует что у клиента (по phone) есть открытый лид/сделка к моменту
	 * отправки сообщения в B24. Закрывает gap между приходом сообщения и
	 * принятием диалога оператором: B24 imopenlines создаёт лид только при
	 * принятии диалога, а до этого момента сообщения могут «висеть» без CRM.
	 *
	 * Логика:
	 *   1. Найти контакт по phone (E.164). Нет — выходим (B24 сам создаст лид+контакт).
	 *   2. Проверить открытые лиды и сделки у контакта.
	 *   3. Если есть открытое — ничего не делать (новые сообщения прицепятся).
	 *   4. Если нет — создать лид с привязкой к контакту.
	 *
	 * Когда вызывается из widget /send: skipLeadCreation=true. Тогда шаги 1-3
	 * выполняются (поиск контакта + запись UF_CRM_*_CHAT_ID), но auto-лид НЕ
	 * создаётся — за лид отвечает imconnector.send.messages + backfillSendLead.
	 *
	 * Идемпотентность обеспечивается мьютексом по phone и проверкой 2-3.
	 */
	async ensureOpenLeadForPhone(
		portalDomain: string,
		phoneE164: string,
		senderName: string,
		lineId: number,
		channelLabel: string = "WhatsApp",
		chatId?: string,
		skipLeadCreation: boolean = false,
		ymClientId?: string,
	): Promise<EnsureLeadResult> {
		const lockKey = `${portalDomain}:${phoneE164}:${chatId || ""}`;
		const existing = this._ensureLeadLocks.get(lockKey);
		if (existing) return existing;
		const task: Promise<EnsureLeadResult> = (async (): Promise<EnsureLeadResult> => {
			// Trace-id: помогает следить flow через несколько log-точек на одном
			// вызове (виджет → ensureLead → orphan-link → backfill).
			const trace = Math.random().toString(36).slice(2, 8);
			this.logger.info(
				`ensureLead[${trace}]: enter phone=${phoneE164 || "-"} chat=${chatId || "-"} ` +
				`channel=${channelLabel} line=${lineId} skipLead=${skipLeadCreation}`,
			);
			try {
				// 1. Поиск контакта по phone. Если phone пустой/невалидный —
				// ищем по сохранённому chatId в UF_CRM_TG_CHAT_ID / UF_CRM_MAX_CHAT_ID
				// (для случая когда клиент пишет с приватным phone в MAX/Telegram).
				let contactId: number | undefined;
				const hasUsablePhone = /^\+?\d{10,15}$/.test(phoneE164);
				if (hasUsablePhone) {
					const dup: any = await this.callBitrix24Method(portalDomain, "crm.duplicate.findbycomm", {
						type: "PHONE",
						values: [phoneE164],
					});
					contactId = dup?.CONTACT?.[0];
					this.logger.info(
						`ensureLead[${trace}]: findbycomm(PHONE=${phoneE164}) → ` +
						`${contactId ? `contact=${contactId}` : "no contact"}`,
					);
				} else {
					this.logger.info(`ensureLead[${trace}]: phone ${phoneE164 || "-"} not usable, skip duplicate.findbycomm`);
				}
				const chatIdUfMap: Record<string, string> = {
					"Telegram": "UF_CRM_TG_CHAT_ID",
					"MAX": "UF_CRM_MAX_CHAT_ID",
					"Instagram": "UF_CRM_IG_CHAT_ID",
				};
				const chatIdUf = chatIdUfMap[channelLabel];
				if (!contactId && chatId && chatIdUf) {
					const found: any = await this.callBitrix24Method(portalDomain, "crm.contact.list", {
						filter: { [chatIdUf]: chatId },
						select: ["ID"],
					});
					if (Array.isArray(found) && found.length > 0) {
						contactId = parseInt(found[0].ID, 10);
						this.logger.info(`ensureLead[${trace}]: contact ${contactId} found via ${chatIdUf}=${chatId}`);
					} else {
						this.logger.info(`ensureLead[${trace}]: ${chatIdUf}=${chatId} also no match — contact will be created by B24`);
					}
				}
				if (!contactId) {
					this.logger.info(`ensureLead[${trace}]: no existing contact for ${phoneE164}/${chatId || "-"}, leaving creation to B24`);
					return {};
				}
				// Если нашли контакт И есть chatId — сохраняем chatId в UF контакта
				// (только если поле сейчас пустое). Это даст матч по chatId для
				// будущих сообщений когда phone недоступен. Заодно читаем имя
				// для возврата вызывающему (widget использует его как displayName
				// в imconnector и для backfill созданного лида).
				let contactName: string | undefined;
				let contactLastName: string | undefined;
				let customerUuid: string | undefined;
				try {
					const contactData: any = await this.callBitrix24Method(portalDomain, "crm.contact.get", { id: contactId });
					contactName = (contactData?.NAME || "").toString().trim() || undefined;
					contactLastName = (contactData?.LAST_NAME || "").toString().trim() || undefined;
					customerUuid = (contactData?.UF_CRM_PB_CUSTOMER_UUID || "").toString().trim() || undefined;
					if (chatId && chatIdUf) {
						const existingValue = contactData?.[chatIdUf];
						if (!existingValue) {
							try {
								await this.callBitrix24Method(portalDomain, "crm.contact.update", {
									id: contactId,
									fields: { [chatIdUf]: chatId },
								});
								this.logger.info(`ensureLead[${trace}]: saved ${chatIdUf}=${chatId} on contact ${contactId}`);
							} catch (updErr: any) {
								this.logger.error(
									`ensureLead[${trace}]: FAILED to save ${chatIdUf}=${chatId} on contact ${contactId} — ` +
									`incoming/outgoing chat-user mismatch гарантирован. err=${updErr.message}`,
								);
								throw updErr;
							}
							// Контакт «новый» для этого канала — собираем под него всю
							// прошлую историю. Ретроактивно привязываем все «свободные»
							// лиды (CONTACT_ID пуст) с тем же chatId. backfillIgUfFields /
							// backfillTgBotContactLink пишут chatId на каждый лид сессии,
							// так что искать есть по чему. Best-effort, не блокирует.
							void this.linkOrphanLeadsToContact(
								portalDomain, contactId, chatIdUf, String(chatId),
							).catch((e: any) =>
								this.logger.warn(`ensureLead[${trace}]: orphan-link failed (non-fatal): ${e.message}`),
							);
						} else {
							this.logger.info(
								`ensureLead[${trace}]: ${chatIdUf} on contact ${contactId} already = ${existingValue} ` +
								`(incoming new=${chatId}, ${existingValue === chatId ? "MATCH" : "MISMATCH — possible split chat-user"})`,
							);
						}
					}
				} catch (e: any) {
					this.logger.warn(`ensureLead[${trace}]: failed to read/save contact ${contactId}: ${e.message}`);
				}

				const baseResult: EnsureLeadResult = { contactId, contactName, contactLastName, customerUuid };

				if (skipLeadCreation) {
					// Widget-flow: лид создаст imconnector, мы только зарезолвили контакт
					return baseResult;
				}

				// 2. Открытые лиды (фильтр: статус не F=failed, не S=success)
				const openLeads: any = await this.callBitrix24Method(portalDomain, "crm.lead.list", {
					filter: {
						CONTACT_ID: contactId,
						"!STATUS_SEMANTIC_ID": ["F", "S"],
					},
					select: ["ID", "UF_CRM_NF_YM_CLIENT_ID"],
				});
				if (Array.isArray(openLeads) && openLeads.length > 0) {
					this.logger.info(`ensureLead: contact ${contactId} has ${openLeads.length} open lead(s) — no action`);
					// Я.Метрика ClientId: метка `ym-<id>` из текста (сайт подставляет
					// её при «Спросить о товаре в WhatsApp/Telegram»). Если на
					// открытом лиде поле пусто или заглушка "-", а сейчас пришёл
					// настоящий id — обновляем. Иначе метка терялась бы для всех
					// повторных обращений клиента с открытым лидом.
					if (ymClientId) {
						const openLead = openLeads[0];
						const currentYm = String(openLead?.UF_CRM_NF_YM_CLIENT_ID || "");
						if (!currentYm || currentYm === "-") {
							try {
								await this.callBitrix24Method(portalDomain, "crm.lead.update", {
									id: parseInt(openLead.ID, 10),
									fields: { UF_CRM_NF_YM_CLIENT_ID: ymClientId },
								});
								this.logger.info(`ensureLead: UF_CRM_NF_YM_CLIENT_ID=${ymClientId} → existing lead ${openLead.ID}`);
							} catch (e: any) {
								this.logger.warn(`ensureLead: failed to update YM on lead ${openLead.ID}: ${e.message}`);
							}
						}
					}
					return baseResult;
				}

				// 3. Открытые сделки
				const openDeals: any = await this.callBitrix24Method(portalDomain, "crm.deal.list", {
					filter: {
						CONTACT_ID: contactId,
						CLOSED: "N",
					},
					select: ["ID"],
				});
				if (Array.isArray(openDeals) && openDeals.length > 0) {
					this.logger.info(`ensureLead: contact ${contactId} has ${openDeals.length} open deal(s) — no action`);
					return baseResult;
				}

				// 4. Создать лид. SOURCE_ID берём из конфига линии (то что у обычных
				// B24-лидов от open lines). Если не задан — B24 поставит default.
				let sourceId: string | undefined;
				try {
					const config: any = await this.callBitrix24Method(portalDomain, "imopenlines.config.get", {
						CONFIG_ID: lineId,
					});
					sourceId = config?.CRM_SOURCE;
				} catch (e: any) {
					this.logger.warn(`ensureLead: failed to read line ${lineId} CRM_SOURCE: ${e.message}`);
				}

				const fields: Record<string, any> = {
					TITLE: `${senderName} - ${channelLabel} (auto)`,
					NAME: senderName,
					CONTACT_ID: contactId,
					PHONE: [{ VALUE: phoneE164, VALUE_TYPE: "MOBILE" }],
					// Yandex Metrika ClientId: с сайта-формы заполняется через NetForm.
					// Из WhatsApp прилетает в служебной метке сообщения (PB-WA-CID) и
					// прокидывается сюда как ymClientId. Если метки нет — ставим "-"
					// (B24 требует поле при смене стадии, иначе оператор заблокирован).
					UF_CRM_NF_YM_CLIENT_ID: ymClientId || "-",
				};
				if (sourceId) fields.SOURCE_ID = sourceId;

				const createdId: any = await this.callBitrix24Method(portalDomain, "crm.lead.add", { fields });
				this.logger.info(`ensureLead: created lead ${createdId} for contact ${contactId} (phone ${phoneE164})`);
				return { ...baseResult, createdLeadId: Number(createdId) || undefined };
			} catch (err: any) {
				// Не блокируем доставку сообщения, только логируем
				this.logger.error(`ensureLead failed: ${err.message}`);
				return {};
			}
		})();
		this._ensureLeadLocks.set(lockKey, task);
		try {
			return await task;
		} finally {
			this._ensureLeadLocks.delete(lockKey);
		}
	}

	/** Ретроактивная привязка «свободных» лидов клиента к появившемуся контакту.
	 *  Сценарий: клиент несколько раз писал нам в IG/TG/MAX до того, как мы
	 *  завели контакт; лиды создавались с UF_CRM_*_CHAT_ID, но с пустым
	 *  CONTACT_ID. Когда контакт наконец появляется (этот метод вызывается из
	 *  ensureOpenLeadForPhone в момент записи chatId на контакт), собираем под
	 *  него всю прошлую историю — все лиды с тем же chatId и пустым CONTACT_ID.
	 *  Только для каналов с устойчивым chatId: Instagram, Telegram, MAX.
	 *  Для WhatsApp/phone не делаем — номер может перейти к другому человеку. */
	private async linkOrphanLeadsToContact(
		portalDomain: string,
		contactId: number,
		chatIdUf: string,
		chatIdValue: string,
	): Promise<void> {
		const allowed = new Set(["UF_CRM_IG_CHAT_ID", "UF_CRM_TG_CHAT_ID", "UF_CRM_MAX_CHAT_ID"]);
		if (!allowed.has(chatIdUf)) return;
		const leads: any = await this.callBitrix24Method(portalDomain, "crm.lead.list", {
			filter: { [chatIdUf]: chatIdValue },
			select: ["ID", "CONTACT_ID"],
		});
		const list = Array.isArray(leads) ? leads : [];
		// «Свободный» = CONTACT_ID пуст / 0 / null. B24 фильтр по пустому полю
		// ненадёжен — фильтруем в коде после.
		const orphans = list.filter((l: any) => {
			const cid = l?.CONTACT_ID;
			return !cid || cid === "0" || cid === 0;
		});
		if (orphans.length === 0) return;
		this.logger.info(`orphan-link: contact ${contactId} → ${orphans.length} lead(s) by ${chatIdUf}=${chatIdValue}`);
		for (const lead of orphans) {
			const leadId = parseInt(lead.ID, 10);
			if (!leadId) continue;
			try {
				await this.callBitrix24Method(portalDomain, "crm.lead.update", {
					id: leadId,
					fields: { CONTACT_ID: contactId },
				});
				this.logger.info(`orphan-link: lead ${leadId} → contact ${contactId}`);
			} catch (e: any) {
				this.logger.warn(`orphan-link: lead ${leadId} update failed: ${e.message}`);
			}
		}
	}

	/**
	 * Ищет открытую CRM-сущность у контакта: сначала открытую сделку
	 * (CLOSED=N), потом открытый лид (статус не F/S). Используется в widget
	 * /send для решения «писать timeline-comment в существующую сущность или
	 * создавать новый imconnector-лид». Возвращает первую найденную, null
	 * если ничего открытого нет.
	 */
	async findOpenCrmEntityForContact(
		portalDomain: string,
		contactId: number,
	): Promise<{ kind: "deal" | "lead"; id: number; title?: string } | null> {
		try {
			const deals: any = await this.callBitrix24Method(portalDomain, "crm.deal.list", {
				filter: { CONTACT_ID: contactId, CLOSED: "N" },
				select: ["ID", "TITLE"],
				order: { DATE_CREATE: "DESC" },
			});
			if (Array.isArray(deals) && deals.length > 0) {
				return { kind: "deal", id: Number(deals[0].ID), title: deals[0].TITLE };
			}
		} catch (e: any) {
			this.logger.warn(`findOpenCrmEntity: deal.list failed for contact ${contactId}: ${e.message}`);
		}
		try {
			const leads: any = await this.callBitrix24Method(portalDomain, "crm.lead.list", {
				filter: { CONTACT_ID: contactId, "!STATUS_SEMANTIC_ID": ["F", "S"] },
				select: ["ID", "TITLE"],
				order: { DATE_CREATE: "DESC" },
			});
			if (Array.isArray(leads) && leads.length > 0) {
				return { kind: "lead", id: Number(leads[0].ID), title: leads[0].TITLE };
			}
		} catch (e: any) {
			this.logger.warn(`findOpenCrmEntity: lead.list failed for contact ${contactId}: ${e.message}`);
		}
		return null;
	}

	/**
	 * Установить PHOTO у CRM-контакта или лида, если поле сейчас пустое.
	 * Ручную работу оператора (если фото уже стоит) не перезатираем.
	 * Используется фоновым воркером avatar_sync wa-tg-bridge'а — он берёт
	 * аватарку из мессенджера и шлёт base64 сюда.
	 */
	async setEntityPhotoIfEmpty(
		kind: "contact" | "lead",
		entityId: number,
		filename: string,
		base64: string,
	): Promise<{ result: "updated" | "already_set" | "skipped"; reason?: string }> {
		const users = await (this.prisma as any).user.findMany({ take: 1 });
		const portalDomain = users[0]?.portalDomain;
		if (!portalDomain) {
			return { result: "skipped", reason: "no authorized portal" };
		}
		const getMethod = kind === "contact" ? "crm.contact.get" : "crm.lead.get";
		const updateMethod = kind === "contact" ? "crm.contact.update" : "crm.lead.update";
		let current: any;
		try {
			current = await this.callBitrix24Method(portalDomain, getMethod, { id: entityId });
		} catch (e: any) {
			return { result: "skipped", reason: `get failed: ${e.message}` };
		}
		if (!current) return { result: "skipped", reason: "entity not found" };
		// PHOTO у crm.contact / crm.lead может вернуться как
		// {"id":"...","showUrl":"...","downloadUrl":"..."} (есть фото)
		// или null/"" (нет фото). При создании контактов import-ом B24 иногда
		// кладёт пустой объект {} — тоже считаем "пусто".
		const existing = current.PHOTO;
		const hasPhoto = existing && typeof existing === "object"
			? Boolean(existing.id || existing.downloadUrl || existing.showUrl)
			: typeof existing === "string"
				? existing.trim().length > 0
				: false;
		if (hasPhoto) {
			return { result: "already_set", reason: "PHOTO field is not empty" };
		}
		try {
			await this.callBitrix24Method(portalDomain, updateMethod, {
				id: entityId,
				fields: { PHOTO: { fileData: [filename, base64] } },
			});
			return { result: "updated" };
		} catch (e: any) {
			return { result: "skipped", reason: `update failed: ${e.message}` };
		}
	}

	/**
	 * Идемпотентно создаёт пользовательское поле UF_CRM_* у сущности CRM
	 * (lead/contact/deal). Возвращает 'created' | 'exists' | 'skipped'.
	 * Использует OAuth-токен установленного приложения — scope crm должен быть
	 * включён в манифесте app (он есть в greenapi-integration-bitrix24).
	 *
	 * Поле создаётся как string c указанным maxLength (по умолчанию 36 для UUID).
	 */
	async ensureUfField(
		entity: "lead" | "contact" | "deal",
		fieldName: string,
		opts: {
			label?: string;
			xmlId?: string;
			maxLength?: number;
			searchable?: boolean;
		} = {},
	): Promise<{ result: "created" | "exists" | "skipped"; id?: number; reason?: string }> {
		const users = await (this.prisma as any).user.findMany({ take: 1 });
		const portalDomain = users[0]?.portalDomain;
		if (!portalDomain) {
			return { result: "skipped", reason: "no authorized portal" };
		}
		const listMethod = `crm.${entity}.userfield.list`;
		const addMethod = `crm.${entity}.userfield.add`;
		try {
			const existing: any = await this.callBitrix24Method(portalDomain, listMethod, {
				order: { ID: "ASC" },
			}, undefined, 0, "customer360");
			if (Array.isArray(existing)) {
				const match = existing.find((x: any) => x.FIELD_NAME === fieldName);
				if (match) {
					return { result: "exists", id: Number(match.ID) };
				}
			}
		} catch (e: any) {
			return { result: "skipped", reason: `list failed: ${e.message}` };
		}
		const label = opts.label || fieldName;
		try {
			const newId: any = await this.callBitrix24Method(portalDomain, addMethod, {
				fields: {
					FIELD_NAME: fieldName,
					USER_TYPE_ID: "string",
					XML_ID: opts.xmlId || fieldName,
					EDIT_FORM_LABEL: { ru: label, en: label },
					LIST_COLUMN_LABEL: { ru: label, en: label },
					LIST_FILTER_LABEL: { ru: label, en: label },
					SETTINGS: {
						DEFAULT_VALUE: "",
						SIZE: 40,
						ROWS: 1,
						REGEXP: "",
						MIN_LENGTH: 0,
						MAX_LENGTH: opts.maxLength ?? 36,
					},
					MANDATORY: "N",
					MULTIPLE: "N",
					SHOW_FILTER: "Y",
					SHOW_IN_LIST: "N",
					EDIT_IN_LIST: "N",
					IS_SEARCHABLE: opts.searchable === false ? "N" : "Y",
				},
			}, undefined, 0, "customer360");
			return { result: "created", id: Number(newId) };
		} catch (e: any) {
			return { result: "skipped", reason: `add failed: ${e.message}` };
		}
	}

	// ===== Customer-360: B24 event.bind + handler ========================

	private async _eventsIngest(body: Record<string, any>): Promise<void> {
		const url = (process.env.CUSTOMER_SERVICE_URL || "").replace(/\/+$/, "");
		const secret = process.env.CUSTOMER_SERVICE_SECRET || "";
		if (!url || !secret) return;
		try {
			await axios.post(`${url}/events/ingest`, body, {
				headers: { "X-Service-Secret": secret, "Content-Type": "application/json" },
				timeout: 5000,
			});
		} catch (e: any) {
			this.logger.warn(
				`events/ingest failed (${body.source}/${body.eventType}): ${e?.response?.data?.message || e.message}`,
			);
		}
	}

	/**
	 * Customer-360: пишет событие IG-сообщения (message_in/message_out) в
	 * customer_events. Клиент резолвится по `ig_client` (стабильный числовой
	 * Instagram user_id); `@username` добавляется вторичным алиасом — для
	 * человекочитаемого имени в дашборде/KBD-ленте. Best-effort: ошибки
	 * вложенных вызовов глотаются, исключение наружу не пробрасывается.
	 */
	private async _emitIgMessageEvent(opts: {
		clientId: string;
		username?: string;
		direction: "in" | "out";
		text: string;
		igChannel: "direct" | "comment";
		messageId?: string;
		mediaUrl?: string;
		mediaName?: string;
		// A2/Customer-360: метаданные поста, под которым оставлен/отвечен
		// коммент. Каждое событие неперезаписываемое — в ленте Customer-360
		// видна полная история «какой пост → какой коммент → какой ответ».
		postUrl?: string;
		mediaId?: string;
		commentId?: string;
	}): Promise<void> {
		const fc = await this._csFindOrCreate("ig_client", opts.clientId, "adapter-ig");
		const payload: Record<string, any> = {
			client_id: opts.clientId,
			username: opts.username || undefined,
			ig_channel: opts.igChannel,
			message_id: opts.messageId,
			post_url: opts.postUrl || undefined,
			media_id: opts.mediaId || undefined,
			comment_id: opts.commentId || undefined,
		};
		// Медиа-вложение: скачиваем у себя (ссылка i2crm живёт недолго) и
		// кладём наш URL в payload — лента Customer-360 покажет фото/видео
		// инлайн. Не вышло скачать — остаётся внешняя ссылка.
		if (opts.mediaUrl) {
			const stored = await this._storeI2crmMedia(
				opts.mediaUrl, opts.messageId || "", opts.mediaName || "",
			);
			const fileUrl = stored?.localUrl || opts.mediaUrl;
			payload.file_url = fileUrl;
			payload.file_name = opts.mediaName || "";
			if (stored?.mime) {
				payload.mime_type = stored.mime;
				if (stored.mime.startsWith("image/")) payload.image_url = fileUrl;
			}
		}
		const body: Record<string, any> = {
			source: "bridge_ig",
			eventType: opts.direction === "out" ? "message_out" : "message_in",
			channel: "IG",
			summary: (opts.text || "").slice(0, 300) || "(вложение)",
			payload,
		};
		if (fc?.uuid) {
			body.customerUuid = fc.uuid;
			if (opts.username) {
				await this._csAddAlias(fc.uuid, "ig_username", opts.username);
			}
		} else {
			body.resolveAlias = { type: "ig_client", value: opts.clientId };
		}
		await this._eventsIngest(body);
	}

	/**
	 * Customer-360: пишет событие изменения статуса доставки исходящего
	 * сообщения (message_delivery_status). Используется в:
	 *   1. handleI2crmOutgoing — status='sent' при успешном target/feedback,
	 *      status='failed' если i2crm вернул error / transport упал.
	 *   2. handleOutgoingMessageStatus (Green API) — status в
	 *      ['sent','delivered','read'] от webhook'а Green API.
	 *
	 * На странице DV Dashboard /customer-360/outgoing-pending запрос
	 * соединяет message_out события без последующего delivery_status —
	 * это и есть «зависшие» исходящие, требующие внимания оператора.
	 *
	 * payload: { idMessage, status, error?, connector?, channel? }
	 * source: bridge_wa/ig/tg/max или adapter (если connector не маппится)
	 */
	private async _emitMessageDeliveryEvent(opts: {
		idMessage: string;
		status: "sent" | "delivered" | "read" | "failed";
		source: string;
		channel: string;
		b24ChatId?: string;
		connector?: string;
		customerUuid?: string;
		error?: string;
	}): Promise<void> {
		const payload: Record<string, any> = {
			idMessage: opts.idMessage,
			status: opts.status,
		};
		if (opts.error) payload.error = opts.error;
		if (opts.connector) payload.connector = opts.connector;
		if (opts.b24ChatId) payload.b24ChatId = opts.b24ChatId;
		const body: Record<string, any> = {
			source: opts.source,
			eventType: "message_delivery_status",
			channel: opts.channel,
			summary: `${opts.status}: ${opts.idMessage}${opts.error ? " — " + opts.error.slice(0, 100) : ""}`,
			payload,
		};
		if (opts.customerUuid) body.customerUuid = opts.customerUuid;
		await this._eventsIngest(body);
	}

	/**
	 * connector → (source, channel) для Customer-360 events.
	 * Используется в delivery-status emit'ах когда у нас connector_id
	 * из outgoingMessage записи, и нужно нормализовать источник.
	 */
	private _sourceFromConnector(connector: string): { source: string; channel: string } {
		const c = (connector || "").toLowerCase();
		if (c.includes("whatsapp") || c.includes("wa_")) return { source: "bridge_wa", channel: "WA" };
		if (c.includes("max")) return { source: "bridge_max", channel: "MAX" };
		if (c.includes("telegram") || c === "tg" || c.includes("tg_")) return { source: "bridge_tg", channel: "TG" };
		if (c.includes("instagram") || c.includes("ig_") || c === "i2crm") return { source: "bridge_ig", channel: "IG" };
		return { source: "adapter", channel: connector || "" };
	}

	// Расширение медиа-файла: из имени, иначе по MIME, иначе .bin.
	private _igMediaExt(fileName: string, mime: string): string {
		const m = fileName.match(/\.([a-z0-9]{1,5})$/i);
		if (m) return "." + m[1].toLowerCase();
		const map: Record<string, string> = {
			"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
			"image/webp": ".webp", "video/mp4": ".mp4", "video/quicktime": ".mov",
			"audio/mpeg": ".mp3", "audio/ogg": ".ogg", "audio/mp4": ".m4a",
			"application/pdf": ".pdf",
		};
		return map[mime.split(";")[0].trim().toLowerCase()] || ".bin";
	}

	/**
	 * Скачивает медиа Instagram (i2crm) в локальное медиа-хранилище.
	 * Каталог/URL — из env IG_MEDIA_DIR / IG_MEDIA_PUBLIC_URL (по умолчанию
	 * каталог раздаётся на wa.9wb.ru/media). Идемпотентно по ig_<messageId>.
	 */
	private async _storeI2crmMedia(
		url: string, messageId: string, fileName: string,
	): Promise<{ localUrl: string; mime: string } | null> {
		const dir = (process.env.IG_MEDIA_DIR || "").replace(/\/+$/, "");
		const pub = (process.env.IG_MEDIA_PUBLIC_URL || "").replace(/\/+$/, "");
		if (!dir || !pub || !messageId) return null;
		try {
			const resp = await axios.get(url, {
				responseType: "arraybuffer", timeout: 30000,
				maxContentLength: Infinity,
			});
			const buf = Buffer.from(resp.data);
			if (buf.length === 0) return null;
			const mime = String(resp.headers["content-type"] || "")
				.split(";")[0].trim().toLowerCase();
			const fname = `ig_${messageId}${this._igMediaExt(fileName, mime)}`;
			const fs = await import("node:fs/promises");
			await fs.writeFile(`${dir}/${fname}`, buf);
			return { localUrl: `${pub}/${fname}`, mime };
		} catch (e: any) {
			this.logger.warn(`i2crm: store media failed: ${e?.message || e}`);
			return null;
		}
	}

	/**
	 * Регистрирует event.bind для всех CRM-событий что мы слушаем
	 * (lead/contact/deal add+update). Идемпотентно — повторный bind для
	 * того же (event, handler) возвращает ошибку, мы её глотаем.
	 *
	 * handler URL = базовый URL adapter'а + /webhooks/b24-event.
	 * Передаём ?event=... в query, чтобы один endpoint умел маршрутизировать.
	 */
	async registerB24CrmEvents(
		handlerBaseUrl: string,
	): Promise<Array<{ event: string; result: string; reason?: string }>> {
		const users = await (this.prisma as any).user.findMany({ take: 1 });
		const portalDomain = users[0]?.portalDomain;
		if (!portalDomain) {
			return [{ event: "*", result: "skipped", reason: "no authorized portal" }];
		}
		const events = [
			"ONCRMLEADADD", "ONCRMLEADUPDATE",
			"ONCRMCONTACTADD", "ONCRMCONTACTUPDATE",
			"ONCRMDEALADD", "ONCRMDEALUPDATE",
		];
		const expectedHandlers: Record<string, string> = {};
		for (const ev of events) {
			expectedHandlers[ev] = `${handlerBaseUrl}/webhooks/b24-event?event=${ev}`;
		}
		// Сначала смотрим event.get — какие биндинги уже есть. Это даёт нам
		// точный список зарегистрированных, а не угадываем по ошибкам bind.
		let bound: Record<string, string> = {};
		try {
			const existing: any = await this.callBitrix24Method(portalDomain, "event.get", {}, undefined, 0, "customer360");
			if (Array.isArray(existing)) {
				for (const row of existing) {
					const e = String(row?.event || "").toUpperCase();
					const h = String(row?.handler || "");
					if (e) bound[e] = h;
				}
			}
		} catch (e: any) {
			this.logger.warn(`event.get failed: ${e.message}`);
		}
		const results: Array<{ event: string; result: string; reason?: string }> = [];
		for (const ev of events) {
			const expected = expectedHandlers[ev];
			const existingHandler = bound[ev];
			if (existingHandler === expected) {
				results.push({ event: ev, result: "exists" });
				continue;
			}
			if (existingHandler && existingHandler !== expected) {
				// Старый handler от прошлого URL — отвязать и привязать заново.
				try {
					await this.callBitrix24Method(portalDomain, "event.unbind", {
						event: ev, handler: existingHandler,
					}, undefined, 0, "customer360");
				} catch (e: any) {
					this.logger.warn(`event.unbind ${ev} stale handler failed: ${e.message}`);
				}
			}
			try {
				await this.callBitrix24Method(portalDomain, "event.bind", {
					event: ev,
					handler: expected,
				}, undefined, 0, "customer360");
				results.push({ event: ev, result: "bound" });
			} catch (e: any) {
				const msg = String(e?.message || "");
				const detail = (e as any)?.response?.data?.error_description || msg;
				if (/EVENT_BIND_EXISTS|already/i.test(detail)) {
					results.push({ event: ev, result: "exists" });
				} else {
					results.push({ event: ev, result: "failed", reason: detail });
				}
			}
		}
		return results;
	}

	/**
	 * Обрабатывает входящий B24 event (ONCRMLEADADD и т.д.). Резолвит entity в
	 * customer-service (по phone/email или по b24_<entity> alias) и пишет
	 * event в customer_events через customer-service /events/ingest.
	 */
	async handleB24CrmEvent(rawEvent: string, payload: any): Promise<{ ok: boolean; reason?: string }> {
		const users = await (this.prisma as any).user.findMany({ take: 1 });
		const portalDomain = users[0]?.portalDomain;
		if (!portalDomain) return { ok: false, reason: "no authorized portal" };

		const fields = payload?.data?.FIELDS || payload?.FIELDS || {};
		const entityId = Number(fields.ID);
		if (!entityId) return { ok: false, reason: "no entity id" };

		let entity: "lead" | "contact" | "deal";
		let action: "added" | "updated";
		const ev = rawEvent.toUpperCase();
		if (ev.startsWith("ONCRMLEAD")) entity = "lead";
		else if (ev.startsWith("ONCRMCONTACT")) entity = "contact";
		else if (ev.startsWith("ONCRMDEAL")) entity = "deal";
		else return { ok: false, reason: `unknown event ${ev}` };
		action = ev.endsWith("ADD") ? "added" : "updated";

		// Снимок entity для phone/email/title/stage
		let snap: any;
		try {
			snap = await this.callBitrix24Method(portalDomain, `crm.${entity}.get`, { id: entityId }, undefined, 0, "customer360");
		} catch (e: any) {
			return { ok: false, reason: `crm.${entity}.get failed: ${e.message}` };
		}
		if (!snap) return { ok: false, reason: "snapshot empty" };

		// Orphan-lead linker (task #68 / ADR 2026-05-26-orphan-lead-linker):
		// Когда менеджер пишет клиенту через native B24 OpenLine UI (не наш
		// widget/send) — B24 создаёт лид без CONTACT_ID и без UF_CRM_*_CHAT_ID.
		// Имя лида = chat.id мессенджера, к существующему контакту не привязано.
		// Пример: лид #361428 — `32656502 - MAX 79584983354`, CONTACT_ID=null.
		// `backfillSendLead` решает ту же проблему, но только для widget-пути.
		// Здесь — приземляем orphan через ONCRMLEADADD. Errors внутри не должны
		// сорвать дальнейший Customer-360 sync.
		if (entity === "lead" && action === "added") {
			try {
				await this._maybeLinkOrphanLead(portalDomain, entityId, snap);
			} catch (e: any) {
				this.logger.warn(`orphan-link lead ${entityId} failed: ${e?.message || e}`);
			}
		}

		// Резолвим customer
		const phone = this._pickFirstPhone(snap);
		const email = this._pickFirstEmail(snap);
		// IG-сущности: UF_CRM_IG_CHAT_ID хранит стабильный client_id. Резолвим
		// по ig_client — тогда B24 IG-лид садится на того же клиента Customer-360,
		// что и события IG-сообщений из handleI2crm* (единая личность канала).
		const igChatId = String(snap.UF_CRM_IG_CHAT_ID || "").trim();
		let resolveAlias: { type: string; value: string } | null = null;
		if (phone) resolveAlias = { type: "phone", value: phone };
		else if (email) resolveAlias = { type: "email", value: email };
		else if (igChatId) resolveAlias = { type: "ig_client", value: igChatId };
		else resolveAlias = { type: entity === "lead" ? "b24_lead" : entity === "contact" ? "b24_contact" : "b24_deal", value: String(entityId) };

		// Если UF_CRM_PB_CUSTOMER_UUID уже стоит — используем напрямую
		const customerUuid: string | undefined = snap.UF_CRM_PB_CUSTOMER_UUID || undefined;

		// Снимок-диф: B24 шлёт ONCRM*UPDATE на любое касание сущности. Сравниваем
		// свежий snap с предыдущим снимком. Если значимые поля не изменились —
		// событие в KBD-ленту не шлём (убирает поток дублей «lead обновлён»).
		// Если изменились — в summary пишем «было → стало».
		const snapWhere = { entityType_entityId: { entityType: entity, entityId } };
		let changes: Array<{ field: string; old: any; new: any }> = [];
		const prevSnap = await (this.prisma as any).b24EntitySnapshot
			.findUnique({ where: snapWhere })
			.catch(() => null);
		if (action === "updated") {
			if (!prevSnap) {
				// Снимка ещё нет — диф построить не из чего. Раньше слали пустое
				// событие с [STATUS=...], но это шум: customer-uuid-sync касается
				// каждой сущности по разу, и каждое первое касание превращалось
				// в бессмысленное «обновлён». Молча фиксируем baseline —
				// следующее обновление уже сравнится по дифу.
				await (this.prisma as any).b24EntitySnapshot
					.upsert({
						where: snapWhere,
						create: { entityType: entity, entityId, fields: snap },
						update: { fields: snap },
					})
					.catch(() => undefined);
				return { ok: true, reason: "snapshot baseline created" };
			}
			changes = this._diffSnapshots(prevSnap.fields || {}, snap);
			if (changes.length === 0) {
				// Ничего значимого не изменилось — обновляем снимок, событие не шлём.
				await (this.prisma as any).b24EntitySnapshot
					.update({ where: snapWhere, data: { fields: snap } })
					.catch(() => undefined);
				return { ok: true, reason: "no meaningful change" };
			}
		}
		await (this.prisma as any).b24EntitySnapshot
			.upsert({
				where: snapWhere,
				create: { entityType: entity, entityId, fields: snap },
				update: { fields: snap },
			})
			.catch((e: any) => this.logger.warn(`snapshot upsert failed: ${e?.message || e}`));

		// Summary
		const title = snap.TITLE || `${snap.NAME || ""} ${snap.LAST_NAME || ""}`.trim() || `#${entityId}`;
		let summary = `${entity} ${action}: ${title}`;
		if (changes.length > 0) {
			const diffLines = await Promise.all(changes.map(async (c) => {
				const label = FIELD_LABELS[c.field] || c.field;
				const oldV = await this._fmtFieldValue(portalDomain, c.field, c.old);
				const newV = await this._fmtFieldValue(portalDomain, c.field, c.new);
				return `${label}: ${oldV} → ${newV}`;
			}));
			summary += "\n" + diffLines.join("\n");
		} else {
			// action === "added" — диф построить не из чего, показываем статус.
			if (entity !== "contact" && snap.STATUS_ID) summary += ` [STATUS=${snap.STATUS_ID}]`;
			if (entity === "deal" && snap.STAGE_ID) summary += ` [STAGE=${snap.STAGE_ID}]`;
		}

		const eventBody: Record<string, any> = {
			source: `b24_${entity}`,
			eventType: `${entity}_${action}`,
			summary: summary.slice(0, 4000),
			payload: {
				entityId, action,
				title,
				status: snap.STATUS_ID,
				stage: snap.STAGE_ID,
				phone, email,
				rawEvent: ev,
			},
			operator: String(snap.ASSIGNED_BY_ID || ""),
		};
		if (customerUuid) eventBody.customerUuid = customerUuid;
		else eventBody.resolveAlias = resolveAlias;
		eventBody[`b24${entity.charAt(0).toUpperCase() + entity.slice(1)}Id`] = entityId;

		await this._eventsIngest(eventBody);

		// Customer-360 auto-promote: когда B24 шлёт ONCRMCONTACTADD — это значит
		// клиент сконвертился из лида в контакт (или создан напрямую как
		// контакт). customer-service выдаёт ему customer_no, display_code
		// меняется с L-XXXXXX на PB-N.
		if (entity === "contact" && action === "added") {
			await this._csPromote(String(entityId));
		}
		return { ok: true };
	}

	/**
	 * Перепривязка UF_CRM_PB_CUSTOMER_UUID на лидах/контактах/сделках B24
	 * с одного customer-UUID на другой. Вызывается customer-service при cutover
	 * («разъединение клиента по дате»): customer-service перевешивает события
	 * в ClickHouse и присылает сюда b24-id затронутых сущностей. Между
	 * апдейтами — пауза (B24 rate-limit на массовых операциях).
	 */
	async repointCustomerUuid(input: {
		newUuid: string;
		leadIds: number[];
		contactIds: number[];
		dealIds: number[];
	}): Promise<{ ok: boolean; updated: number; failed: number }> {
		const users = await (this.prisma as any).user.findMany({ take: 1 });
		const portalDomain = users[0]?.portalDomain;
		if (!portalDomain) return { ok: false, updated: 0, failed: 0 };
		const targets: Array<{ entity: "lead" | "contact" | "deal"; id: number }> = [
			...input.leadIds.map((id) => ({ entity: "lead" as const, id })),
			...input.contactIds.map((id) => ({ entity: "contact" as const, id })),
			...input.dealIds.map((id) => ({ entity: "deal" as const, id })),
		];
		let updated = 0;
		let failed = 0;
		for (const t of targets) {
			try {
				await this.callBitrix24Method(
					portalDomain,
					`crm.${t.entity}.update`,
					{ id: t.id, fields: { UF_CRM_PB_CUSTOMER_UUID: input.newUuid } },
					undefined, 0, "customer360",
				);
				updated++;
			} catch (e: any) {
				failed++;
				this.logger.warn(`repoint ${t.entity} ${t.id} failed: ${e?.message || e}`);
			}
			// B24 rate-limit: не быстрее ~0.5 req/sec на массовых операциях.
			await new Promise((r) => setTimeout(r, 600));
		}
		this.logger.info(
			`repointCustomerUuid → ${input.newUuid}: updated=${updated} failed=${failed} of ${targets.length}`,
		);
		return { ok: true, updated, failed };
	}

	// ===== Снимки CRM-сущностей: диф «было → стало» ======================

	private _statusNamesCache: Map<string, string> | null = null;
	private _statusNamesCacheAt = 0;
	private readonly _userNameCache = new Map<string, string>();

	/** Стабильная сериализация: ключи объектов сортируются рекурсивно.
	 *  B24 возвращает phone/email/мессенджер-массивы с непостоянным порядком
	 *  ключей внутри объекта ({VALUE,TYPE_ID} vs {TYPE_ID,VALUE}) — без
	 *  нормализации это ловится как ложное «изменение поля». */
	private _canonical(v: any): string {
		const norm = (x: any): any => {
			if (Array.isArray(x)) return x.map(norm);
			if (x && typeof x === "object") {
				const o: Record<string, any> = {};
				for (const k of Object.keys(x).sort()) o[k] = norm(x[k]);
				return o;
			}
			return x;
		};
		return JSON.stringify(norm(v ?? null));
	}

	/** Изменённые поля между двумя снимками (служебные/авто-поля игнорируются). */
	private _diffSnapshots(
		prev: Record<string, any>,
		next: Record<string, any>,
	): Array<{ field: string; old: any; new: any }> {
		const out: Array<{ field: string; old: any; new: any }> = [];
		const keys = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})]);
		for (const k of keys) {
			if (SNAPSHOT_IGNORE_FIELDS.has(k)) continue;
			// UF_CRM_* (кастомные поля), UTM-метки и IM (служебная связка лида
			// с открытыми линиями) — техническая начинка. Их выставляет
			// автоматика при создании/обогащении лида: это не бизнес-событие,
			// в ленту «lead обновлён» не выносим.
			if (k.startsWith("UF_CRM_") || k.startsWith("UTM_") || k === "IM") continue;
			const a = (prev || {})[k];
			const b = (next || {})[k];
			if (this._canonical(a) === this._canonical(b)) continue;
			out.push({ field: k, old: a, new: b });
		}
		return out;
	}

	/** Справочник crm.status.list: `${ENTITY_ID}:${STATUS_ID}` → NAME. Кеш 1ч. */
	private async _loadStatusNames(domain: string): Promise<Map<string, string>> {
		if (this._statusNamesCache && Date.now() - this._statusNamesCacheAt < 3600_000) {
			return this._statusNamesCache;
		}
		const m = new Map<string, string>();
		try {
			const res: any = await this.callBitrix24Method(domain, "crm.status.list", {}, undefined, 0, "customer360");
			const rows: any[] = Array.isArray(res) ? res : (res?.items || []);
			for (const r of rows) {
				if (r?.ENTITY_ID && r?.STATUS_ID != null) {
					m.set(`${r.ENTITY_ID}:${r.STATUS_ID}`, String(r.NAME ?? r.STATUS_ID));
				}
			}
		} catch (e: any) {
			this.logger.warn(`crm.status.list failed: ${e?.message || e}`);
		}
		this._statusNamesCache = m;
		this._statusNamesCacheAt = Date.now();
		return m;
	}

	/** Имя сотрудника B24 по ID (кеш на время жизни процесса). */
	private async _userDisplayName(domain: string, id: string): Promise<string> {
		if (!id) return "—";
		if (this._userNameCache.has(id)) return this._userNameCache.get(id)!;
		let name = `#${id}`;
		try {
			const res: any = await this.callBitrix24Method(domain, "user.get", { ID: id }, undefined, 0, "customer360");
			const u = Array.isArray(res) ? res[0] : res;
			if (u) name = [u.NAME, u.LAST_NAME].filter(Boolean).join(" ").trim() || `#${id}`;
		} catch {
			// non-fatal — оставляем #id
		}
		this._userNameCache.set(id, name);
		return name;
	}

	/** Человекочитаемое значение поля для диф-сообщения. */
	private async _fmtFieldValue(domain: string, field: string, value: any): Promise<string> {
		if (value === null || value === undefined || value === "") return "—";
		// Многозначные поля B24 (PHONE/EMAIL/WEB/IM) — массив объектов {VALUE,…}.
		if (Array.isArray(value)) {
			const vals = value
				.map((it) => (it && typeof it === "object" ? it.VALUE : it))
				.filter((x) => x !== undefined && x !== null && x !== "");
			return vals.length ? vals.map(String).join(", ") : "—";
		}
		if (typeof value === "object") {
			return value.VALUE !== undefined ? String(value.VALUE) : "(объект)";
		}
		const v = String(value);
		if (field === "ASSIGNED_BY_ID" || field === "CREATED_BY_ID" || field === "MODIFY_BY_ID") {
			return this._userDisplayName(domain, v);
		}
		if (field === "STATUS_ID" || field === "SOURCE_ID" || field === "STAGE_ID") {
			const dict = await this._loadStatusNames(domain);
			const ent = field === "STATUS_ID" ? "STATUS" : field === "SOURCE_ID" ? "SOURCE" : null;
			if (ent && dict.has(`${ent}:${v}`)) return dict.get(`${ent}:${v}`)!;
			for (const [k, name] of dict) if (k.endsWith(`:${v}`)) return name;
			return v;
		}
		// Лимит щедрый — комментарии операторов/BitrixGPT обрезались на 100
		// символов («…»). Общий потолок summary (4000) остаётся подстраховкой.
		return v.length > 1000 ? v.slice(0, 1000) + "…" : v;
	}

	private async _csPromote(b24ContactId: string): Promise<void> {
		const url = (process.env.CUSTOMER_SERVICE_URL || "").replace(/\/+$/, "");
		const secret = process.env.CUSTOMER_SERVICE_SECRET || "";
		if (!url || !secret) return;
		try {
			// Сначала резолвим контакт в UUID
			const r0 = await axios.post(
				`${url}/customers/find-or-create`,
				{ aliasType: "b24_contact", aliasValue: b24ContactId, addedBy: "adapter-promote" },
				{ headers: { "X-Service-Secret": secret, "Content-Type": "application/json" }, timeout: 5000 },
			);
			const uuid = r0.data?.customer?.uuid;
			if (!uuid) return;
			const r = await axios.post(
				`${url}/customers/${uuid}/promote`,
				{ b24ContactId, addedBy: "adapter-promote" },
				{ headers: { "X-Service-Secret": secret, "Content-Type": "application/json" }, timeout: 5000 },
			);
			const newCode = r.data?.customer?.displayCode;
			if (newCode) {
				this.logger.info(`auto-promote contact ${b24ContactId} → ${newCode}`);
			}
		} catch (e: any) {
			this.logger.warn(
				`auto-promote contact ${b24ContactId} failed: ${e?.response?.data?.message || e.message}`,
			);
		}
	}

	// ===== Customer-360 sync ============================================
	// Backfill UF_CRM_PB_CUSTOMER_UUID для существующих лидов/контактов B24:
	// для каждого без UUID берём первый phone (или email) и вызываем
	// customer-service /find-or-create → пишем UUID в B24. Rate-limited.

	private async _csFindOrCreate(
		aliasType: string,
		aliasValue: string,
		addedBy = "adapter-sync",
	): Promise<{ uuid: string; created: boolean } | null> {
		const url = (process.env.CUSTOMER_SERVICE_URL || "").replace(/\/+$/, "");
		const secret = process.env.CUSTOMER_SERVICE_SECRET || "";
		if (!url || !secret) return null;
		try {
			const r = await axios.post(
				`${url}/customers/find-or-create`,
				{ aliasType, aliasValue, addedBy },
				{
					headers: { "X-Service-Secret": secret, "Content-Type": "application/json" },
					timeout: 5000,
				},
			);
			const c = r.data?.customer;
			if (!c?.uuid) return null;
			return { uuid: String(c.uuid), created: Boolean(r.data?.created) };
		} catch (e: any) {
			this.logger.warn(
				`customer-service find_or_create ${aliasType}=${aliasValue} failed: ${e?.response?.data?.message || e.message}`,
			);
			return null;
		}
	}

	private async _csAddAlias(
		uuid: string,
		aliasType: string,
		aliasValue: string,
	): Promise<boolean> {
		const url = (process.env.CUSTOMER_SERVICE_URL || "").replace(/\/+$/, "");
		const secret = process.env.CUSTOMER_SERVICE_SECRET || "";
		if (!url || !secret) return false;
		try {
			await axios.post(
				`${url}/customers/${uuid}/aliases`,
				{ aliasType, aliasValue, addedBy: "adapter-sync" },
				{
					headers: { "X-Service-Secret": secret, "Content-Type": "application/json" },
					timeout: 5000,
				},
			);
			return true;
		} catch (e: any) {
			const msg = e?.response?.data?.message || e.message;
			// Если alias уже привязан другому customer'у — это auto-merge ситуация,
			// customer-service вернёт 200 с autoMerged. Если 409 — alias уже наш.
			if (/already/i.test(String(msg))) return true;
			this.logger.warn(
				`customer-service add_alias ${aliasType}=${aliasValue} to ${uuid} failed: ${msg}`,
			);
			return false;
		}
	}

	private _pickFirstPhone(entity: any): string | null {
		const phones = entity?.PHONE;
		if (!Array.isArray(phones)) return null;
		for (const p of phones) {
			const v = String(p?.VALUE || "").trim();
			const digits = v.replace(/[^\d+]/g, "");
			if (digits.length >= 11) {
				return digits.startsWith("+") ? digits : ("+" + digits);
			}
		}
		return null;
	}

	private _pickFirstEmail(entity: any): string | null {
		const emails = entity?.EMAIL;
		if (!Array.isArray(emails)) return null;
		for (const e of emails) {
			const v = String(e?.VALUE || "").trim();
			if (v.includes("@")) return v.toLowerCase();
		}
		return null;
	}

	/**
	 * Один батч бэкфилла: берёт N entity без UF_CRM_PB_CUSTOMER_UUID, разрешает
	 * их в customer-service по phone/email, прописывает UUID в B24. Между
	 * entity спит rateMsec — лимит на нагрузку B24.
	 *
	 * Возвращает счётчики. Если processed < limit — батч исчерпал кандидатов
	 * (бэкфилл закончен для этой entity).
	 */
	async syncCustomerUuidBatch(opts: {
		entity: "lead" | "contact";
		limit?: number;
		rateMsec?: number;
	}): Promise<{
		entity: "lead" | "contact";
		fetched: number;
		updated: number;
		skipped_no_alias: number;
		skipped_no_name: number;
		failed: number;
	}> {
		const entity = opts.entity;
		const limit = Math.max(1, Math.min(50, opts.limit ?? 20));
		const rateMsec = Math.max(500, opts.rateMsec ?? 2000);

		const users = await (this.prisma as any).user.findMany({ take: 1 });
		const portalDomain = users[0]?.portalDomain;
		if (!portalDomain) {
			return { entity, fetched: 0, updated: 0, skipped_no_alias: 0, skipped_no_name: 0, failed: 0 };
		}
		const listMethod = `crm.${entity}.list`;
		const updateMethod = `crm.${entity}.update`;
		const list: any = await this.callBitrix24Method(portalDomain, listMethod, {
			filter: { "=UF_CRM_PB_CUSTOMER_UUID": "" },
			select: ["ID", "PHONE", "EMAIL", "TITLE", "NAME", "LAST_NAME"],
			order: { ID: "DESC" },
			start: 0,
		}, undefined, 0, "customer360");
		const items: any[] = Array.isArray(list) ? list : [];
		let updated = 0;
		let skippedNoAlias = 0;
		let skippedNoName = 0;
		let failed = 0;
		for (let i = 0; i < Math.min(items.length, limit); i++) {
			const item = items[i];
			const id = Number(item.ID);
			if (!id) { failed++; continue; }
			// Для contact B24 валидирует наличие NAME или LAST_NAME даже при UPDATE
			// одного UF поля. Контакты без обоих имён — обычно мусор/импорт, для
			// них bekfill UF UUID откладываем (skipped_no_name). Лиды имеют TITLE
			// который всегда заполнен, валидации нет.
			if (entity === "contact") {
				const hasName = String(item.NAME || "").trim().length > 0;
				const hasLast = String(item.LAST_NAME || "").trim().length > 0;
				if (!hasName && !hasLast) {
					skippedNoName++;
					if (i < limit - 1) await new Promise((r) => setTimeout(r, rateMsec));
					continue;
				}
			}
			const phone = this._pickFirstPhone(item);
			const email = this._pickFirstEmail(item);
			let resolved: { uuid: string; created: boolean } | null = null;
			if (phone) {
				resolved = await this._csFindOrCreate("phone", phone);
			}
			if (!resolved && email) {
				resolved = await this._csFindOrCreate("email", email);
			}
			if (!resolved) {
				// Нет alias'а — связываем по b24_lead/b24_contact как fallback.
				resolved = await this._csFindOrCreate(
					entity === "lead" ? "b24_lead" : "b24_contact",
					String(id),
				);
			}
			if (!resolved) {
				skippedNoAlias++;
				if (i < limit - 1) await new Promise((r) => setTimeout(r, rateMsec));
				continue;
			}
			// Добавляем b24_* alias чтобы customer-service знал про связь.
			await this._csAddAlias(
				resolved.uuid,
				entity === "lead" ? "b24_lead" : "b24_contact",
				String(id),
			);
			try {
				await this.callBitrix24Method(portalDomain, updateMethod, {
					id,
					fields: { UF_CRM_PB_CUSTOMER_UUID: resolved.uuid },
				}, undefined, 0, "customer360");
				updated++;
			} catch (e: any) {
				this.logger.warn(`${updateMethod} #${id} failed: ${e.message}`);
				failed++;
			}
			// Rate-limit: между entity. Последнюю не задерживаем.
			if (i < limit - 1) await new Promise((r) => setTimeout(r, rateMsec));
		}
		return {
			entity,
			fetched: items.length,
			updated,
			skipped_no_alias: skippedNoAlias,
			skipped_no_name: skippedNoName,
			failed,
		};
	}

	/**
	 * Обработчик outgoingMessageReceived от Green API — сообщение отправлено
	 * НЕ через API, а напрямую из приложения мессенджера (менеджер набрал в
	 * Telegram/MAX-приложении нашего аккаунта, минуя B24 и виджет). Зеркалим
	 * в открытую линию B24 как is_self_message — чтобы ответ менеджера был
	 * виден в B24-диалоге, а не терялся.
	 *
	 * Только Telegram/MAX: WA-исходящие с телефона покрывает
	 * handleOutgoingFromMobile (outgoingAPIMessageReceived). Наши собственные
	 * отправки из B24 идут через API → приходят как outgoingAPIMessageReceived,
	 * поэтому эха наших сообщений в outgoingMessageReceived нет.
	 */
	async handleOutgoingFromDevice(webhook: any): Promise<void> {
		const idInstance = String(webhook?.instanceData?.idInstance || "");
		if (!idInstance) return;
		let inst: any;
		try {
			inst = await (this.prisma as any).instance.findUnique({
				where: { idInstance: BigInt(idInstance) },
				include: { user: true },
			});
		} catch {
			return;
		}
		if (!inst || inst.bitrixLine == null) return;
		const provider = String((inst.settings as any)?.provider || "wa").toLowerCase();
		if (provider === "wa") return; // WA — отдельный путь (handleOutgoingFromMobile)

		const senderData = webhook?.senderData || {};
		const rawChatId = String(senderData?.chatId || "");
		if (!rawChatId || rawChatId.endsWith("@g.us")) return; // группы skip
		const clientChatId = rawChatId.replace(/@c\.us$/, "");
		if (!clientChatId) return;
		// Префикс sc_ — совпадает с тем, что adapter ставит при входящих
		// Telegram/MAX, иначе B24 заведёт отдельного chat-user'а → дубль сессии.
		const userKey = `sc_${clientChatId}`;

		const messageData = webhook?.messageData || {};
		const mtype = String(messageData?.typeMessage || "");
		let text = "";
		if (mtype === "textMessage") {
			text = String(messageData?.textMessageData?.textMessage || "");
		} else if (mtype === "extendedTextMessage") {
			text = String(messageData?.extendedTextMessageData?.text || "");
		} else {
			const fdata = messageData?.fileMessageData || {};
			text = `[${mtype.replace("Message", "") || "media"}]`
				+ (fdata.caption ? ` ${fdata.caption}` : "");
		}
		text = text.slice(0, 4000);
		if (!text) return;

		const portalDomain = inst.user?.portalDomain
			|| this.configService.get<string>("BITRIX_PORTAL_DOMAIN") || "1begovoy.bitrix24.ru";
		const displayName = String(senderData?.chatName || senderData?.senderName || clientChatId).trim() || clientChatId;

		const payload = {
			CONNECTOR: "social_connector",
			LINE: Number(inst.bitrixLine),
			MESSAGES: [{
				user: { id: userKey, name: displayName },
				message: {
					id: String(webhook?.idMessage || Date.now()),
					date: Math.floor(Date.now() / 1000),
					text,
				},
				chat: { id: userKey, name: displayName },
				extra: { is_self_message: true },
			}],
		};
		try {
			const r: any = await this.sendImconnectorMessage(portalDomain, payload);
			if (r?.error) {
				this.logger.warn(`outgoing-from-device mirror: b24 ${r.error}`);
			} else {
				this.logger.info(
					`outgoing-from-device: mirrored to line ${inst.bitrixLine} (${provider}, chat ${clientChatId})`,
				);
				// B24 создаёт лид из imconnector-сообщения, но «с мобильного»-
				// зеркало раньше не тегировало его — лид оставался без
				// UF_CRM_TG/MAX_CHAT_ID: невидимый карточке Customer-360 и не
				// связываемый с последующими сообщениями. Догоняем backfill'ом
				// (как виджет «написать первым»). Фоном, не блокируем webhook.
				const chatIdUf = provider === "max" ? "UF_CRM_MAX_CHAT_ID" : "UF_CRM_TG_CHAT_ID";
				void (async () => {
					try {
						const existing: any = await this.callBitrix24Method(
							portalDomain, "crm.lead.list",
							{ filter: { [chatIdUf]: clientChatId }, select: ["ID"] },
						);
						if (Array.isArray(existing) && existing.length > 0) return; // лид уже тегирован
						await this.backfillSendLead(portalDomain, {
							lineId: Number(inst.bitrixLine),
							userKey,
							chatId: clientChatId,
							phoneE164: null,
							channelLabel: provider === "max" ? "MAX" : "Telegram",
							displayNameInMirror: displayName,
						});
					} catch (e: any) {
						this.logger.warn(`outgoing-from-device backfill failed: ${e?.message || e}`);
					}
				})();
			}
		} catch (e: any) {
			this.logger.warn(`outgoing-from-device mirror failed: ${e?.message || e}`);
		}
	}

	/**
	 * Обработчик outgoingAPIMessageReceived от Green API — оператор написал
	 * клиенту с МОБИЛЬНОГО WhatsApp (не из B24). Цель — оставить след в
	 * B24 чтобы в карточке клиента было видно факт ответа.
	 *
	 * Действия:
	 * 1. timeline-comment в открытый deal/lead клиента (по phone клиента)
	 *    с текстом сообщения + меткой «📱 ответ с мобильного WA».
	 * 2. Customer-360 event ingest (source=bridge_wa, eventType=message_out,
	 *    payload включает sendByMobile: true) — пойдёт в CH + KBD-лента.
	 *
	 * Sebsenderом B24 не видит ни в Bizz-chat ни в OpenLines — там нужна
	 * B24-side сессия (а её нет, оператор писал мимо B24). Это compromise:
	 * timeline-comment виден в карточке.
	 */
	async handleOutgoingFromMobile(webhook: any): Promise<void> {
		const senderData = webhook?.senderData || {};
		const ourWid = String(webhook?.instanceData?.wid || "");
		const senderWid = String(senderData?.sender || "");
		// Игнорируем если sender != наш wid (это echo от echo, не наша операция)
		if (!ourWid || !senderWid || ourWid !== senderWid) return;

		const clientChatId = String(senderData?.chatId || "");
		if (!clientChatId || clientChatId.endsWith("@g.us")) return;  // группы skip
		const phoneDigits = clientChatId.split("@", 1)[0];
		if (!/^\d{10,15}$/.test(phoneDigits)) return;
		const phone = "+" + phoneDigits;

		const messageData = webhook?.messageData || {};
		const mtype = String(messageData?.typeMessage || "");
		let text = "";
		if (mtype === "textMessage") {
			text = String(messageData?.textMessageData?.textMessage || "");
		} else if (mtype === "extendedTextMessage") {
			text = String(messageData?.extendedTextMessageData?.text || "");
		} else if (mtype === "imageMessage" || mtype === "videoMessage"
			|| mtype === "documentMessage" || mtype === "audioMessage") {
			const fdata = messageData?.fileMessageData || {};
			text = `[${mtype.replace("Message", "")}]` +
				(fdata.caption ? ` ${fdata.caption}` : ``) +
				(fdata.fileName ? ` (${fdata.fileName})` : ``);
		} else {
			text = `[${mtype || "media"}]`;
		}
		text = text.slice(0, 2000);

		const comment =
			`📱 <b>Ответ оператора с мобильного WhatsApp</b>\n` +
			`Клиент: ${phone}\n\n${text}`;

		try {
			const result = await this.addTimelineCommentByPhone(phone, comment);
			this.logger.info(
				`outgoing-from-mobile: timeline-comment ${result.ok ? "OK" : "skipped"} (${result.entity || "?"}/${result.entityId || "?"}: ${result.reason || ""})`,
			);
		} catch (e: any) {
			this.logger.warn(`outgoing-from-mobile timeline failed: ${e.message}`);
		}

		// Customer-360 event НЕ эмитим: wa-tg-bridge видит каждое исходящее WA
		// через webhook Green API и сам пишет message_out в customer_events —
		// с резолвом оператора (operator-hint / TG-автор / «с мобильного»).
		// Параллельный эмит отсюда давал дубль события + пустого оператора.

		// Operator-hint для зеркала: Green API не знает, кто физически писал
		// с мобильного. Берём оператора-исполнителя открытой B24-сессии этого
		// клиента и шлём bridge'у hint с source="mobile" — он заменит безликое
		// «↗ отправлено с мобильного» на «🧑‍💼 ФИО (с моб.)». Best-effort.
		const idMessage = String(webhook?.idMessage || "");
		if (idMessage) {
			void (async () => {
				try {
					const users = await (this.prisma as any).user.findMany({ take: 1 });
					const portalDomain = users[0]?.portalDomain;
					if (!portalDomain) return;
					const opId = await this.resolveActiveOperatorByPhone(portalDomain, phone);
					if (!opId) return;
					await this.sendOperatorHintToBridge(portalDomain, opId, idMessage, "mobile");
				} catch (e: any) {
					this.logger.debug(`outgoing-from-mobile hint resolve failed: ${e.message}`);
				}
			})();
		}
	}

	/**
	 * Найти открытую сделку или лид клиента по phone и добавить timeline-comment.
	 * Используется bridge'ем для событий типа avatar_changed (Customer-360
	 * Этап 5): не отправляем сообщение клиенту, не меняем PHOTO — просто
	 * фиксируем факт в B24-карточке.
	 *
	 * Поиск: crm.duplicate.findbycomm по phone → CONTACT_ID → ищем
	 * открытую сделку / лид → добавляем comment.
	 */
	async addTimelineCommentByPhone(
		phone: string, text: string,
	): Promise<{ ok: boolean; entity?: "deal" | "lead" | "contact"; entityId?: number; reason?: string }> {
		const users = await (this.prisma as any).user.findMany({ take: 1 });
		const portalDomain = users[0]?.portalDomain;
		if (!portalDomain) return { ok: false, reason: "no portal" };
		try {
			const dup: any = await this.callBitrix24Method(portalDomain, "crm.duplicate.findbycomm", {
				type: "PHONE",
				values: [phone],
				entity_type: "CONTACT",
			}, undefined, 0, "customer360");
			const contactId = Number(dup?.CONTACT?.[0]);
			if (!contactId) return { ok: false, reason: "no contact" };

			// Сначала ищем открытую сделку
			const deals: any = await this.callBitrix24Method(portalDomain, "crm.deal.list", {
				filter: { CONTACT_ID: contactId, "!STAGE_SEMANTIC_ID": ["F", "P"] },
				select: ["ID"],
				order: { DATE_CREATE: "DESC" },
			}, undefined, 0, "customer360");
			if (Array.isArray(deals) && deals.length > 0) {
				const dealId = Number(deals[0].ID);
				const cid = await this.addTimelineComment(portalDomain, "deal", dealId, text, "customer360");
				if (cid) return { ok: true, entity: "deal", entityId: dealId };
			}
			// Потом открытый лид
			const leads: any = await this.callBitrix24Method(portalDomain, "crm.lead.list", {
				filter: { CONTACT_ID: contactId, "!STATUS_SEMANTIC_ID": ["F", "S"] },
				select: ["ID"],
				order: { DATE_CREATE: "DESC" },
			}, undefined, 0, "customer360");
			if (Array.isArray(leads) && leads.length > 0) {
				const leadId = Number(leads[0].ID);
				const cid = await this.addTimelineComment(portalDomain, "lead", leadId, text, "customer360");
				if (cid) return { ok: true, entity: "lead", entityId: leadId };
			}
			return { ok: false, reason: "no open deal/lead for contact", entity: "contact", entityId: contactId };
		} catch (e: any) {
			return { ok: false, reason: e.message };
		}
	}

	/**
	 * Аналог addTimelineCommentByPhone, но для TG-бот-каналов (UF_CRM_TG_CHAT_ID).
	 * Используется при /nnn в супергруппе TG-bot зеркала (@begovoy_bot /
	 * @begovoy1support_bot): у TG-бот клиента нет phone, искать нужно по chatId.
	 * Возвращает {ok, entity, entityId, reason} — как сестринский метод.
	 */
	async addTimelineCommentByTgChat(
		tgChatId: string, text: string,
	): Promise<{ ok: boolean; entity?: "deal" | "lead" | "contact"; entityId?: number; reason?: string }> {
		const users = await (this.prisma as any).user.findMany({ take: 1 });
		const portalDomain = users[0]?.portalDomain;
		if (!portalDomain) return { ok: false, reason: "no portal" };
		try {
			// Контакт по UF_CRM_TG_CHAT_ID — для TG-бот клиента может не быть phone
			const contacts: any = await this.callBitrix24Method(portalDomain, "crm.contact.list", {
				filter: { "UF_CRM_TG_CHAT_ID": tgChatId },
				select: ["ID"],
				order: { ID: "DESC" },
			}, undefined, 0, "customer360");
			const contactId = Array.isArray(contacts) && contacts.length > 0 ? Number(contacts[0].ID) : null;

			// Открытая сделка контакта
			if (contactId) {
				const deals: any = await this.callBitrix24Method(portalDomain, "crm.deal.list", {
					filter: { CONTACT_ID: contactId, "!STAGE_SEMANTIC_ID": ["F", "P"] },
					select: ["ID"],
					order: { DATE_CREATE: "DESC" },
				}, undefined, 0, "customer360");
				if (Array.isArray(deals) && deals.length > 0) {
					const dealId = Number(deals[0].ID);
					const cid = await this.addTimelineComment(portalDomain, "deal", dealId, text, "customer360");
					if (cid) return { ok: true, entity: "deal", entityId: dealId };
				}
			}

			// Открытый лид — сначала по контакту (если есть), потом по UF_CRM_TG_CHAT_ID
			const leadFilters: Array<Record<string, any>> = [];
			if (contactId) {
				leadFilters.push({ CONTACT_ID: contactId, "!STATUS_SEMANTIC_ID": ["F", "S"] });
			}
			leadFilters.push({ "UF_CRM_TG_CHAT_ID": tgChatId, "!STATUS_SEMANTIC_ID": ["F", "S"] });
			for (const filter of leadFilters) {
				const leads: any = await this.callBitrix24Method(portalDomain, "crm.lead.list", {
					filter, select: ["ID"], order: { DATE_CREATE: "DESC" },
				}, undefined, 0, "customer360");
				if (Array.isArray(leads) && leads.length > 0) {
					const leadId = Number(leads[0].ID);
					const cid = await this.addTimelineComment(portalDomain, "lead", leadId, text, "customer360");
					if (cid) return { ok: true, entity: "lead", entityId: leadId };
				}
			}

			// Last resort — комментарий в контакте
			if (contactId) {
				const cid = await this.addTimelineComment(portalDomain, "contact", contactId, text, "customer360");
				if (cid) return { ok: true, entity: "contact", entityId: contactId };
			}
			return { ok: false, reason: contactId ? "no open deal/lead" : "no contact by UF_CRM_TG_CHAT_ID" };
		} catch (e: any) {
			return { ok: false, reason: e.message };
		}
	}

	/**
	 * crm.timeline.comment.add в указанную сделку/лид. Возвращает id комментария
	 * или null при ошибке (логируется warn). Используется в widget /send для
	 * фиксации исходящего сообщения в открытой сущности клиента вместо создания
	 * imconnector-сессии (см. findOpenCrmEntityForContact).
	 */
	async addTimelineComment(
		portalDomain: string,
		entityType: "deal" | "lead" | "contact",
		entityId: number,
		text: string,
		appKind: "social" | "customer360" = "social",
	): Promise<number | null> {
		try {
			const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
			const result: any = await this.callBitrix24Method(portalDomain, "crm.timeline.comment.add", {
				fields: {
					ENTITY_ID: entityId,
					ENTITY_TYPE: entityType,
					COMMENT: safe,
				},
			}, undefined, 0, appKind);
			return result ? Number(result) : null;
		} catch (e: any) {
			this.logger.warn(`addTimelineComment(${entityType}/${entityId}) failed: ${e.message}`);
			return null;
		}
	}

	/**
	 * Кладёт транскрипт звонка timeline-комментом во ВСЕ B24-сущности клиента
	 * (лиды + сделки + контакты), найденные по UF_CRM_PB_CUSTOMER_UUID.
	 * Вызывается из customer-360 calls-transcribe через internal endpoint
	 * /webhooks/internal/transcript-to-b24.
	 */
	async addTranscriptToB24(
		customerUuid: string, text: string,
	): Promise<{ ok: boolean; posted: number; entities: string[]; reason?: string }> {
		const users = await (this.prisma as any).user.findMany({ take: 1 });
		const portalDomain = users[0]?.portalDomain;
		if (!portalDomain) return { ok: false, posted: 0, entities: [], reason: "no portal" };
		const filter = { "=UF_CRM_PB_CUSTOMER_UUID": customerUuid };
		const targets: { type: "lead" | "deal" | "contact"; id: number }[] = [];
		try {
			for (const [method, type] of [
				["crm.lead.list", "lead"],
				["crm.deal.list", "deal"],
				["crm.contact.list", "contact"],
			] as const) {
				const rows: any = await this.callBitrix24Method(
					portalDomain, method, { filter, select: ["ID"] },
					undefined, 0, "customer360",
				);
				if (Array.isArray(rows)) {
					for (const r of rows) {
						const id = Number(r.ID);
						if (id) targets.push({ type, id });
					}
				}
			}
		} catch (e: any) {
			return { ok: false, posted: 0, entities: [], reason: e.message };
		}
		if (targets.length === 0) {
			return { ok: false, posted: 0, entities: [], reason: "no b24 entities for uuid" };
		}
		let posted = 0;
		const entities: string[] = [];
		for (const t of targets) {
			const cid = await this.addTimelineComment(portalDomain, t.type, t.id, text, "customer360");
			if (cid) {
				posted++;
				entities.push(`${t.type}#${t.id}`);
			}
			// B24 rate-limit: пауза между комментами (массовых операций нет,
			// но звонки идут пачками — бережёмся).
			await new Promise((res) => setTimeout(res, 400));
		}
		return { ok: posted > 0, posted, entities };
	}

	/**
	 * Резолвит лид/контакт B24 «на лету» по идентификаторам клиента
	 * Customer-360. Используется KBD-карточкой wa-tg-bridge: aliases
	 * b24_lead/b24_contact часто отсутствуют (особенно у TG-клиентов),
	 * поэтому ищем сущности напрямую в B24.
	 * Возвращает первый найденный лид и первый найденный контакт.
	 */
	async resolveB24Entities(input: {
		uuid?: string; phone?: string; tgChatId?: string; maxChatId?: string;
	}): Promise<{ leadId: number | null; contactId: number | null }> {
		const users = await (this.prisma as any).user.findMany({ take: 1 });
		const portalDomain = users[0]?.portalDomain;
		if (!portalDomain) return { leadId: null, contactId: null };

		const { uuid, phone, tgChatId, maxChatId } = input;

		// Фильтры в порядке приоритета: uuid → tgChatId → maxChatId.
		const filters: Record<string, string>[] = [];
		if (uuid) filters.push({ "=UF_CRM_PB_CUSTOMER_UUID": uuid });
		if (tgChatId) filters.push({ "UF_CRM_TG_CHAT_ID": tgChatId });
		if (maxChatId) filters.push({ "UF_CRM_MAX_CHAT_ID": maxChatId });

		const findByList = async (
			method: "crm.lead.list" | "crm.contact.list",
		): Promise<number | null> => {
			for (const filter of filters) {
				try {
					const rows: any = await this.callBitrix24Method(
						portalDomain, method,
						{ filter, select: ["ID"], order: { ID: "DESC" } },
						undefined, 0, "customer360",
					);
					if (Array.isArray(rows) && rows.length > 0) {
						const id = Number(rows[0].ID);
						if (id) return id;
					}
				} catch (e: any) {
					this.logger.warn(`resolveB24Entities ${method} failed: ${e.message}`);
				}
			}
			return null;
		};

		const findByPhone = async (
			entityType: "LEAD" | "CONTACT",
		): Promise<number | null> => {
			if (!phone) return null;
			try {
				const result: any = await this.callBitrix24Method(
					portalDomain, "crm.duplicate.findbycomm",
					{ entity_type: entityType, type: "PHONE", values: [phone] },
					undefined, 0, "customer360",
				);
				const id = Number(result?.[entityType]?.[0]);
				if (id) return id;
			} catch (e: any) {
				this.logger.warn(`resolveB24Entities findbycomm ${entityType} failed: ${e.message}`);
			}
			return null;
		};

		let leadId = await findByList("crm.lead.list");
		if (leadId === null) leadId = await findByPhone("LEAD");

		let contactId = await findByList("crm.contact.list");
		if (contactId === null) contactId = await findByPhone("CONTACT");

		return { leadId, contactId };
	}

	// ===== Автоответ в нерабочее время (10:00–19:00 МСК) ===============

	/** true — сейчас нерабочее время (вне 10:00–19:00 по Москве). */
	private isOffHoursMsk(): boolean {
		const mskHour = (new Date().getUTCHours() + 3) % 24;
		return mskHour < 10 || mskHour >= 19;
	}

	/**
	 * Начало текущего нерабочего окна — последние наступившие 19:00 МСК
	 * (= 16:00 UTC). Считаем в чистом UTC: если сейчас UTC-час < 16, то
	 * ближайшие прошедшие 16:00 UTC были вчера. Используется для дедупа:
	 * один автоответ на чат за одно нерабочее окно (ночь).
	 */
	private offHoursWindowStart(): Date {
		const now = new Date();
		const d = new Date(now);
		d.setUTCHours(16, 0, 0, 0); // 19:00 МСК
		if (now.getUTCHours() < 16) d.setUTCDate(d.getUTCDate() - 1);
		return d;
	}

	/**
	 * Дедуп автоответа: true (и помечает чат) — если в текущем нерабочем
	 * окне этому чату ещё не отвечали. false — уже отвечали либо ошибка БД
	 * (при ошибке не шлём, чтобы не спамить).
	 */
	private async claimOffHoursReply(chatKey: string): Promise<boolean> {
		try {
			const windowStart = this.offHoursWindowStart();
			const existing = await (this.prisma as any).offHoursReply.findUnique({
				where: { chatKey },
			});
			if (existing && existing.lastRepliedAt >= windowStart) {
				return false;
			}
			await (this.prisma as any).offHoursReply.upsert({
				where: { chatKey },
				create: { chatKey, lastRepliedAt: new Date() },
				update: { lastRepliedAt: new Date() },
			});
			return true;
		} catch (e: any) {
			this.logger.warn(`off-hours dedup failed for ${chatKey}: ${e.message}`);
			return false;
		}
	}

	/**
	 * Автоответ «нерабочее время» на входящее WA/TG/MAX-сообщение.
	 * Вызывается фоном из webhooks.controller — НЕ блокирует основной relay
	 * и не валит его при ошибке.
	 */
	async maybeOffHoursAutoReply(webhook: GreenApiWebhook): Promise<void> {
		if (webhook.typeWebhook !== "incomingMessageReceived") return;
		if (!this.isOffHoursMsk()) return;
		const chatId = String((webhook as any).senderData?.chatId || "");
		const idInstance = (webhook as any).instanceData?.idInstance;
		if (!chatId || !idInstance) return;
		// Группы и каналы не трогаем — автоответ только в личные диалоги.
		if (chatId.endsWith("@g.us") || chatId.startsWith("-")) return;

		const chatKey = `${idInstance}:${chatId}`;
		if (!(await this.claimOffHoursReply(chatKey))) return;

		try {
			const instance = await this.prisma.getInstanceByIdWithUser(idInstance);
			if (!instance) return;
			const apiUrl = greenApiUrlForInstance(String(idInstance));
			await axios.post(
				`${apiUrl}/waInstance${idInstance}/sendMessage/${instance.apiTokenInstance}`,
				{ chatId, message: OFF_HOURS_REPLY_TEXT },
				{ timeout: 15000 },
			);
			this.logger.info(`off-hours auto-reply sent → ${chatKey}`);
		} catch (e: any) {
			this.logger.warn(`off-hours auto-reply send failed for ${chatKey}: ${e.message}`);
		}
	}

	/** Автоответ «нерабочее время» в Instagram Direct через i2crm. */
	private async sendOffHoursReplyIg(clientId: string): Promise<void> {
		const apiBase = this.configService.get<string>("I2CRM_API_BASE") || "https://app.i2crm.ru/api_v1";
		const targetKey = this.configService.get<string>("I2CRM_TARGET_KEY_PUBLICAPI");
		const accountId = this.configService.get<string>("I2CRM_INSTAGRAM_ACCOUNT_ID");
		if (!targetKey || !accountId) return;
		try {
			await axios.post(
				`${apiBase}/target/feedback`,
				{
					domain: "instagram",
					source: String(accountId),
					client: String(clientId),
					type: "direct",
					text: OFF_HOURS_REPLY_TEXT,
				},
				{ params: { key: targetKey }, timeout: 60000, validateStatus: () => true },
			);
			this.logger.info(`off-hours auto-reply sent → ig:${clientId}`);
		} catch (e: any) {
			this.logger.warn(`off-hours IG auto-reply failed for ${clientId}: ${e.message}`);
		}
	}

	/**
	 * Backfill свежесозданного лида от imconnector.send.messages (widget /send).
	 * B24 создаёт лид асинхронно после первой messages — без CONTACT_ID и с
	 * технической TITLE/NAME (chatId или E.164). Этот метод догоняет лид и
	 * проставляет CONTACT_ID + UF_CRM_*_CHAT_ID + UF_CRM_NF_YM_CLIENT_ID,
	 * чтобы оператор видел его в карточке контакта.
	 *
	 * Если лид не нашёлся за все попытки — non-fatal (B24 мог не создать лид,
	 * например если в настройках линии «не создавать лид»).
	 */
	async backfillSendLead(
		portalDomain: string,
		params: {
			lineId: number;
			userKey: string;  // sc_<chatId> / wa_<phone> — приходит в TITLE как user.name fallback
			chatId: string;   // для UF_CRM_TG_CHAT_ID / UF_CRM_MAX_CHAT_ID
			phoneE164: string | null;
			contactId?: number;  // опционально: у клиента «с мобильного» контакта ещё нет
			contactName?: string;
			contactLastName?: string;
			channelLabel: string;
			displayNameInMirror?: string; // что мы передали как user.name в imconnector
			openEntity?: { kind: "deal" | "lead"; id: number };
		},
	): Promise<{ leadId?: number; updated?: boolean }> {
		const { lineId, userKey, chatId, phoneE164, contactId, contactName, contactLastName, channelLabel, displayNameInMirror, openEntity } = params;
		let sourceId: string | undefined;
		try {
			const config: any = await this.callBitrix24Method(portalDomain, "imopenlines.config.get", {
				CONFIG_ID: lineId,
			});
			sourceId = config?.CRM_SOURCE;
		} catch (e: any) {
			this.logger.warn(`backfillSendLead: failed to read line ${lineId} CRM_SOURCE: ${e.message}`);
		}

		const chatIdUfMap: Record<string, string> = {
			"Telegram": "UF_CRM_TG_CHAT_ID",
			"MAX": "UF_CRM_MAX_CHAT_ID",
			"Instagram": "UF_CRM_IG_CHAT_ID",
		};
		const chatIdUf = chatIdUfMap[channelLabel];
		const titleNeedles = [chatId, userKey, displayNameInMirror, phoneE164?.replace(/^\+/, "")]
			.filter((x): x is string => Boolean(x));

		// B24 создаёт лид через 0-15с после imconnector.send.messages. Шесть попыток,
		// первая через 3с (B24 обычно успевает), дальше 4с между.
		for (let attempt = 0; attempt < 6; attempt++) {
			await new Promise((res) => setTimeout(res, attempt === 0 ? 3000 : 4000));
			try {
				const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
				const filter: Record<string, any> = { ">DATE_CREATE": cutoff };
				if (sourceId) filter["=SOURCE_ID"] = sourceId;
				const leads: any = await this.callBitrix24Method(portalDomain, "crm.lead.list", {
					filter,
					select: ["ID", "TITLE", "NAME", "LAST_NAME", "CONTACT_ID", "PHONE", "UF_CRM_NF_YM_CLIENT_ID", chatIdUf || "UF_CRM_TG_CHAT_ID"],
					order: { DATE_CREATE: "DESC" },
				});
				if (!Array.isArray(leads) || leads.length === 0) continue;
				const target = leads.find((l: any) => {
					const title = String(l?.TITLE || "");
					return titleNeedles.some((n) => title.includes(n));
				});
				if (!target) continue;
				const updateFields: Record<string, any> = {};
				if (contactId && (!target.CONTACT_ID || Number(target.CONTACT_ID) === 0)) {
					updateFields.CONTACT_ID = contactId;
				}
				if (chatIdUf && !target[chatIdUf]) {
					updateFields[chatIdUf] = chatId;
				}
				if (!target.UF_CRM_NF_YM_CLIENT_ID) {
					updateFields.UF_CRM_NF_YM_CLIENT_ID = "-";
				}
				if (phoneE164 && !(Array.isArray(target.PHONE) && target.PHONE.length > 0)) {
					updateFields.PHONE = [{ VALUE: phoneE164, VALUE_TYPE: "MOBILE" }];
				}
				// Имя клиента в лиде: B24 при создании кладёт displayName в NAME
				// (или в NAME+LAST_NAME, если был пробел). Если у нас есть real
				// имя контакта — поправляем, чтобы оператор видел «Олег Ремфон»
				// вместо «396522892» или «79253267624».
				if (contactName && (!target.NAME || /^\+?\d+$/.test(String(target.NAME).trim()) || String(target.NAME).trim() === userKey)) {
					updateFields.NAME = contactName;
					if (contactLastName) updateFields.LAST_NAME = contactLastName;
				}
				// Когда у клиента есть открытая сделка/лид — этот свежий
				// imconnector-лид закрываем как «Дубликат» (STATUS_ID=12,
				// семантика F в портале 1begovoy.bitrix24.ru) и привязываем
				// к открытой сущности через UF_CRM_LEAD_ID. Сама сессия
				// открытой линии остаётся в Контакт-центре — её id внутри B24
				// привязан к этому лиду, не теряется.
				if (openEntity) {
					updateFields.STATUS_ID = "12";
					if (openEntity.kind === "lead") {
						updateFields.UF_CRM_LEAD_ID = openEntity.id;
					}
					const origTitle = String(target.TITLE || "").trim();
					const prefix = `[Дубликат → ${openEntity.kind} ${openEntity.id}]`;
					if (!origTitle.startsWith("[Дубликат")) {
						updateFields.TITLE = origTitle ? `${prefix} ${origTitle}` : prefix;
					}
				}
				if (Object.keys(updateFields).length === 0) {
					this.logger.info(`backfillSendLead: lead ${target.ID} already linked, nothing to update`);
					return { leadId: Number(target.ID), updated: false };
				}
				await this.callBitrix24Method(portalDomain, "crm.lead.update", {
					id: target.ID,
					fields: updateFields,
				});
				const action = openEntity
					? `marked as duplicate of ${openEntity.kind} ${openEntity.id}`
					: `CONTACT_ID=${contactId}`;
				this.logger.info(`backfillSendLead: lead ${target.ID} → ${action} (${Object.keys(updateFields).join(",")})`);
				return { leadId: Number(target.ID), updated: true };
			} catch (e: any) {
				this.logger.warn(`backfillSendLead attempt ${attempt + 1} failed: ${e?.message || e}`);
			}
		}
		this.logger.warn(`backfillSendLead: no matching lead found after 6 attempts (userKey=${userKey}, chatId=${chatId})`);
		return {};
	}

	// ===== Orphan-lead linker (task #68) =================================
	// Используется только в ONCRMLEADADD path. Когда менеджер написал клиенту
	// через native B24 OpenLine UI — B24 не знает про наши UF_CRM_*_CHAT_ID и
	// создаёт лид без привязки к контакту. Сюда «достраиваем»: CONTACT_ID,
	// UF_CRM_*_CHAT_ID, имя клиента, и если у клиента есть открытая
	// сделка/лид — закрываем orphan как «Дубликат». Симметрично
	// backfillSendLead, но входная точка — событие, не наш widget.

	/** Маппинг канала из TITLE → UF-поле контакта. WhatsApp идёт по phone
	 *  (своего UF_CRM_WA_CHAT_ID на портале 1begovoy.bitrix24.ru нет). */
	private readonly orphanChannelChatIdUf: Record<string, string> = {
		Telegram: "UF_CRM_TG_CHAT_ID",
		MAX: "UF_CRM_MAX_CHAT_ID",
		Instagram: "UF_CRM_IG_CHAT_ID",
	};

	/** Парс TITLE orphan-лида.
	 *  Формат native B24: `<chat_id> - <CHANNEL> <phone?>` (например
	 *  `32656502 - MAX 79584983354`). Возвращает null если pattern не подошёл —
	 *  тогда orphan-link не запускается. */
	private _parseOrphanLeadTitle(title: string): {
		chatId: string;
		channelLabel: "Telegram" | "MAX" | "Instagram" | "WhatsApp";
		phoneFromTitle: string | null;
	} | null {
		if (!title) return null;
		const t = title.trim();
		// Уже-обработанные дубликаты не трогаем
		if (t.startsWith("[Дубликат")) return null;
		// chat_id может содержать буквы (sc_..., wa_..., tgbot_...)
		const m = t.match(
			/^([\w]+)\s*-\s*(MAX|Telegram|Instagram|WhatsApp|Whatsapp|TG|WA|IG)(?:\s+(\+?\d{6,16}))?/i,
		);
		if (!m) return null;
		const [, chatId, rawChannel, rawPhone] = m;
		const upper = rawChannel.toUpperCase();
		let channelLabel: "Telegram" | "MAX" | "Instagram" | "WhatsApp";
		if (upper === "MAX") channelLabel = "MAX";
		else if (upper === "TELEGRAM" || upper === "TG") channelLabel = "Telegram";
		else if (upper === "INSTAGRAM" || upper === "IG") channelLabel = "Instagram";
		else channelLabel = "WhatsApp";
		let phoneFromTitle: string | null = null;
		if (rawPhone) {
			const digits = rawPhone.replace(/\D/g, "");
			if (digits.length >= 10) phoneFromTitle = "+" + digits;
		}
		return { chatId, channelLabel, phoneFromTitle };
	}

	/** Поиск открытой сущности у контакта: приоритет сделки, потом лиды.
	 *  «Открытая» — CLOSED=N для сделок, STATUS_ID не в финальных для лидов.
	 *  Себя в выдачу не возвращает — поиск идёт по CONTACT_ID, а сам orphan
	 *  ещё без привязки. */
	private async _findOpenEntityForContact(
		portalDomain: string,
		contactId: number,
	): Promise<{ kind: "deal" | "lead"; id: number } | null> {
		try {
			const deals: any = await this.callBitrix24Method(
				portalDomain,
				"crm.deal.list",
				{
					filter: { CONTACT_ID: contactId, CLOSED: "N" },
					select: ["ID"],
					order: { DATE_CREATE: "DESC" },
				},
				undefined, 0, "customer360",
			);
			if (Array.isArray(deals) && deals.length > 0) {
				return { kind: "deal", id: Number(deals[0].ID) };
			}
		} catch (e: any) {
			this.logger.warn(`orphan-link deal.list contact=${contactId} failed: ${e?.message || e}`);
		}
		try {
			const leads: any = await this.callBitrix24Method(
				portalDomain,
				"crm.lead.list",
				{
					filter: { CONTACT_ID: contactId, "!STATUS_ID": ["CONVERTED", "JUNK", "12"] },
					select: ["ID"],
					order: { DATE_CREATE: "DESC" },
				},
				undefined, 0, "customer360",
			);
			if (Array.isArray(leads) && leads.length > 0) {
				return { kind: "lead", id: Number(leads[0].ID) };
			}
		} catch (e: any) {
			this.logger.warn(`orphan-link lead.list contact=${contactId} failed: ${e?.message || e}`);
		}
		return null;
	}

	/** Если лид orphan (нет CONTACT_ID + нет UF_CRM_*_CHAT_ID) и TITLE
	 *  парсится — пробует достроить связи. Возвращает структуру решения. */
	async _maybeLinkOrphanLead(
		portalDomain: string,
		leadId: number,
		snap: any,
	): Promise<{ linked: boolean; reason?: string; contactId?: number; openEntity?: { kind: "deal" | "lead"; id: number } }> {
		const hasContact = snap?.CONTACT_ID && Number(snap.CONTACT_ID) > 0;
		const hasChatIdUf = ["UF_CRM_TG_CHAT_ID", "UF_CRM_MAX_CHAT_ID", "UF_CRM_IG_CHAT_ID"]
			.some((f) => String(snap?.[f] || "").trim());
		if (hasContact && hasChatIdUf) {
			return { linked: false, reason: "lead already linked" };
		}
		if (hasContact && !hasChatIdUf) {
			// Контакт есть, но UF не проставлен — обычная widget-creation
			// (backfillSendLead это уже сделал). Не наш кейс.
			return { linked: false, reason: "contact set, not orphan" };
		}

		const parsed = this._parseOrphanLeadTitle(String(snap?.TITLE || ""));
		if (!parsed) return { linked: false, reason: "title pattern not matched" };
		const { chatId, channelLabel, phoneFromTitle } = parsed;
		const chatIdUf = this.orphanChannelChatIdUf[channelLabel];

		// 1) Поиск контакта по UF_CRM_*_CHAT_ID.
		//
		// Боевая проверка #361428 26.05: на портале 1begovoy.bitrix24.ru
		// встречаются legacy-коллизии — несколько контактов с одинаковым
		// UF_CRM_MAX_CHAT_ID (видимо, marker массово проставлялся ранее).
		// Без защиты от коллизии слепое `[0]` могло привязать orphan
		// к чужому клиенту. Поэтому: сортируем DESC по ID (свежий вверху),
		// если найдено >1 — это коллизия, не доверяем UF, переходим
		// к phone-fallback. Лог WARN для аналитики.
		let contact: any = null;
		if (chatIdUf) {
			try {
				const found: any = await this.callBitrix24Method(
					portalDomain,
					"crm.contact.list",
					{
						filter: { [`=${chatIdUf}`]: chatId },
						select: ["ID", "NAME", "LAST_NAME"],
						order: { ID: "DESC" },
					},
					undefined, 0, "customer360",
				);
				if (Array.isArray(found) && found.length === 1) {
					contact = found[0];
				} else if (Array.isArray(found) && found.length > 1) {
					this.logger.warn(
						`orphan-link collision: ${found.length} contacts share ${chatIdUf}=${chatId}, falling back to phone`,
					);
				}
			} catch (e: any) {
				this.logger.warn(`orphan-link contact.list by ${chatIdUf}=${chatId} failed: ${e?.message || e}`);
			}
		}

		// 2) Fallback по phone из TITLE (для WA — единственный путь).
		// На phone полагаемся только если ровно один контакт. >1 = коллизия
		// (два клиента с одним номером — кто-то ошибся при заведении),
		// без human-judgement не угадаем нужный.
		if (!contact && phoneFromTitle) {
			try {
				const found: any = await this.callBitrix24Method(
					portalDomain,
					"crm.contact.list",
					{
						filter: { PHONE: phoneFromTitle },
						select: ["ID", "NAME", "LAST_NAME"],
						order: { ID: "DESC" },
					},
					undefined, 0, "customer360",
				);
				if (Array.isArray(found) && found.length === 1) {
					contact = found[0];
				} else if (Array.isArray(found) && found.length > 1) {
					this.logger.warn(
						`orphan-link collision: ${found.length} contacts share phone=${phoneFromTitle}, leaving lead orphan`,
					);
				}
			} catch (e: any) {
				this.logger.warn(`orphan-link contact.list by phone=${phoneFromTitle} failed: ${e?.message || e}`);
			}
		}

		if (!contact) {
			this.logger.info(
				`orphan-link lead=${leadId} channel=${channelLabel} chatId=${chatId} phone=${phoneFromTitle || "—"}: no existing contact, leaving as new client`,
			);
			return { linked: false, reason: "no existing contact" };
		}

		const contactId = Number(contact.ID);
		const openEntity = await this._findOpenEntityForContact(portalDomain, contactId);

		const updateFields: Record<string, any> = { CONTACT_ID: contactId };
		if (chatIdUf && !snap[chatIdUf]) updateFields[chatIdUf] = chatId;
		if (!snap.UF_CRM_NF_YM_CLIENT_ID) updateFields.UF_CRM_NF_YM_CLIENT_ID = "-";
		if (phoneFromTitle && !(Array.isArray(snap.PHONE) && snap.PHONE.length > 0)) {
			updateFields.PHONE = [{ VALUE: phoneFromTitle, VALUE_TYPE: "MOBILE" }];
		}
		// Имя в лиде: чаще = chat.id; если есть реальное у контакта — поправляем
		const snapName = String(snap.NAME || "").trim();
		if (contact.NAME && (!snapName || /^\+?\d+$/.test(snapName) || snapName === chatId)) {
			updateFields.NAME = contact.NAME;
			if (contact.LAST_NAME) updateFields.LAST_NAME = contact.LAST_NAME;
		}
		// Открытая сущность — закрываем orphan как «Дубликат» (STATUS_ID=12)
		// и привязываем через UF_CRM_LEAD_ID на оригинал. Симметрично
		// backfillSendLead.
		if (openEntity) {
			updateFields.STATUS_ID = "12";
			if (openEntity.kind === "lead") {
				updateFields.UF_CRM_LEAD_ID = openEntity.id;
			}
			const origTitle = String(snap.TITLE || "").trim();
			const prefix = `[Дубликат → ${openEntity.kind} ${openEntity.id}]`;
			if (!origTitle.startsWith("[Дубликат")) {
				updateFields.TITLE = origTitle ? `${prefix} ${origTitle}` : prefix;
			}
		}

		await this.callBitrix24Method(
			portalDomain,
			"crm.lead.update",
			{ id: leadId, fields: updateFields },
			undefined, 0, "customer360",
		);
		const action = openEntity
			? `marked as duplicate of ${openEntity.kind} ${openEntity.id}`
			: `CONTACT_ID=${contactId}`;
		this.logger.info(
			`orphan-link lead=${leadId} channel=${channelLabel} chatId=${chatId} → ${action} (${Object.keys(updateFields).join(",")})`,
		);
		return { linked: true, contactId, openEntity: openEntity || undefined };
	}

	/** Постфактум-обёртка над `_maybeLinkOrphanLead`. Сам резолвит portalDomain
	 *  и читает snap лида. Используется REST-эндпоинтом /webhooks/internal/relink-orphan-lead
	 *  для починки конкретных лидов (типа #361428). */
	async relinkOrphanLeadById(
		leadId: number,
	): Promise<{ linked: boolean; reason?: string; contactId?: number; openEntity?: { kind: "deal" | "lead"; id: number } }> {
		const users = await (this.prisma as any).user.findMany({ take: 1 });
		const portalDomain = users[0]?.portalDomain;
		if (!portalDomain) return { linked: false, reason: "no authorized portal" };
		let snap: any;
		try {
			snap = await this.callBitrix24Method(
				portalDomain, "crm.lead.get", { id: leadId }, undefined, 0, "customer360",
			);
		} catch (e: any) {
			return { linked: false, reason: `crm.lead.get failed: ${e?.message || e}` };
		}
		if (!snap) return { linked: false, reason: "lead not found" };
		return this._maybeLinkOrphanLead(portalDomain, leadId, snap);
	}

	async sendToPlatform(message: Bitrix24PlatformMessage, instance: Instance & { user: User }): Promise<void> {
		this.logger.info(`Sending message to Bitrix24 for instance ${instance.idInstance}`);
		this.logger.info("Instance", instance);

		if (!instance.user || !instance.user.portalDomain) {
			throw new IntegrationError("Instance not linked to Bitrix24 portal", "CONFIGURATION_ERROR");
		}

		const line = instance.bitrixLine;

		// Провайдер инстанса (wa/max/telegram) — определяет нужно ли считать
		// идентификатор клиента телефоном. Telegram chatId может быть 10 цифр,
		// что случайно матчится с phone-regex'ом — поэтому нельзя полагаться
		// только на формат, нужен явный провайдер.
		const instanceProvider = ((instance.settings as any)?.provider || "wa").toLowerCase();
		const channelLabel =
			instanceProvider === "max" ? "MAX" :
			instanceProvider === "telegram" ? "Telegram" :
			"WhatsApp";

		try {
			// Только для WA идентификатор клиента — настоящий телефон.
			// Для MAX/Telegram это внутренний user_id, в user.phone класть нельзя:
			// B24 либо отвергнет (если короткий), либо запишет в карточку как phone
			// (что ещё хуже — оператор будет пытаться звонить на user_id).
			const isPhoneLike = instanceProvider === "wa" && /^\+?\d{10,15}$/.test(message.phone);
			let phoneE164: string | null = isPhoneLike
				? (message.phone.startsWith("+") ? message.phone : `+${message.phone}`)
				: null;

			// Для MAX/Telegram phone в webhook senderData не приходит, но Green API
			// его знает (если клиент в адресной книге нашего MAX/TG-аккаунта) —
			// добираем через getContactInfo. Если phone есть — используем для
			// ensureOpenLeadForPhone и проставляем в user.phone B24 mirror'а.
			if (!phoneE164 && instanceProvider !== "wa") {
				try {
					const apiUrl = greenApiUrlForInstance(instance.idInstance.toString());
					const r = await axios.post(
						`${apiUrl}/waInstance${instance.idInstance}/getContactInfo/${instance.apiTokenInstance}`,
						{ chatId: message.phone },
						{ timeout: 10000 },
					);
					const pn = r.data?.phoneNumber;
					if (pn && Number(pn) > 0) {
						phoneE164 = `+${String(pn).replace(/^\+/, "")}`;
						this.logger.info(
							`getContactInfo: resolved phone ${phoneE164} for ${channelLabel} chatId=${message.phone}`,
						);
					}
				} catch (e: any) {
					this.logger.warn(
						`getContactInfo failed for ${channelLabel} chatId=${message.phone}: ${e.message}`,
					);
				}
			}

			// ensureLead имеет смысл когда есть phone ИЛИ когда есть chatId для
			// поиска по сохранённому UF_CRM_*_CHAT_ID. Для MAX/Telegram message.phone
			// — это chatId клиента (внутренний user_id). Передаём в ensureLead как
			// chatId-параметр чтобы (а) найти контакт по UF, (б) сохранить
			// chatId в UF контакта после привязки.
			if (line != null) {
				const chatIdForUf = (instanceProvider === "max" || instanceProvider === "telegram") ? message.phone : undefined;
				// Я.Метрика ClientId из служебной метки сайта 1begovoy.ru —
				// два формата (ym-<id> или «с сайта … (ID <id>)»), см. extractYmClientId.
				const ymClientId = this.extractYmClientId(message.message);
				if (phoneE164 || chatIdForUf) {
					await this.ensureOpenLeadForPhone(
						instance.user.portalDomain,
						phoneE164 || "",
						message.senderName || `${channelLabel} ${message.phone}`,
						line,
						channelLabel,
						chatIdForUf,
						false,
						ymClientId,
					);
				}
			}
			// Префикс для user.id/chat.id. WA → `wa_` (там идентификатор реально
			// телефон). MAX и Telegram → `sc_`. Раньше Telegram использовал `wa_`
			// для legacy compat, но из-за этого B24 авто-генерил TITLE лида типа
			// «6748117222 WhatsApp - Telegram 79584983354» (видел `wa_` → решил
			// что это WhatsApp-чат). Минус: открытые TG-сессии с прошлым `wa_`
			// префиксом получат новый chat-user — старые останутся в архиве.
			const useWaPrefix = isPhoneLike;
			const userKey = useWaPrefix ? `wa_${message.phone}` : `sc_${message.phone}`;
			// fallbackName без пробелов: B24 разбивает по пробелу и хвост идёт в
			// LAST_NAME — получится «WhatsApp» / «79228124797» в карточке.
			const fallbackName = isPhoneLike ? (phoneE164 as string) : message.phone;
			const userBlock: any = {
				id: userKey,
				name: message.senderName || fallbackName,
			};
			if (phoneE164) userBlock.phone = phoneE164;
			const messagePayload: Bitrix24MessagePayload = {
				user: userBlock,
				message: {
					id: message.id,
					date: Math.floor(Date.now() / 1000),
					text: message.message,
				},
				chat: {
					id: userKey,
					name: message.senderName || fallbackName,
					url: null,
				},
				extra: { crm: "Y" },
			};

			if (message.attachments && message.attachments.length > 0) {
				const appUrl = (this.configService.get<string>("APP_URL") || "").replace(/\/+$/, "");
				const files: { url: string; name: string }[] = [];
				for (const attachment of message.attachments) {
					let url = attachment.url;
					const name = attachment.fileName || "attachment";
					// B24 не может скачать медиа-URL Telegram/MAX-шардов Green API
					// (<shard>.api.green-api.com/download/...) — висит ~20 c и
					// отвечает «Переданы не все необходимые данные». Скачиваем файл
					// сами и отдаём B24 ссылку через social.9wb.ru (его B24 тянет).
					if (url && /\.api\.green-api\.com\//i.test(url) && appUrl) {
						try {
							const resp = await axios.get(url, {
								responseType: "arraybuffer",
								timeout: 25000,
								maxContentLength: 50 * 1024 * 1024,
							});
							const ct = String(
								resp.headers["content-type"] || attachment.type || "application/octet-stream",
							);
							const mediaId = this.mediaCache.store(Buffer.from(resp.data), ct);
							const ext = (name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || "bin").toLowerCase();
							url = `${appUrl}/media/${mediaId}.${ext}`;
							this.logger.info(`Медиа Green API проксировано для B24: ${url}`);
						} catch (e: any) {
							this.logger.warn(
								`Не удалось скачать медиа Green API (${attachment.url}): ${e.message} — отдаём B24 исходный URL`,
							);
						}
					}
					files.push({ url, name });
				}
				messagePayload.message.files = files;

				this.logger.info(`Adding ${message.attachments.length} attachment(s) to Bitrix24 message`, {
					files: messagePayload.message.files,
				});
			}

			await this.callBitrix24Method(instance.user.portalDomain, "imconnector.send.messages", {
				CONNECTOR: "social_connector",
				LINE: line,
				MESSAGES: [messagePayload],
			});

			this.logger.info(`Message sent to Bitrix24 for instance ${instance.idInstance}`, {
				hasAttachments: !!(message.attachments && message.attachments.length > 0),
				attachmentCount: message.attachments?.length || 0,
			});
		} catch (error: any) {
			this.logger.error(`Failed to send message to Bitrix24: ${error.message}`);
			throw error;
		}
	}

	/** Контекст-строка для B24 из i2crm `quoted_message`: на что отвечает клиент.
	 *  В Instagram Direct сообщение бывает (а) холодным — клиент просто написал,
	 *  тогда quoted_message=null и контекста нет; (б) ответом на сторис или на
	 *  более раннее сообщение — тогда i2crm кладёт исходник в quoted_message.
	 *  i2crm может прислать его строкой или объектом — обрабатываем оба варианта
	 *  без жёстких допущений о структуре; полный payload журналируется в
	 *  I2crmEventLog, по нему можно уточнить формат при появлении живого примера. */
	// formatI2crmQuoted вынесен в src/common/i2crm-payload.ts (single source of
	// truth, покрыт тестами). См. там же — connector chat.id префиксы.

	// Я.Метрика ClientId из метки, которую сайт 1begovoy.ru подставляет в
	// pre-fill текста при «Спросить о товаре в WhatsApp/Telegram». Сайт за
	// время существовал в двух форматах — поддерживаем оба:
	//   1) «— код обращения: ym-<id>» (старая разметка);
	//   2) «— с сайта 1begovoy.ru (ID <id>)» (новая разметка).
	private extractYmClientId(text: string | undefined | null): string | undefined {
		const s = String(text || "");
		const m = s.match(/\bym-(\d{6,25})\b/)
			|| s.match(/с\s+сайта\s+1begovoy\.ru\s*\(ID\s*(\d{6,25})\)/i);
		return m ? m[1] : undefined;
	}

	// Достаёт медиа-вложение из Telegram-сообщения. Telegram кладёт файл в
	// одно из полей по типу; берём первое подходящее. Стикеры намеренно не
	// поддерживаем (.tgs/webm B24 не покажет) — они уйдут как "[вложение]".
	private extractTelegramMedia(msg: any): { fileId: string; filename: string; mime: string } | null {
		if (Array.isArray(msg?.photo) && msg.photo.length > 0) {
			const p = msg.photo[msg.photo.length - 1]; // последний size — наибольший
			return { fileId: p.file_id, filename: "photo.jpg", mime: "image/jpeg" };
		}
		if (msg?.document) {
			return {
				fileId: msg.document.file_id,
				filename: msg.document.file_name || "document",
				mime: msg.document.mime_type || "application/octet-stream",
			};
		}
		if (msg?.video) {
			return {
				fileId: msg.video.file_id,
				filename: msg.video.file_name || "video.mp4",
				mime: msg.video.mime_type || "video/mp4",
			};
		}
		if (msg?.voice) {
			return { fileId: msg.voice.file_id, filename: "voice.ogg", mime: msg.voice.mime_type || "audio/ogg" };
		}
		if (msg?.audio) {
			return {
				fileId: msg.audio.file_id,
				filename: msg.audio.file_name || "audio.mp3",
				mime: msg.audio.mime_type || "audio/mpeg",
			};
		}
		if (msg?.video_note) {
			return { fileId: msg.video_note.file_id, filename: "video_note.mp4", mime: "video/mp4" };
		}
		return null;
	}

	// Скачивает файл Telegram по file_id: getFile → file_path → бинарь.
	// Telegram Bot API скачивает файлы только до 20 МБ — больше вернёт ошибку,
	// тогда отдаём null (сообщение уйдёт без вложения).
	private async fetchTelegramFile(
		token: string, fileId: string,
	): Promise<{ buffer: Buffer; filePath: string } | null> {
		const info: any = await axios.get(`https://api.telegram.org/bot${token}/getFile`, {
			params: { file_id: fileId },
			timeout: 15000,
			validateStatus: () => true,
		});
		if (info.data?.ok !== true || !info.data?.result?.file_path) {
			this.logger.warn(`tg-bot: getFile failed: ${info.data?.description || info.status}`);
			return null;
		}
		const filePath = String(info.data.result.file_path);
		const dl = await axios.get(
			`https://api.telegram.org/file/bot${token}/${filePath}`,
			{ responseType: "arraybuffer", timeout: 30000, maxContentLength: Infinity },
		);
		return { buffer: Buffer.from(dl.data), filePath };
	}

	// Грузит файл в Telegram-чат: картинки — sendPhoto (с превью), остальное —
	// sendDocument (оригинал без перекодирования). multipart через глобальные
	// FormData/Blob (Node 20).
	private async sendTelegramMedia(
		token: string, chatId: string, buffer: Buffer, filename: string, caption?: string,
	): Promise<{ ok: boolean; messageId?: number; error?: string }> {
		const isImage = /\.(jpe?g|png|gif|webp)$/i.test(filename);
		const method = isImage ? "sendPhoto" : "sendDocument";
		const field = isImage ? "photo" : "document";
		const form = new FormData();
		form.append("chat_id", chatId);
		// Buffer → Uint8Array: новые @types/node v22 требуют ArrayBufferView<ArrayBuffer>
		// для BlobPart, а Buffer<ArrayBufferLike> может быть SharedArrayBuffer.
		// new Uint8Array(buffer) шарит underlying memory, не копирует.
		form.append(field, new Blob([new Uint8Array(buffer)]), filename);
		if (caption) form.append("caption", caption.slice(0, 1024));
		const resp: any = await axios.post(
			`https://api.telegram.org/bot${token}/${method}`,
			form,
			{ timeout: 60000, maxBodyLength: Infinity, validateStatus: () => true },
		);
		if (resp.data?.ok !== true) {
			return { ok: false, error: resp.data?.description || `HTTP ${resp.status}` };
		}
		return { ok: true, messageId: resp.data?.result?.message_id };
	}

	// ── Telegram Bot (@begovoy_bot) — клиентский канал ───────────────────────
	// Бот подключён напрямую через Telegram Bot API (не Green API, не i2crm).
	// Входящий Update → отдельная открытая линия B24 через imconnector.send.messages.
	// Журнал TgBotEventLog — это и «история» переписки, и страховка replay при
	// недоступности B24. Медиа (фото/видео/файлы) — Этап 4, пока релеится текст.
	// См. docs/TELEGRAM_BOT_FLOW.md.

	/** Конфиг одного Telegram-бот-инстанса. Несколько ботов → несколько
	 *  конфигов: каждый со своим токеном, линией B24, секретом webhook,
	 *  группой зеркала и user-code префиксом (чтобы B24 не путал клиентов
	 *  между линиями). Префикс legacy «tgbot_» закреплён за begovoy_bot —
	 *  не меняем, иначе разорвутся существующие сессии в B24. */
	private getTgBotConfig(name: string): {
		name: string;
		token: string;
		lineId: number;
		webhookSecret: string;
		mirrorGroupId: string;
		userKeyPrefix: string;
	} | null {
		const g = (k: string) => this.configService.get<string>(k) || "";
		if (name === "begovoy") {
			return {
				name: "begovoy",
				token: g("TG_BOT_TOKEN"),
				lineId: Number(g("TG_BOT_LINE_ID")) || 0,
				webhookSecret: g("TG_BOT_WEBHOOK_SECRET"),
				mirrorGroupId: g("TG_BOT_MIRROR_GROUP_ID"),
				userKeyPrefix: "tgbot_",
			};
		}
		if (name === "support") {
			return {
				name: "support",
				token: g("TG_BOT_SUPPORT_TOKEN"),
				lineId: Number(g("TG_BOT_SUPPORT_LINE_ID")) || 0,
				webhookSecret: g("TG_BOT_SUPPORT_WEBHOOK_SECRET"),
				mirrorGroupId: g("TG_BOT_SUPPORT_MIRROR_GROUP_ID"),
				userKeyPrefix: "tgsupport_",
			};
		}
		return null;
	}

	/** Определить инстанс Telegram-бота по lineNumber из B24 outgoing webhook.
	 *  Используется handleBitrix24Webhook для роутинга ответа оператора в нужный
	 *  бот (begovoy / support / …). */
	private getTgBotConfigByLine(lineNumber: number): ReturnType<typeof this.getTgBotConfig> {
		for (const name of ["begovoy", "support"]) {
			const cfg = this.getTgBotConfig(name);
			if (cfg && cfg.lineId === lineNumber) return cfg;
		}
		return null;
	}

	/** Определить инстанс Telegram-бота по mirrorGroupId. Используется при
	 *  обратном пути «оператор пишет в супергруппе зеркала → отправить
	 *  клиенту через нужный бот». Public — controller вызывает напрямую. */
	getTgBotByGroupId(groupId: string): string | null {
		const g = String(groupId);
		for (const name of ["begovoy", "support"]) {
			const cfg = this.getTgBotConfig(name);
			if (cfg && String(cfg.mirrorGroupId) === g) return name;
		}
		return null;
	}

	/** Отправить сообщение клиенту через указанный бот-инстанс. Используется
	 *  обратным путём из bridge (оператор пишет в зеркале → клиенту через
	 *  бот). emoji-шорткоды конвертируются. Outgoing журналируется. */
	async sendFromTgBot(
		botName: string, chatId: string, text: string, operatorName?: string,
	): Promise<{ ok: boolean; error?: string; messageId?: number }> {
		const cfg = this.getTgBotConfig(botName);
		if (!cfg) return { ok: false, error: `unknown bot: ${botName}` };
		if (!cfg.token) return { ok: false, error: `tg-bot[${botName}]: no token` };
		const finalText = emoji.emojify(text);
		try {
			const resp: any = await axios.post(
				`https://api.telegram.org/bot${cfg.token}/sendMessage`,
				{ chat_id: chatId, text: finalText },
				{ timeout: 15000, validateStatus: () => true },
			);
			if (resp.data?.ok !== true) {
				const desc = resp.data?.description || `HTTP ${resp.status}`;
				this.logger.error(`sendFromTgBot[${botName}] rejected: ${desc}`);
				return { ok: false, error: desc };
			}
			const messageId = resp.data?.result?.message_id;
			this.logger.info(`sendFromTgBot[${botName}]: → chat=${chatId} msg=${messageId}${operatorName ? ` by ${operatorName}` : ""}`);
			// Журнал — direction=out, помечаем что пришло из mirror'а.
			try {
				await (this.prisma as any).tgBotEventLog.create({
					data: {
						updateId: `out_mirror_${Date.now()}_${messageId || "0"}`,
						chatId, messageId: String(messageId || ""),
						direction: "out",
						payload: JSON.stringify({ chat_id: chatId, text, from_mirror: true, operator: operatorName }),
						status: "sent", sentAt: new Date(),
					},
				});
			} catch { /* non-fatal */ }
			return { ok: true, messageId };
		} catch (e: any) {
			this.logger.error(`sendFromTgBot[${botName}] transport error: ${e.message}`);
			return { ok: false, error: e.message };
		}
	}

	async handleTelegramBotIncoming(update: any, botName: string = "begovoy"): Promise<{ success: boolean; reason?: string }> {
		const cfg = this.getTgBotConfig(botName);
		if (!cfg) return { success: false, reason: `unknown bot: ${botName}` };
		const updateId = update?.update_id;
		if (updateId === undefined || updateId === null) {
			return { success: false, reason: "no update_id" };
		}

		// Клиентский Direct — это обычное message в личке. edited_message,
		// my_chat_member, callback_query и пр. игнорируем (success=true, чтобы
		// Telegram не ретраил).
		const msg = update?.message;
		if (!msg) return { success: true, reason: "ignored: not a message update" };
		if (msg.chat?.type !== "private") return { success: true, reason: "ignored: non-private chat" };
		if (msg.from?.is_bot) return { success: true, reason: "ignored: bot sender" };

		const chatId = String(msg.chat?.id ?? msg.from?.id ?? "");
		const messageId = msg.message_id;
		if (!chatId || messageId === undefined) {
			return { success: false, reason: "missing chatId or message_id" };
		}

		const first = String(msg.from?.first_name || "").trim();
		const last = String(msg.from?.last_name || "").trim();
		const username = String(msg.from?.username || "").trim();
		const clientName = [first, last].filter(Boolean).join(" ")
			|| (username ? `@${username}` : `TG_${chatId}`);

		const text = String(msg.text || msg.caption || "");
		const hasMedia = !!(msg.photo || msg.document || msg.video || msg.voice
			|| msg.audio || msg.video_note || msg.sticker);

		// Журнал ДО доставки в B24 — если B24 недоступен, запись остаётся
		// pending и доставляется позже через /webhooks/internal/tg-bot-replay.
		// updateId уникален в пределах бота — upsert защищает от ретраев Telegram.
		try {
			await (this.prisma as any).tgBotEventLog.upsert({
				where: { updateId: String(updateId) },
				create: {
					updateId: String(updateId), chatId, messageId: String(messageId),
					direction: "in", payload: JSON.stringify(update), status: "pending",
				},
				update: { payload: JSON.stringify(update) },
			});
		} catch (e: any) {
			this.logger.warn(`tg-bot: TgBotEventLog upsert failed (non-fatal): ${e.message}`);
		}

		const lineId = cfg.lineId;
		if (!lineId || !Number.isFinite(lineId)) {
			this.logger.error(`tg-bot[${cfg.name}]: lineId not configured`);
			return { success: false, reason: `tg-bot[${cfg.name}] lineId not configured` };
		}

		const users = await (this.prisma as any).user.findMany({ take: 1 });
		const user = users[0];
		if (!user) {
			this.logger.error(`tg-bot: no Bitrix24 user in DB to dispatch incoming`);
			return { success: false, reason: "no-user" };
		}
		const portalDomain = user.portalDomain;

		// Я.Метрика ClientId из служебной метки сайта 1begovoy.ru (см. extractYmClientId
		// — поддерживаются оба формата: ym-<id> и «с сайта … (ID <id>)»).
		const ymClientId = this.extractYmClientId(text);

		// Резолвим контакт клиента по UF_CRM_TG_CHAT_ID (channelLabel="Telegram").
		// skipLeadCreation=true — лид создаёт сама открытая линия B24, свой лид
		// не плодим. Контакт привяжем к лиду сессии ниже (backfillTgBotContactLink):
		// B24 матчит открытые линии по телефону, а у Telegram-бота его нет.
		let contactId: number | undefined;
		try {
			const leadResult = await this.ensureOpenLeadForPhone(
				portalDomain, "", clientName, lineId, "Telegram", chatId, true, ymClientId,
			);
			contactId = leadResult?.contactId;
		} catch (e: any) {
			this.logger.warn(`tg-bot: ensureLead failed (non-fatal): ${e.message}`);
		}

		// Медиа: скачиваем файл из Telegram и проксируем через social.9wb.ru.
		// B24 не может тянуть api.telegram.org/file напрямую — там в URL токен
		// бота (как и для Telegram/MAX-шардов Green API, см. MediaCacheService).
		let mediaFile: { url: string; name: string; isImage: boolean } | null = null;
		const media = this.extractTelegramMedia(msg);
		if (media) {
			const token = cfg.token;
			if (token) {
				try {
					const fetched = await this.fetchTelegramFile(token, media.fileId);
					if (fetched) {
						const id = this.mediaCache.store(fetched.buffer, media.mime);
						const ext = media.filename.match(/\.([a-z0-9]+)$/i)?.[1]
							|| fetched.filePath.match(/\.([a-z0-9]+)$/i)?.[1] || "bin";
						const appUrl = (this.configService.get<string>("APP_URL") || "").replace(/\/+$/, "");
						mediaFile = {
							url: `${appUrl}/media/${id}.${ext}`,
							name: media.filename,
							isImage: /^image\//.test(media.mime),
						};
					}
				} catch (e: any) {
					this.logger.warn(`tg-bot: media fetch failed chat=${chatId}: ${e.message}`);
				}
			}
		}

		const userKey = `${cfg.userKeyPrefix}${chatId}`;
		const ts = msg.date ? Number(msg.date) : Math.floor(Date.now() / 1000);

		const messagePayload: any = {
			user: {
				id: userKey,
				name: clientName,
				url: username ? `https://t.me/${username}` : undefined,
			},
			message: {
				id: String(messageId),
				date: ts,
				text: text || (hasMedia ? "[вложение]" : "[сообщение]"),
			},
			chat: { id: userKey, name: clientName },
			extra: { crm: "Y" },
		};
		if (mediaFile) {
			messagePayload.message.files = [{ url: mediaFile.url, name: mediaFile.name }];
		}

		try {
			await this.callBitrix24Method(portalDomain, "imconnector.send.messages", {
				CONNECTOR: "social_connector",
				LINE: lineId,
				MESSAGES: [messagePayload],
			});
			this.logger.info(`tg-bot: sent to B24 line=${lineId} chat=${chatId} msg=${messageId}`);
		} catch (err: any) {
			this.logger.error(`tg-bot: imconnector.send.messages failed: ${err.message}`);
			return { success: false, reason: err.message };
		}

		try {
			await (this.prisma as any).tgBotEventLog.update({
				where: { updateId: String(updateId) },
				data: { status: "sent", sentAt: new Date() },
			});
		} catch { /* non-fatal — журнал не критичен для доставки */ }

		// Привязка контакта к лиду сессии — B24 матчит открытые линии по
		// телефону, у Telegram-бота его нет, поэтому связываем сами. Фоном.
		// ymClientId передаём всегда: если контакт не нашёлся, метку всё равно
		// надо записать на лид сессии.
		this.backfillTgBotContactLink(portalDomain, chatId, contactId, ymClientId, cfg.userKeyPrefix)
			.catch((e) => this.logger.warn(`tg-bot[${cfg.name}]: backfill link failed (non-fatal): ${e.message}`));

		// Зеркало в TG-супергруппу инстанса — отдельно для каждого бота.
		// botName + lineId передаём для построения карточки клиента
		// (название линии + поиск активного лида/контакта в B24).
		this.tgBotMirror.mirrorIncoming({
			chatId, clientName, username, text, hasMedia,
			mediaUrl: mediaFile?.url, mediaName: mediaFile?.name, mediaIsImage: mediaFile?.isImage,
			mirrorGroupId: cfg.mirrorGroupId || undefined,
			botName: cfg.name, lineId: cfg.lineId,
		}).catch((e) => this.logger.warn(`tg-bot[${cfg.name}]: mirror incoming failed (non-fatal): ${e.message}`));

		return { success: true };
	}

	// После imconnector.send.messages B24 асинхронно создаёт сессию открытой
	// линии и лид. Открытые линии B24 матчат клиента с CRM по телефону — у
	// Telegram-бота его нет, поэтому B24 заводит лид без контакта. Этот метод
	// находит лид сессии по USER_CODE и привязывает уже существующий контакт
	// клиента (резолвнут ранее по UF_CRM_TG_CHAT_ID) — тогда оператор видит
	// карточку клиента и всю историю. Идёт с retry: сессия создаётся с лагом.
	private async backfillTgBotContactLink(
		portalDomain: string, chatId: string, contactId: number | undefined,
		ymClientId?: string, userKeyPrefix: string = "tgbot_",
	): Promise<void> {
		const userCode = `${userKeyPrefix}${chatId}`;
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
		for (let attempt = 1; attempt <= 6; attempt++) {
			await sleep(attempt === 1 ? 1500 : 2000);
			try {
				const activities: any = await this.callBitrix24Method(portalDomain, "crm.activity.list", {
					filter: { PROVIDER_ID: "IMOPENLINES_SESSION" },
					select: ["ID", "OWNER_ID", "OWNER_TYPE_ID", "PROVIDER_PARAMS"],
					order: { ID: "DESC" },
				});
				const list = Array.isArray(activities) ? activities : [];
				const act = list.find((a: any) => {
					const code = a?.PROVIDER_PARAMS?.USER_CODE;
					return typeof code === "string" && code.includes(userCode);
				});
				if (!act) {
					this.logger.debug(`tg-bot: backfill attempt ${attempt}/6 — no session activity for ${userCode}`);
					continue;
				}
				const ownerType = parseInt(act.OWNER_TYPE_ID, 10);
				const ownerId = parseInt(act.OWNER_ID, 10);
				if (ownerType !== 1) {
					// Сессия села на сделку/контакт — отдельная привязка не нужна.
					return;
				}
				const lead: any = await this.callBitrix24Method(portalDomain, "crm.lead.get", { id: ownerId });
				const fields: Record<string, any> = {};
				if (contactId && !lead?.CONTACT_ID) fields.CONTACT_ID = contactId;
				if (!lead?.UF_CRM_TG_CHAT_ID) fields.UF_CRM_TG_CHAT_ID = chatId;
				// Я.Метрика ClientId: реальное значение из метки `ym-<id>` в тексте
				// (сайт подставляет при «Спросить о товаре в Telegram»). Если не
				// пришло — ставим "-", иначе B24 блокирует оператора на смене стадии.
				// Перезаписываем заглушку "-", если позже пришёл настоящий id.
				const currentYm = String(lead?.UF_CRM_NF_YM_CLIENT_ID || "");
				if (!currentYm || (currentYm === "-" && ymClientId)) {
					fields.UF_CRM_NF_YM_CLIENT_ID = ymClientId || "-";
				}
				if (Object.keys(fields).length > 0) {
					await this.callBitrix24Method(portalDomain, "crm.lead.update", {
						id: ownerId, fields,
					});
					this.logger.info(`tg-bot: backfill lead ${ownerId} → contact ${contactId} (${Object.keys(fields).join(",")})`);
				}
				return;
			} catch (e: any) {
				this.logger.warn(`tg-bot: backfill attempt ${attempt} failed: ${e.message}`);
			}
		}
		this.logger.warn(`tg-bot: backfill — session activity not found for ${userCode} after 6 attempts`);
	}

	// Incoming Instagram-сообщение от i2crm Public API.
	// Линии 18 (Direct) и 22 (Comment) уже зарегистрированы за CONNECTOR=i2crm
	// в B24 (CRM_SOURCE="18|I2CRM"/"22|I2CRM"). Отправляем через imconnector.send.messages
	// напрямую, минуя Green API pipeline (i2crm — не Green API инстанс).
	async handleI2crmIncoming(payload: any): Promise<{ success: boolean; reason?: string }> {
		// Валидация payload — pure helper (см. src/common/i2crm-payload.ts).
		const v = validateI2crmIncoming(payload);
		if (!v.valid) {
			// echo (outgoing-echo) — это success:true, всё остальное — fail.
			return { success: !!v.echo, reason: v.reason };
		}

		const channel = String(payload.channel) as I2crmChannel;
		const clientId = payload.client_id;
		const messageId = payload.message_id;
		const text = payload?.text || "";
		const type = String(payload?.type || "text");
		const username = payload?.client_username || "";
		const clientName = payload?.client_name || username || `IG_${clientId}`;
		const phone = payload?.phone_number || "";
		const externalId = payload?.external_id || "";
		const datetime = payload?.datetime;

		// Автоответ «нерабочее время» — только Instagram Direct (не комментарии),
		// фоном, не блокирует доставку входящего в B24.
		if (channel === "instdir" && this.isOffHoursMsk()) {
			void this.claimOffHoursReply(`ig:${clientId}`)
				.then((claimed) => (claimed ? this.sendOffHoursReplyIg(String(clientId)) : undefined))
				.catch(() => undefined);
		}

		// Профилактика: сохраняем payload в журнал ДО попытки доставки в B24.
		// Если B24 в OVERLOAD_LIMIT — событие останется со status=pending и его
		// можно replay'ить через /webhooks/internal/i2crm-replay. messageId
		// уникален (upsert по нему — на случай retry-webhook от i2crm).
		try {
			await (this.prisma as any).i2crmEventLog.upsert({
				where: { messageId: String(messageId) },
				create: {
					messageId: String(messageId),
					clientId: String(clientId),
					channel,
					incoming: true,
					payload: JSON.stringify(payload),
					status: "pending",
				},
				update: {
					// retry от i2crm — обновим payload (мало ли что), статус не меняем
					payload: JSON.stringify(payload),
				},
			});
		} catch (e: any) {
			this.logger.warn(`i2crm: I2crmEventLog upsert failed (non-fatal): ${e.message}`);
		}

		// LINE id из env: instdir → I2CRM_LINE_ID_IG_DIRECT, instcom → I2CRM_LINE_ID_IG_COMMENT
		const lineEnv = envKeyForI2crmLine(channel);
		const lineId = Number(this.configService.get<string>(lineEnv));
		if (!lineId || !Number.isFinite(lineId)) {
			this.logger.error(`i2crm: ${lineEnv} not configured in .env`);
			return { success: false, reason: `${lineEnv} not configured` };
		}

		const channelLabel = "Instagram";

		// Берём первого (и единственного) пользователя из БД — у нас один портал.
		// При мультипортале сюда передавать domain через query-параметр webhook URL.
		const users = await (this.prisma as any).user.findMany({ take: 1 });
		const user = users[0];
		if (!user) {
			this.logger.error(`i2crm: no Bitrix24 user in DB to dispatch incoming`);
			return { success: false, reason: "no-user" };
		}
		const portalDomain = user.portalDomain;

		// Лид/контакт по UF_CRM_IG_CHAT_ID (или phone если есть).
		const phoneE164 = normalizePhoneE164(phone);
		// skipLeadCreation=true — лид создаст сама открытая линия B24, свой
		// «(auto)» лид не плодим. Контакт привяжем к лиду сессии ниже через
		// backfillIgUfFields (см. контакт-привязку по образцу tg-бота).
		let i2crmContactId: number | undefined;
		try {
			const leadResult = await this.ensureOpenLeadForPhone(
				portalDomain,
				phoneE164,
				clientName,
				lineId,
				channelLabel,
				String(clientId),
				true,
			);
			i2crmContactId = leadResult?.contactId;
		} catch (e: any) {
			this.logger.warn(`i2crm: ensureLead failed (non-fatal): ${e.message}`);
		}

		// Username записывается через backfillIgUfFields после imconnector.send.messages
		// (когда B24 уже создал лид/контакт и можно к нему обратиться).

		// Текст для B24. Для comment-канала добавляем контекст что это коммент,
		// поскольку Direct и Comment могут идти от одного клиента и нужно различать.
		const isComment = channel === "instcom";
		// src — основной URL поста в i2crm payload (для instcom). post_url/media_url — fallback.
		const igPostUrl = isComment ? (payload?.src || payload?.post_url || payload?.media_url || "") : "";
		// Для Direct: на что отвечает клиент (ответ на сторис / на сообщение).
		// quoted_message=null у холодного сообщения — тогда контекста нет, это норма.
		const quotedNote = !isComment ? formatI2crmQuoted(payload?.quoted_message) : "";
		const finalText = buildI2crmFinalText({ channel, text, igPostUrl, quotedNote });

		// user.id и chat.id разделены (см. ADR 2026-05-26-ig-comments-attach-to-open-entity):
		// - user.id одинаковый для всех постов и каналов IG клиента → B24 узнаёт «тот же
		//   клиент» → CRM_FORWARD=Y прикрепляет сессию к существующему открытому лиду/сделке
		// - chat.id разный per (клиент × пост) для instcom → отдельная сессия у каждого поста,
		//   но прикреплена к одному лиду
		const mediaIdForKey = isComment ? String(payload?.media_id || "") : "";
		const userId = buildI2crmUserId(channel, clientId);
		const chatId = buildI2crmChatId(channel, clientId, mediaIdForKey);
		const ts = datetime ? Math.floor(new Date(datetime).getTime() / 1000) : Math.floor(Date.now() / 1000);

		const messagePayload: any = {
			user: {
				id: userId,
				name: clientName,
				url: username ? `https://instagram.com/${username}` : undefined,
			},
			message: {
				id: String(messageId),
				date: ts,
				text: finalText,
			},
			chat: {
				id: chatId,
				name: clientName,
				// B24 рендерит chat.url как «Ссылка на исходный пост: <url>» в чате
				// открытой линии. Это корректно только для IG-comment — есть реальный
				// пост, который клиент комментирует. Для IG-direct исходного поста нет,
				// поэтому chat.url НЕ ставим: иначе B24 показывал «Ссылка на исходный
				// пост: <профиль клиента>», выдавая профиль за пост и сбивая оператора.
				// Кликабельный профиль клиента остаётся в user.url и в UF_CRM_INSTAGRAM.
				url: isComment && igPostUrl ? igPostUrl : undefined,
			},
			extra: { crm: "Y" },
		};

		// Аттачи (если type=image/video/audio/file). i2crm кладёт ссылку на
		// файл в одно из полей в зависимости от типа: `src` (для Instagram-
		// instdir, в т.ч. картинка поста-источника когда клиент нажал
		// «отправить сообщение» с поста — Instagram прикрепляет фото поста
		// первым сообщением); `media_url` / `media.url` (legacy / другие типы).
		const mediaFile = extractI2crmMediaFile(type, payload);
		if (mediaFile) {
			messagePayload.message.files = [mediaFile];
		}

		let sessionInfo: { sessionId?: string; chatId?: string } = {};
		try {
			const response: any = await this.callBitrix24Method(portalDomain, "imconnector.send.messages", {
				CONNECTOR: "social_connector",
				LINE: lineId,
				MESSAGES: [messagePayload],
			});
			// Извлекаем session.ID и session.CHAT_ID из ответа — нужны для карточки
			// клиента в TG-зеркало.
			sessionInfo = extractB24SessionInfo(response);
			this.logger.info(
				`i2crm: sent to B24 line=${lineId} channel=${channel} client=${clientId} msg=${messageId} externalId=${externalId}`,
			);
		} catch (err: any) {
			this.logger.error(`i2crm: imconnector.send.messages failed: ${err.message}`);
			return { success: false, reason: err.message };
		}

		// Mirror в TG-группу (как WA/MAX/TG 3354) — не блокирует основной pipeline,
		// логирует ошибки внутри сервиса.
		this.i2crmTgMirror.mirrorIncoming(payload).catch((e) => {
			this.logger.warn(`i2crm: tg-mirror failed (non-fatal): ${e.message}`);
		});

		// B24-аналог TG pinned-поста (25.05): для IG-Comment отправляем
		// служебное RICH_LINK-сообщение с превью поста IG в B24-чат — чтобы
		// оператор сразу видел на какой пост клиент комментирует. SYSTEM=Y
		// → НЕ форвардится на коннектор (клиент в IG не получит дубль).
		// Дедуп по (clientId, mediaId).pinnedMediaSent — раз в сессию.
		if (isComment && sessionInfo.chatId && igPostUrl && payload?.media_id) {
			void this.maybeSendPinnedPostThumbnail(
				portalDomain,
				sessionInfo.chatId,
				String(clientId),
				String(payload.media_id),
				igPostUrl,
			).catch((e) => this.logger.warn(`i2crm: pinned-thumb failed (non-fatal): ${e.message}`));
		}

		// Этап 3: связываем b24 message_id с comment_id, чтобы при reply от
		// оператора в B24 знать, на какой именно IG-коммент в треде отвечать.
		// B24 не отдаёт message_id в response send.messages — узнаём через
		// im.dialog.messages.get последнего сообщения в чате сессии.
		if (isComment && sessionInfo.chatId && payload?.media_id && payload?.comment_id) {
			void this.linkIgCommentToB24Message(
				portalDomain, sessionInfo.chatId, String(clientId),
				String(payload.media_id), String(payload.comment_id),
				String(payload?.text || ""),
			).catch((e) => this.logger.warn(`i2crm: ig-b24-link failed (non-fatal): ${e.message}`));
		}

		// IG Direct: связываем b24 message_id с внешним external_id IG-сообщения.
		// Используется при reply «через Цитирование» в B24 → передаём в i2crm
		// reply_to → клиент в Instagram видит нативный reply со стрелкой.
		if (!isComment && sessionInfo.chatId && payload?.external_id) {
			void this.linkIgDirectInboundToB24Message(
				portalDomain, sessionInfo.chatId, String(clientId),
				String(payload.external_id), String(payload?.text || ""),
			).catch((e) => this.logger.warn(`i2crm: ig-direct-link failed (non-fatal): ${e.message}`));
		}

		// Customer-360: входящее IG-сообщение в customer_events (best-effort).
		void this._emitIgMessageEvent({
			clientId: String(clientId),
			username: username || undefined,
			direction: "in",
			text: finalText,
			igChannel: isComment ? "comment" : "direct",
			messageId: String(messageId),
			mediaUrl:
				type !== "text"
					? payload?.media_url || payload?.media?.url || undefined
					: undefined,
			mediaName: payload?.media?.file_name || undefined,
			postUrl: igPostUrl || undefined,
			mediaId: payload?.media_id ? String(payload.media_id) : undefined,
			commentId: payload?.comment_id ? String(payload.comment_id) : undefined,
		});

		// Сохраняем последний media+comment-id для outgoing /target/feedback type=comment.
		// После переключения i2crm на «официальный» способ подключения эти поля стали
		// обязательными (раньше i2crm сопоставлял по client_id сам).
		// A2: контекст хранится по (clientId, mediaId) — у клиента под разными
		// постами разные media_id, контексты не перезатираются. Outgoing берёт
		// нужный по mediaId из chat.id (см. handleI2crmOutgoing).
		if (isComment && payload?.media_id && payload?.comment_id) {
			(this.prisma as any).igCommentContext.upsert({
				where: {
					clientId_mediaId: {
						clientId: String(clientId),
						mediaId: String(payload.media_id),
					},
				},
				create: {
					clientId: String(clientId),
					mediaId: String(payload.media_id),
					commentId: String(payload.comment_id),
				},
				update: {
					commentId: String(payload.comment_id),
				},
			}).catch((e: any) => {
				this.logger.warn(`i2crm: save IgCommentContext failed (non-fatal): ${e.message}`);
			});
		}

		// Backfill UF_CRM_IG_CHAT_ID/USERNAME на созданный B24 лид и контакт.
		// B24 создаёт CRM-сущности через open-line асинхронно (с задержкой 1-3с),
		// поэтому опрашиваем crm.activity с retry. Без этого UF остаётся пустым
		// → нельзя матчить контакт по chatId при следующих сообщениях, что
		// ломает кросс-канальную связку (пример: тот же IG-клиент звонит по
		// phone → создаётся второй контакт без связи с IG).
		// Передаём session/chat для карточки клиента в TG-mirror.
		// URL поста (src в payload) приходит для комментариев — пишем в стандартный
		// мультифилд LINK с типом LINK0 («активная ссылка на пост источника лида»).
		const igMediaSuffix = isComment && mediaIdForKey ? `_c${mediaIdForKey}` : "";
		this.backfillIgUfFields(portalDomain, String(clientId), username, channelLabel, channel, sessionInfo, igPostUrl, i2crmContactId, igMediaSuffix).catch((e) => {
			this.logger.warn(`i2crm: backfill UF failed (non-fatal): ${e.message}`);
		});

		return { success: true };
	}

	// Профилактика: повторная доставка всех pending-событий i2crm в B24.
	// Вызывается из /webhooks/internal/i2crm-replay после восстановления B24
	// (например после OVERLOAD_LIMIT). Идёт по pending'ам один раз; неуспешные
	// остаются pending и попадут в следующий replay.
	async replayPendingI2crmEvents(opts: {
		limit?: number;
		since?: Date;
		dryRun?: boolean;
	}): Promise<{ total: number; sent: number; errors: number; skipped: number }> {
		const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
		const where: any = { status: "pending" };
		if (opts.since) {
			where.receivedAt = { gte: opts.since };
		}

		const pending = await (this.prisma as any).i2crmEventLog.findMany({
			where,
			orderBy: { receivedAt: "asc" },
			take: limit,
		});

		const total = pending.length;
		let sent = 0;
		let errors = 0;
		let skipped = 0;

		for (const row of pending) {
			if (opts.dryRun) {
				skipped++;
				continue;
			}

			let parsed: any;
			try {
				parsed = JSON.parse(row.payload);
			} catch (e: any) {
				errors++;
				try {
					await (this.prisma as any).i2crmEventLog.update({
						where: { id: row.id },
						data: {
							attempts: { increment: 1 },
							lastError: `payload parse error: ${e.message}`.slice(0, 2000),
						},
					});
				} catch (updErr: any) {
					this.logger.warn(`i2crm-replay: failed to update row ${row.id} after parse error: ${updErr.message}`);
				}
				continue;
			}

			try {
				const result = await this.handleI2crmIncoming(parsed);
				if (result.success) {
					await (this.prisma as any).i2crmEventLog.update({
						where: { id: row.id },
						data: {
							status: "sent",
							sentAt: new Date(),
							attempts: { increment: 1 },
							lastError: null,
						},
					});
					sent++;
				} else {
					await (this.prisma as any).i2crmEventLog.update({
						where: { id: row.id },
						data: {
							attempts: { increment: 1 },
							lastError: `handler skipped: ${result.reason || "unknown"}`.slice(0, 2000),
						},
					});
					errors++;
				}
			} catch (e: any) {
				errors++;
				try {
					await (this.prisma as any).i2crmEventLog.update({
						where: { id: row.id },
						data: {
							attempts: { increment: 1 },
							lastError: String(e?.message || e).slice(0, 2000),
						},
					});
				} catch (updErr: any) {
					this.logger.warn(`i2crm-replay: failed to update row ${row.id} after handler error: ${updErr.message}`);
				}
			}
		}

		this.logger.info(`i2crm-replay: total=${total} sent=${sent} errors=${errors} skipped=${skipped}`);
		return { total, sent, errors, skipped };
	}

	/** Этап 3: связь b24 message_id ↔ IG comment. После того как мы передали
	 *  входящий IG-коммент клиента через imconnector.send.messages, B24 пишет
	 *  его в чат открытой линии и присваивает свой message_id. Этот id в
	 *  response B24 не возвращает — узнаём через im.dialog.messages.get
	 *  последнего сообщения в чате (retry на случай race).
	 *  Сохраняем (b24ChatId, b24MessageId) → (clientId, mediaId, commentId).
	 *  Когда оператор в B24 сделает reply на это сообщение, по quote_id
	 *  найдём оригинальный comment_id и ответим именно на тот коммент. */

	/**
	 * Скачивает og:image / og:video с публичной страницы Instagram-поста.
	 *
	 * IG отдаёт OG-теги только OG-ботам соцсетей (whitelist Meta) — Chrome UA
	 * ловит login-wall. Поэтому используется User-Agent `facebookexternalhit`.
	 *
	 * og:image в HTML приходит с HTML-entities (`&amp;` вместо `&`). Без
	 * unescape Telegram/B24 не парсят query string CDN-URL → 403. Декодируем
	 * перед отдачей.
	 *
	 * Returns: { kind: "photo"|"video"|"none", url } — url пригоден для
	 * прямой подстановки в ATTACH B24 или photo Telegram'у.
	 */
	private async fetchInstagramPostMedia(
		postUrl: string,
	): Promise<{ kind: "photo" | "video" | "none"; url: string | null }> {
		try {
			const r = await axios.get(postUrl, {
				timeout: 10000,
				headers: {
					"User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
					"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
					"Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
				},
				maxRedirects: 5,
				validateStatus: () => true,
			});
			if (r.status !== 200 || typeof r.data !== "string") {
				return { kind: "none", url: null };
			}
			const decode = (s: string): string =>
				s.replace(/&amp;/g, "&")
					.replace(/&lt;/g, "<")
					.replace(/&gt;/g, ">")
					.replace(/&quot;/g, '"')
					.replace(/&#039;/g, "'")
					.replace(/&#39;/g, "'");
			const html = r.data as string;
			const mv = html.match(/<meta\s+property="og:video"\s+content="([^"]+)"/i);
			if (mv) return { kind: "video", url: decode(mv[1]) };
			const mi = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
			if (mi) return { kind: "photo", url: decode(mi[1]) };
			return { kind: "none", url: null };
		} catch (e: any) {
			this.logger.warn(`fetchInstagramPostMedia ${postUrl}: ${e.message}`);
			return { kind: "none", url: null };
		}
	}

	/**
	 * После imconnector.send.messages для IG-Comment отправляет в B24-чат
	 * служебное (SYSTEM=Y) сообщение с RICH_LINK-карточкой поста IG —
	 * оператор сразу видит превью поста, на который клиент комментирует.
	 *
	 * Дедуп: `IgCommentContext.pinnedMediaSent` (timestamp). Если уже
	 * установлен — повтор не делаем (например, в той же сессии пришло
	 * несколько комментов клиента под одним постом).
	 *
	 * SYSTEM=Y подтверждён эмпирически 25.05.2026: B24 рендерит attach
	 * в чате как ℹ️-сообщение, но НЕ форвардит на коннектор open-line.
	 * Клиент в Instagram дубль картинки своего поста не получает.
	 */
	private async maybeSendPinnedPostThumbnail(
		portalDomain: string,
		b24ChatId: string,
		clientId: string,
		mediaId: string,
		postUrl: string,
	): Promise<void> {
		// Проверяем дедуп: уже отправляли в этой (clientId, mediaId) сессии?
		const existing: any = await (this.prisma as any).igCommentContext.findUnique({
			where: { clientId_mediaId: { clientId, mediaId } },
		});
		if (existing?.pinnedMediaSent) {
			return;
		}

		const { kind, url } = await this.fetchInstagramPostMedia(postUrl);
		if (kind === "none" || !url) {
			this.logger.info(
				`i2crm pinned-thumb: og:image=none for ${postUrl} — skip (но контекст останется без флага, при следующем incoming повторим)`,
			);
			return;
		}

		try {
			// IMAGE 1080×1080 — большой preview в B24-чате. Раньше пробовали
			// RICH_LINK (preview ~150×150 — слишком мелко, оператор не
			// опознавал пост) и FILE (рендерится как «Скачать» link БЕЗ
			// preview вообще — ещё хуже). IMAGE с большими WIDTH/HEIGHT даёт
			// крупный кликабельный thumbnail без download-overhead.
			// Сам файл всегда 640×640 cropped (og:image hard limit Meta),
			// B24 масштабирует до WIDTH×HEIGHT — пиксели не появятся, но
			// physical размер preview на экране больше.
			const attach = [
				{
					IMAGE: {
						LINK: url,
						WIDTH: 810,
						HEIGHT: 1080,
					},
				},
			];
			await this.callBitrix24Method(portalDomain, "im.message.add", {
				DIALOG_ID: `chat${b24ChatId}`,
				MESSAGE: `🖼 Пост клиента: ${postUrl}`,
				ATTACH: attach,
				SYSTEM: "Y",
			});
			this.logger.info(
				`i2crm pinned-thumb: sent RICH_LINK to chat${b24ChatId} for media=${mediaId} kind=${kind}`,
			);
			// Помечаем upsert'ом (на случай если context ещё не существует —
			// он будет создан немного позже в основном flow, тогда update пройдёт).
			await (this.prisma as any).igCommentContext.upsert({
				where: { clientId_mediaId: { clientId, mediaId } },
				create: {
					clientId, mediaId,
					commentId: "", // будет перезаписан основным upsert'ом ниже в pipeline
					pinnedMediaSent: new Date(),
				},
				update: { pinnedMediaSent: new Date() },
			});
		} catch (e: any) {
			this.logger.warn(`i2crm pinned-thumb: send failed: ${e.message}`);
		}
	}

	private async linkIgCommentToB24Message(
		portalDomain: string, b24ChatId: string, clientId: string,
		mediaId: string, commentId: string, commentText: string = "",
	): Promise<void> {
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
		let b24MessageId: string | null = null;
		for (let attempt = 1; attempt <= 5; attempt++) {
			await sleep(attempt === 1 ? 500 : 800);
			try {
				const resp: any = await this.callBitrix24Method(portalDomain, "im.dialog.messages.get", {
					DIALOG_ID: `chat${b24ChatId}`,
					LIMIT: 1,
				});
				const list = Array.isArray(resp?.messages) ? resp.messages : [];
				const last = list[0];
				if (last?.id) {
					b24MessageId = String(last.id);
					break;
				}
			} catch (e: any) {
				this.logger.debug(`linkIgComment: dialog.messages.get attempt ${attempt} failed: ${e.message}`);
			}
		}
		if (!b24MessageId) {
			this.logger.warn(`linkIgComment: no b24 message_id for chat=${b24ChatId} comment=${commentId}`);
			return;
		}
		try {
			// commentText кладём как есть (без префикса «[Instagram комментарий…]»),
			// trim до 500 cимволов — длинных комментов в Instagram не бывает.
			const ct = (commentText || "").trim().slice(0, 500) || null;
			await (this.prisma as any).igInboundB24Link.create({
				data: { b24ChatId, b24MessageId, clientId, mediaId, commentId, commentText: ct },
			});
			this.logger.info(`linkIgComment: b24 ${b24ChatId}:${b24MessageId} → comment ${commentId} media ${mediaId} text="${(ct || "").slice(0, 40)}"`);
		} catch (e: any) {
			if (/Unique|duplicate/i.test(String(e?.message || ""))) {
				this.logger.debug(`linkIgComment: already linked b24 ${b24ChatId}:${b24MessageId}`);
			} else {
				this.logger.warn(`linkIgComment: insert failed: ${e.message}`);
			}
		}
	}

	/** IG Direct incoming → запоминаем (b24ChatId, b24MessageId) → external_id IG-сообщения.
	 *  Используется при reply «через Цитирование» в B24: парсим цитату, ищем text → external_id,
	 *  передаём в i2crm как reply_to_message_id → клиент в IG видит нативный reply.
	 *  Аналог linkIgCommentToB24Message, но для Direct (без media/comment_id). */
	private async linkIgDirectInboundToB24Message(
		portalDomain: string, b24ChatId: string, clientId: string,
		externalMessageId: string, messageText: string = "",
	): Promise<void> {
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
		let b24MessageId: string | null = null;
		for (let attempt = 1; attempt <= 5; attempt++) {
			await sleep(attempt === 1 ? 500 : 800);
			try {
				const resp: any = await this.callBitrix24Method(portalDomain, "im.dialog.messages.get", {
					DIALOG_ID: `chat${b24ChatId}`, LIMIT: 1,
				});
				const list = Array.isArray(resp?.messages) ? resp.messages : [];
				const last = list[0];
				if (last?.id) { b24MessageId = String(last.id); break; }
			} catch (e: any) {
				this.logger.debug(`linkIgDirectInbound: dialog.messages.get attempt ${attempt} failed: ${e.message}`);
			}
		}
		if (!b24MessageId) {
			this.logger.warn(`linkIgDirectInbound: no b24 message_id for chat=${b24ChatId} ext=${externalMessageId}`);
			return;
		}
		try {
			const mt = (messageText || "").trim().slice(0, 500) || null;
			await (this.prisma as any).igDirectInboundB24Link.create({
				data: { b24ChatId, b24MessageId, clientId, externalMessageId, messageText: mt },
			});
			this.logger.info(`linkIgDirectInbound: b24 ${b24ChatId}:${b24MessageId} → ext ${externalMessageId} text="${(mt || "").slice(0, 40)}"`);
		} catch (e: any) {
			if (/Unique|duplicate/i.test(String(e?.message || ""))) {
				this.logger.debug(`linkIgDirectInbound: already linked b24 ${b24ChatId}:${b24MessageId}`);
			} else {
				this.logger.warn(`linkIgDirectInbound: insert failed: ${e.message}`);
			}
		}
	}

	/**
	 * Backfill свежесозданного Direct-лида (от mirror-to-direct после `!` в comment-чате):
	 *   1. Подтянуть CONTACT_ID + UF_CRM_IG_CHAT_ID + UF_CRM_IG_USERNAME из контакта клиента
	 *      (резолвим по UF_CRM_IG_CHAT_ID на contact'е).
	 *   2. Найти открытый comment-лид того же клиента (SOURCE_ID="22|I2CRM", не F/S).
	 *      Если есть — записать его id в UF_CRM_LEAD_ID на Direct-лиде. Оператор увидит ссылку
	 *      «связан с лидом N» в карточке Direct-лида и сможет одним кликом перейти в comment.
	 *   3. STATUS_ID НЕ меняем (не помечаем как Дубликат) — иначе Direct-лид пропадёт из активной
	 *      ленты «В работе», и операторы не увидят новые входящие в Direct.
	 *
	 * Idempotent: если поля уже заполнены — пропускаем. Если Direct-лид не нашли — non-fatal
	 * (B24 мог не создать лид в принципе, например линия 18 настроена без CRM_CREATE).
	 */
	private async _backfillDirectMirrorLead(
		portalDomain: string,
		clientId: string,
		displayName: string,
		directLine: number,
	): Promise<void> {
		// B24 создаёт лид async после imconnector.send.messages (0-15с). retry до 6 раз.
		// На повторных mirror-сообщениях лид может уже существовать (созданный
		// прошлым mirror) — тогда ищем не только «свежий», а любой открытый
		// Direct-лид с матчем по TITLE/UF, чтобы заполнить пустые поля.
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
		let directLead: any = null;
		for (let attempt = 1; attempt <= 6; attempt++) {
			await sleep(attempt === 1 ? 2000 : 2500);
			try {
				// 1-я попытка — свежий (recent 5 min). 2+ — любой открытый.
				const filter: Record<string, any> = {
					"=SOURCE_ID": `${directLine}|I2CRM`,
					"%TITLE": displayName,
				};
				if (attempt === 1) {
					filter[">DATE_CREATE"] = new Date(Date.now() - 5 * 60 * 1000).toISOString();
				} else {
					filter["!STATUS_SEMANTIC_ID"] = ["F", "S"];
				}
				const leads: any = await this.callBitrix24Method(portalDomain, "crm.lead.list", {
					filter,
					select: ["ID", "TITLE", "CONTACT_ID", "UF_CRM_IG_CHAT_ID", "UF_CRM_IG_USERNAME", "UF_CRM_LEAD_ID", "STATUS_ID"],
					order: { DATE_CREATE: "DESC" },
				});
				if (Array.isArray(leads) && leads.length > 0) {
					directLead = leads[0];
					break;
				}
			} catch (e: any) {
				this.logger.debug(`backfillDirectMirror: crm.lead.list attempt ${attempt} failed: ${e.message}`);
			}
		}
		if (!directLead) {
			this.logger.warn(`backfillDirectMirror: не нашли Direct-лид для ${clientId}/${displayName}`);
			return;
		}

		// Резолвим контакт по UF_CRM_IG_CHAT_ID
		let contactId: number | undefined;
		try {
			const contacts: any = await this.callBitrix24Method(portalDomain, "crm.contact.list", {
				filter: { UF_CRM_IG_CHAT_ID: clientId },
				select: ["ID"],
			});
			if (Array.isArray(contacts) && contacts.length > 0) {
				contactId = parseInt(contacts[0].ID, 10);
			}
		} catch (e: any) {
			this.logger.warn(`backfillDirectMirror: contact.list failed: ${e.message}`);
		}

		// Ищем открытую CRM-сущность клиента — приоритет: сделка > comment-лид > любой лид.
		// Если найдём — пометим Direct-лид как «Дубликат» (STATUS_ID=12, семантика F)
		// с UF_CRM_LEAD_ID на эту сущность, чтобы:
		//   1. Direct-лид не висел в активной очереди как самостоятельный
		//   2. В B24-карточке сделки/лида появилась ссылка на Direct-чат
		// Открытая Direct-сессия (chat) остаётся — оператор пишет дальше из неё.
		let openEntity: { kind: "deal" | "lead"; id: number } | undefined;
		if (contactId) {
			try {
				const openDeals: any = await this.callBitrix24Method(portalDomain, "crm.deal.list", {
					filter: { CONTACT_ID: contactId, CLOSED: "N" },
					select: ["ID"],
					order: { DATE_CREATE: "DESC" },
				});
				if (Array.isArray(openDeals) && openDeals.length > 0) {
					openEntity = { kind: "deal", id: parseInt(openDeals[0].ID, 10) };
				}
			} catch (e: any) {
				this.logger.warn(`backfillDirectMirror: deal lookup failed: ${e.message}`);
			}
		}
		if (!openEntity) {
			try {
				const openLeads: any = await this.callBitrix24Method(portalDomain, "crm.lead.list", {
					filter: {
						UF_CRM_IG_CHAT_ID: clientId,
						"!STATUS_SEMANTIC_ID": ["F", "S"],
						"!=ID": directLead.ID,
					},
					select: ["ID", "SOURCE_ID"],
					order: { DATE_CREATE: "DESC" },
				});
				if (Array.isArray(openLeads) && openLeads.length > 0) {
					// Приоритет comment-лид (22|I2CRM); иначе любой открытый.
					const commentLead = openLeads.find((l: any) => String(l.SOURCE_ID).startsWith("22|"));
					openEntity = { kind: "lead", id: parseInt((commentLead || openLeads[0]).ID, 10) };
				}
			} catch (e: any) {
				this.logger.warn(`backfillDirectMirror: open-lead lookup failed: ${e.message}`);
			}
		}

		const updateFields: Record<string, any> = {};
		if (contactId && (!directLead.CONTACT_ID || Number(directLead.CONTACT_ID) === 0)) {
			updateFields.CONTACT_ID = contactId;
		}
		if (!directLead.UF_CRM_IG_CHAT_ID) {
			updateFields.UF_CRM_IG_CHAT_ID = clientId;
		}
		if (!directLead.UF_CRM_IG_USERNAME) {
			updateFields.UF_CRM_IG_USERNAME = displayName;
		}
		// Связь с открытой сущностью — как в widget backfillSendLead для openEntity.
		// Помечаем как Дубликат (STATUS_ID=12) только если есть куда привязывать;
		// иначе лид остаётся самостоятельным (status NEW), в активной очереди.
		if (openEntity && !directLead.UF_CRM_LEAD_ID && directLead.STATUS_ID !== "12") {
			updateFields.UF_CRM_LEAD_ID = openEntity.id;
			updateFields.STATUS_ID = "12";
			const origTitle = String(directLead.TITLE || "").trim();
			const prefix = `[Дубликат → ${openEntity.kind} ${openEntity.id}]`;
			if (!origTitle.startsWith("[Дубликат")) {
				updateFields.TITLE = origTitle ? `${prefix} ${origTitle}` : prefix;
			}
		}
		if (Object.keys(updateFields).length === 0) {
			this.logger.info(`backfillDirectMirror: lead ${directLead.ID} уже заполнен, nothing to update`);
			return;
		}
		try {
			await this.callBitrix24Method(portalDomain, "crm.lead.update", {
				id: directLead.ID,
				fields: updateFields,
			});
			const action = openEntity
				? `Дубликат → ${openEntity.kind} ${openEntity.id}`
				: `CONTACT_ID=${contactId || "-"}`;
			this.logger.info(
				`backfillDirectMirror: lead ${directLead.ID} ← ${action} ` +
				`(fields: ${Object.keys(updateFields).join(",")})`,
			);
		} catch (e: any) {
			this.logger.warn(`backfillDirectMirror: lead.update failed for ${directLead.ID}: ${e.message}`);
		}
	}

	private async backfillIgUfFields(
		portalDomain: string,
		clientId: string,
		username: string,
		channelLabel: string,
		channel: string = "instdir",
		sessionInfo: { sessionId?: string; chatId?: string } = {},
		postUrl: string = "",
		passedContactId?: number,
		mediaSuffix: string = "",
	): Promise<void> {
		// A2: для instcom userCode включает media (i2crm_ig_<c>_c<media>),
		// чтобы попасть в активность именно этой пост-сессии, а не любой
		// другой сессии того же клиента.
		const userCode = `i2crm_ig_${clientId}${mediaSuffix}`;
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

		for (let attempt = 1; attempt <= 6; attempt++) {
			await sleep(attempt === 1 ? 1500 : 2000);
			try {
				// Ищем CRM-активность «Сессия открытой линии». PROVIDER_PARAMS —
				// объект {USER_CODE: "social_connector|<line>|i2crm_ig_<id>|<b24user>"}.
				// %PROVIDER_PARAMS не работает как LIKE на JSON, фильтруем в коде.
				const activities: any = await this.callBitrix24Method(portalDomain, "crm.activity.list", {
					filter: { PROVIDER_ID: "IMOPENLINES_SESSION" },
					select: ["ID", "OWNER_ID", "OWNER_TYPE_ID", "PROVIDER_PARAMS"],
					order: { ID: "DESC" },
				});

				const list = Array.isArray(activities) ? activities : [];
				// Ищем первую активность чьё PROVIDER_PARAMS.USER_CODE содержит userCode.
				const act = list.find((a: any) => {
					const code = a?.PROVIDER_PARAMS?.USER_CODE;
					return typeof code === "string" && code.includes(userCode);
				});
				if (!act) {
					this.logger.debug(`i2crm: backfill attempt ${attempt}/6 — no activity yet for ${userCode}`);
					continue;
				}
				const ownerType = parseInt(act.OWNER_TYPE_ID, 10);
				const ownerId = parseInt(act.OWNER_ID, 10);

				// CHAT_ID — стабильный, пишем только если поле пустое. USERNAME —
				// может меняться (клиент сменил @ник), обновляем при каждом сообщении.
				// UF_CRM_INSTAGRAM (url) — синхронизируем с username чтобы кликабельная
				// ссылка в карточке вела на актуальный профиль (старое поле, было до
				// нашей интеграции, оставлено для удобства оператора).
				const buildIgUrl = (u: string) => `https://instagram.com/${u}/`;
				const buildUpdate = (currentChatId: any, currentUsername: any, currentUrl: any): Record<string, string> | null => {
					const fields: Record<string, string> = {};
					if (!currentChatId) fields.UF_CRM_IG_CHAT_ID = clientId;
					if (username && String(currentUsername || "") !== username) {
						fields.UF_CRM_IG_USERNAME = username;
					}
					if (username) {
						const newUrl = buildIgUrl(username);
						if (String(currentUrl || "") !== newUrl) {
							fields.UF_CRM_INSTAGRAM = newUrl;
						}
					}
					return Object.keys(fields).length > 0 ? fields : null;
				};

				// Если ранее уже был сохранён username и он изменился — оператору
				// нужно знать что клиент сменил @ник (для безопасности и контекста).
				// Шлём notification-сообщение в чат той же сессии через imconnector.send.messages.
				let usernameChange: { oldName: string; newName: string } | null = null;

				let contactId: number | undefined;
				let crmLineId: number | undefined;
				let leadTitle: string | undefined;
				if (ownerType === 1) {
					// LEAD
					const lead: any = await this.callBitrix24Method(portalDomain, "crm.lead.get", { id: ownerId });
					contactId = lead?.CONTACT_ID ? parseInt(lead.CONTACT_ID, 10) : undefined;
					leadTitle = lead?.TITLE;
					if (username && lead?.UF_CRM_IG_USERNAME && String(lead.UF_CRM_IG_USERNAME) !== username) {
						usernameChange = { oldName: String(lead.UF_CRM_IG_USERNAME), newName: username };
					}
					let upd: Record<string, any> | null = buildUpdate(lead?.UF_CRM_IG_CHAT_ID, lead?.UF_CRM_IG_USERNAME, lead?.UF_CRM_INSTAGRAM);
					// Если у нас есть зарезолвленный контакт клиента (по IG_CHAT_ID),
					// а на лиде сессии CONTACT_ID не проставлен — привязываем.
					// B24 матчит открытые линии по телефону, у Instagram-клиента его
					// обычно нет, поэтому связку контакта делаем сами (симметрично
					// tg-боту). Без этого вместо привязки получали бы дубль:
					// «<клиент> - Instagram (auto)» от ensureLead + сессия-лид B24.
					if (passedContactId && !lead?.CONTACT_ID) {
						if (!upd) upd = {};
						upd.CONTACT_ID = passedContactId;
					}
					// Yandex Metrika ClientId: только для лидов. С сайта заполняется
					// через NetForm (заявка/звонок), у IG-лидов нет. B24 требует поле
					// при смене стадии — ставим "-" если пусто.
					if (!lead?.UF_CRM_NF_YM_CLIENT_ID) {
						if (!upd) upd = {};
						upd.UF_CRM_NF_YM_CLIENT_ID = "-";
					}

					// URL поста IG-комментария → UF_CRM_1637656407829 (string).
					// На B24-стороне настроен бизнес-процесс, который копирует это
					// значение в UF_CRM_1638376742616 (тип url, поле «Link0 (активная
					// ссылка на пост источника лида)» — оно read-only через REST).
					// Перезаписываем при каждом новом комменте — актуальный пост.
					if (channel === "instcom" && postUrl && String(lead?.UF_CRM_1637656407829 || "") !== postUrl) {
						if (!upd) upd = {};
						upd.UF_CRM_1637656407829 = postUrl;
					}

					// (Раньше также писали URL поста в multifield LINK[LINK0] —
					// это создавало дубль в UI «Link 1». Убрано 2026-05-18: URL
					// поста идёт через UF_CRM_1637656407829, BP заполняет «Link0».)

					if (upd) {
						await this.callBitrix24Method(portalDomain, "crm.lead.update", {
							id: ownerId,
							fields: upd,
						});
						this.logger.info(`i2crm: backfilled UF on lead ${ownerId} (${channelLabel} ${clientId}, fields: ${Object.keys(upd).join(",")})`);
					}
					// Карточка клиента в TG-зеркало (один раз на лид, идемпотентно).
					this.i2crmTgMirror.postClientCard({
						clientId,
						leadId: ownerId,
						leadTitle,
						sessionId: sessionInfo.sessionId,
						chatId: sessionInfo.chatId,
						channel,
						portalDomain,
					}).catch((e) => this.logger.warn(`i2crm: tg-mirror postClientCard failed: ${e.message}`));
				} else if (ownerType === 3) {
					// CONTACT (редкий случай — обычно owner это лид)
					contactId = ownerId;
				} else if (ownerType === 2) {
					// DEAL — на сделке тоже запишем (UF_CRM_INSTAGRAM на deal нет —
					// поле существует только на lead/contact; B24 проигнорирует unknown).
					const deal: any = await this.callBitrix24Method(portalDomain, "crm.deal.get", { id: ownerId });
					if (username && deal?.UF_CRM_IG_USERNAME && String(deal.UF_CRM_IG_USERNAME) !== username) {
						usernameChange = usernameChange || { oldName: String(deal.UF_CRM_IG_USERNAME), newName: username };
					}
					const upd = buildUpdate(deal?.UF_CRM_IG_CHAT_ID, deal?.UF_CRM_IG_USERNAME, undefined);
					if (upd) {
						await this.callBitrix24Method(portalDomain, "crm.deal.update", {
							id: ownerId,
							fields: upd,
						});
						this.logger.info(`i2crm: backfilled UF on deal ${ownerId} (${channelLabel} ${clientId}, fields: ${Object.keys(upd).join(",")})`);
					}
				}

				if (contactId) {
					const contact: any = await this.callBitrix24Method(portalDomain, "crm.contact.get", { id: contactId });
					if (username && contact?.UF_CRM_IG_USERNAME && String(contact.UF_CRM_IG_USERNAME) !== username) {
						usernameChange = usernameChange || { oldName: String(contact.UF_CRM_IG_USERNAME), newName: username };
					}
					const upd = buildUpdate(contact?.UF_CRM_IG_CHAT_ID, contact?.UF_CRM_IG_USERNAME, contact?.UF_CRM_INSTAGRAM);
					if (upd) {
						await this.callBitrix24Method(portalDomain, "crm.contact.update", {
							id: contactId,
							fields: upd,
						});
						this.logger.info(`i2crm: backfilled UF on contact ${contactId} (${channelLabel} ${clientId}, fields: ${Object.keys(upd).join(",")})`);
					}
				}

				if (usernameChange) {
					// Из USER_CODE достаём line: `social_connector|<line>|i2crm_ig_<id>|<userId>`
					const m = (act?.PROVIDER_PARAMS?.USER_CODE || "").match(/^social_connector\|(\d+)\|/);
					if (m) crmLineId = parseInt(m[1], 10);
					await this.notifyUsernameChange(
						portalDomain,
						clientId,
						usernameChange.oldName,
						usernameChange.newName,
						crmLineId,
						username,
						{ leadId: ownerType === 1 ? ownerId : undefined, contactId },
					);
				}
				return;
			} catch (e: any) {
				this.logger.warn(`i2crm: backfill attempt ${attempt}/6 errored: ${e.message}`);
			}
		}
		this.logger.warn(`i2crm: backfill UF timed out after 6 attempts for ${userCode}`);
	}

	// Уведомление о смене @username клиента: 1) системное сообщение в чат
	// сессии IMOPENLINES, 2) запись в COMMENTS контакта (или лида если контакта
	// ещё нет) — для постоянной истории смен ника.
	private async notifyUsernameChange(
		portalDomain: string,
		clientId: string,
		oldUsername: string,
		newUsername: string,
		lineId: number | undefined,
		displayName: string,
		owners: { leadId?: number; contactId?: number },
	): Promise<void> {
		this.logger.info(`i2crm: username changed for client ${clientId}: @${oldUsername} → @${newUsername}`);

		const noticeText = `🔄 Клиент сменил Instagram-логин: @${oldUsername} → @${newUsername}\n(client_id: ${clientId} — не меняется, можно безопасно продолжать диалог)`;

		// 1. Сообщение в чат через imconnector.send.messages — оператор увидит
		// в той же сессии. Отправляем как «from client», чтобы в ленте появилось
		// сразу под последним сообщением клиента.
		if (lineId) {
			try {
				const userKey = `i2crm_ig_${clientId}`;
				await this.callBitrix24Method(portalDomain, "imconnector.send.messages", {
					CONNECTOR: "social_connector",
					LINE: lineId,
					MESSAGES: [{
						user: {
							id: userKey,
							name: displayName,
							url: `https://instagram.com/${newUsername}`,
						},
						message: {
							id: `username_change_${clientId}_${Date.now()}`,
							date: Math.floor(Date.now() / 1000),
							text: noticeText,
						},
						chat: {
							id: userKey,
							name: displayName,
							url: `https://instagram.com/${newUsername}`,
						},
						extra: { crm: "Y" },
					}],
				});
				this.logger.info(`i2crm: username-change notice posted to chat (line=${lineId})`);
			} catch (e: any) {
				this.logger.warn(`i2crm: failed to post username-change notice to chat: ${e.message}`);
			}
		}

		// 2. Запись в COMMENTS контакта (если есть) или лида — постоянная история.
		// Добавляем в начало (новые сверху). Дату — в МСК для удобства оператора.
		const now = new Date();
		const mskParts = new Intl.DateTimeFormat("ru-RU", {
			timeZone: "Europe/Moscow",
			day: "2-digit", month: "2-digit", year: "numeric",
			hour: "2-digit", minute: "2-digit",
		}).format(now);
		const historyLine = `${mskParts} МСК: Instagram @${oldUsername} → @${newUsername}`;

		const target = owners.contactId
			? { entity: "contact" as const, id: owners.contactId }
			: owners.leadId
				? { entity: "lead" as const, id: owners.leadId }
				: null;
		if (!target) return;

		try {
			const cur: any = await this.callBitrix24Method(portalDomain, `crm.${target.entity}.get`, { id: target.id });
			const existing = String(cur?.COMMENTS || "").trim();
			const updated = existing
				? `${historyLine}\n\n${existing}`
				: historyLine;
			await this.callBitrix24Method(portalDomain, `crm.${target.entity}.update`, {
				id: target.id,
				fields: { COMMENTS: updated },
			});
			this.logger.info(`i2crm: username-change appended to ${target.entity} ${target.id} COMMENTS`);
		} catch (e: any) {
			this.logger.warn(`i2crm: failed to append username-change to ${target.entity} ${target.id} COMMENTS: ${e.message}`);
		}
	}

	async handleStateInstanceWebhook(webhook: StateInstanceWebhook): Promise<void> {
		const idInstance = BigInt(webhook.instanceData.idInstance);
		this.logger.info(`State change for instance ${idInstance}: ${webhook.stateInstance}`);

		try {
			await this.prisma.updateInstanceState(idInstance, webhook.stateInstance);
		} catch (error: any) {
			this.logger.error(`Failed to update instance state: ${error.message}`);
		}
	}

	async processWebhook(body: Bitrix24WebhookDto): Promise<WebhookProcessResult> {
		if (body.event === "ONAPPINSTALL") {
			return await this.handleAppInstall(body);
		}
		if (body.event === "ONAPPUNINSTALL") {
			return await this.handleAppUninstall(body);
		}
		if (body.event && body.event === "ONIMCONNECTORMESSAGEADD") {
			return await this.handleBitrix24Webhook(body);
		}
		if (body.event && body.event === "ONIMCONNECTORSTATUSDELETE") {
			return await this.handleConnectorStatusDelete(body);
		}
		if (body.event && body.event === "ONIMCONNECTORLINEDELETE") {
			return await this.handleConnectorLineDelete(body);
		}
		if (body.PLACEMENT === "SETTING_CONNECTOR") {
			const configRequest: ConnectorConfigurationRequest = {
				CONNECTOR: body.CONNECTOR || "social_connector",
			};
			return await this.handleConnectorConfiguration(configRequest);
		}
		if (body.ACTION) {
			return await this.handleConnectorAction(body);
		}

		return await this.handleBitrix24Webhook(body);
	}

	private async handleAppInstall(body: Bitrix24WebhookDto): Promise<WebhookProcessResult> {
		this.logger.info("Handling ONAPPINSTALL event", {
			domain: body.auth?.domain,
			applicationToken: body.auth?.application_token,
		});

		try {
			const domain = body.auth?.domain;
			const applicationToken = body.auth?.application_token;

			if (!domain || !applicationToken) {
				throw new Error("Missing domain or application_token in ONAPPINSTALL event");
			}

			const user = await this.prisma.findUser(domain);
			if (user) {
				await this.prisma.updateUserApplicationToken(domain, applicationToken);
				this.logger.info(`Updated application token for existing portal: ${domain}`);
			} else {
				this.logger.warn(`User not found for ONAPPINSTALL event: ${domain}`);
			}

			// После переустановки B24 сбрасывает активацию коннекторов на линиях.
			// Восстанавливаем нужные binding'и — social_connector активен на всех
			// линиях которыми мы управляем. Если когда-то в B24 был установлен
			// i2crm-нативный коннектор (от приложения i2crm) — он мог реактивироваться,
			// удаляем его с линий 18/22 (Instagram через Public API не нуждается в нём).
			try {
				const igLineDirect = Number(this.configService.get<string>("I2CRM_LINE_ID_IG_DIRECT")) || 18;
				const igLineComment = Number(this.configService.get<string>("I2CRM_LINE_ID_IG_COMMENT")) || 22;
				for (const line of [igLineDirect, igLineComment]) {
					await this.callBitrix24Method(domain, "imconnector.activate", {
						CONNECTOR: "social_connector",
						LINE: line,
						ACTIVE: 1,
					});
					// Если i2crm-нативный был активен — деактивируем (наш Public API pipeline не зависит)
					await this.callBitrix24Method(domain, "imconnector.activate", {
						CONNECTOR: "i2crm",
						LINE: line,
						ACTIVE: 0,
					}).catch(() => undefined);
				}
				this.logger.info(`Connector activation restored after install: social_connector on lines ${igLineDirect},${igLineComment}; i2crm deactivated`);
			} catch (e: any) {
				this.logger.warn(`Connector re-activation after install failed (non-fatal): ${e.message}`);
			}

			return {
				success: true,
				message: "App installation processed successfully",
				data: {
					domain,
					hasApplicationToken: true,
				},
			};

		} catch (error: any) {
			this.logger.error("Failed to handle ONAPPINSTALL event", {
				error: error.message,
				domain: body.auth?.domain,
			});
			return {
				success: false,
				message: `Failed to process app installation: ${error.message}`,
			};
		}
	}

	private async handleAppUninstall(body: Bitrix24WebhookDto): Promise<WebhookProcessResult> {
		this.logger.info("Handling ONAPPUNINSTALL event", {
			domain: body.auth?.domain,
		});

		try {
			const domain = body.auth?.domain;

			if (!domain) {
				throw new Error("Missing domain in ONAPPUNINSTALL event");
			}

			const user = await this.prisma.findUser(domain);
			if (!user) {
				this.logger.warn(`User not found for ONAPPUNINSTALL event: ${domain}`);
				return {
					success: true,
					message: "User was not found (already uninstalled)",
					data: {domain},
				};
			}

			await this.prisma.deleteUser(domain);
			this.logger.info(`Deleted user for portal: ${domain}`);

			return {
				success: true,
				message: "App uninstalled successfully",
				data: {
					domain,
				},
			};
		} catch (error: any) {
			this.logger.error("Failed to handle ONAPPUNINSTALL event", {
				error: error.message,
				domain: body.auth?.domain,
			});
			return {
				success: false,
				message: `Failed to process app uninstallation: ${error.message}`,
			};
		}
	}

	private async handleConnectorStatusDelete(body: Bitrix24WebhookDto): Promise<WebhookProcessResult> {
		this.logger.info("Handling connector status deletion", {
			domain: body.auth?.domain,
			data: body.data,
		});

		try {
			const domain = body.auth?.domain;

			let connector: string | undefined;
			let line: string | number | undefined;

			if (body.data) {
				connector = body.data.connector || body.data.CONNECTOR || body.data?.FIELDS?.CONNECTOR;
				line = body.data.line || body.data.LINE || body.data?.FIELDS?.LINE;
			}

			if (!domain) {
				throw new Error("Domain missing from status delete webhook");
			}

			if (!line) {
				this.logger.warn("No line specified in status delete webhook", {domain, data: body.data});
				return {success: true, message: "No line to process"};
			}

			const instances = await this.prisma.getInstancesByUserId(domain);
			const targetInstance = instances.find(inst => inst.bitrixLine === parseInt(line.toString()));

			if (targetInstance) {
				await this.prisma.removeInstance(targetInstance.idInstance);

				this.logger.info(`Instance deleted for connector status deletion`, {
					domain,
					line,
					connector,
					instanceId: targetInstance.idInstance.toString(),
				});

				return {
					success: true,
					message: "Connector disconnected and instance deleted",
					data: {
						domain,
						line,
						connector,
						deletedInstanceId: targetInstance.idInstance.toString(),
					},
				};
			} else {
				this.logger.info(`No instance found for line ${line} on domain ${domain}`);
				return {
					success: true,
					message: "No instance found for this line",
					data: {domain, line, connector},
				};
			}

		} catch (error: any) {
			this.logger.error("Failed to handle connector status deletion", error);
			return {
				success: false,
				message: `Failed to delete connector: ${error.message}`,
			};
		}
	}

	private async handleConnectorLineDelete(body: Bitrix24WebhookDto): Promise<WebhookProcessResult> {
		this.logger.info("Handling connector line deletion", {
			domain: body.auth?.domain,
			data: body.data,
			rawData: JSON.stringify(body.data),
		});

		try {
			const domain = body.auth?.domain;
			let lineId: string | number | undefined;

			if (body.data) {
				lineId = body.data.LINE ||
					body.data.line ||
					body.data?.FIELDS?.LINE_ID ||
					body.data?.FIELDS?.LINE;

				if (!lineId && (typeof body.data === "string" || typeof body.data === "number")) {
					lineId = body.data;
				}
			}

			if (!domain) {
				throw new Error("Domain missing from line delete webhook");
			}

			if (!lineId) {
				this.logger.warn("No LINE_ID specified in line delete webhook", {
					domain,
					data: body.data,
					dataType: typeof body.data,
					dataKeys: body.data && typeof body.data === "object" ? Object.keys(body.data) : "not object",
				});
				return {success: true, message: "No line ID to process"};
			}

			const lineNumber = parseInt(lineId.toString());

			this.logger.info(`Looking for instances with line ${lineNumber} for domain ${domain}`);

			const instances = await this.prisma.getInstancesByUserId(domain);
			const lineInstances = instances.filter(inst => inst.bitrixLine === lineNumber);

			this.logger.info(`Found ${lineInstances.length} instances for line ${lineNumber}`, {
				allInstances: instances.map(i => ({id: i.idInstance.toString(), line: i.bitrixLine})),
				targetInstances: lineInstances.map(i => ({id: i.idInstance.toString(), line: i.bitrixLine})),
			});

			const deletedInstanceIds: string[] = [];

			for (const instance of lineInstances) {
				await this.prisma.removeInstance(instance.idInstance);
				deletedInstanceIds.push(instance.idInstance.toString());
				this.logger.info(`Deleted instance ${instance.idInstance} for line ${lineNumber}`);
			}

			this.logger.info(`Line deletion completed`, {
				domain,
				lineId: lineNumber,
				deletedCount: deletedInstanceIds.length,
				deletedInstanceIds,
			});

			return {
				success: true,
				message: `Line deleted and ${deletedInstanceIds.length} instance(s) removed`,
				data: {
					domain,
					lineId: lineNumber,
					deletedCount: deletedInstanceIds.length,
					deletedInstanceIds,
				},
			};

		} catch (error: any) {
			this.logger.error("Failed to handle connector line deletion", {
				error: error.message,
				stack: error.stack,
				domain: body.auth?.domain,
				data: body.data,
			});
			return {
				success: false,
				message: `Failed to delete line: ${error.message}`,
			};
		}
	}

	private async handleConnectorAction(body: Bitrix24WebhookDto): Promise<WebhookProcessResult> {
		this.logger.info(`Processing connector action: ${body.ACTION}`, {
			action: body.ACTION,
			domain: body.auth?.domain || "missing",
			hasSettings: !!body.SETTINGS,
			settingsKeys: body.SETTINGS ? Object.keys(body.SETTINGS) : [],
			line: body.LINE,
		});

		switch (body.ACTION) {
			case "CONFIGURATION":
				const configRequest: ConnectorConfigurationRequest = {
					CONNECTOR: body.CONNECTOR || "social_connector",
				};
				return await this.handleConnectorConfiguration(configRequest);
			case "SAVE":
				this.logger.debug("SAVE action validation", {
					hasAuth: !!body.auth,
					hasDomain: !!body.auth?.domain,
					hasAccessToken: !!body.auth?.access_token,
					hasSettings: !!body.SETTINGS,
					hasInstanceId: !!body.SETTINGS?.instance_id,
					hasApiToken: !!body.SETTINGS?.api_token,
					instanceIdFormat: body.SETTINGS?.instance_id ?
						/^\d{10,12}$/.test(body.SETTINGS.instance_id.toString()) : false,
					apiTokenLength: body.SETTINGS?.api_token?.length || 0,
				});

				return await this.handleConnectorSave(body);
			default:
				this.logger.warn(`Unknown action received: ${body.ACTION}`);
				return {success: false, message: `Unknown action: ${body.ACTION}`};
		}
	}

	async handleConnectorConfiguration(body: ConnectorConfigurationRequest): Promise<ConnectorConfigurationResponse> {
		this.logger.info("Handling connector configuration", body);
		const connector = body.CONNECTOR;

		if (connector !== "social_connector") {
			throw new Error("Invalid connector type");
		}

		return {
			success: true,
			message: "Connector configuration retrieved successfully",
			data: {
				name: "GREEN-API Configuration",
				settings: [
					{
						name: "instance_id",
						title: "GREEN-API Instance ID",
						type: "string",
						required: true,
						placeholder: "Enter your Instance ID from console.green-api.com",
					},
					{
						name: "api_token",
						title: "GREEN-API API Token",
						type: "string",
						required: true,
						placeholder: "Enter your API Token from console.green-api.com",
					},
				],
			},
		};
	}

	async handleConnectorSave(body: Bitrix24WebhookDto): Promise<WebhookProcessResult> {
		this.logger.info("Handling connector save", body);

		const domain = body.auth?.domain;
		const settings = body.SETTINGS;
		const line = body.LINE || 0;
		const instanceId = settings?.instance_id;
		const apiToken = settings?.api_token;
		const accessToken = body.auth?.access_token;

		this.logger.info(`Configuring connector for line: ${line}`);

		const missingFields: string[] = [];
		if (!domain) missingFields.push("domain");
		if (!instanceId) missingFields.push("instance_id");
		if (!apiToken) missingFields.push("api_token");
		if (!accessToken) missingFields.push("access_token");

		if (missingFields.length > 0) {
			const errorMessage = `Missing required parameters: ${missingFields.join(", ")}`;
			this.logger.error(errorMessage, {
				provided: {
					domain: !!domain,
					instanceId: !!instanceId,
					apiToken: !!apiToken,
					accessToken: !!accessToken,
					line: line,
				},
				body: JSON.stringify(body, null, 2),
			});
			throw new Error(errorMessage);
		}

		if (!/^\d{10}$/.test(instanceId!.toString())) {
			throw new Error("Invalid instance ID format. Must be 10 digits.");
		}

		if (!apiToken || apiToken.length < 20) {
			throw new Error("Invalid API token format. Token seems too short.");
		}

		try {
			const user = await this.prisma.findUser(domain);
			if (!user) {
				throw new NotFoundError(`User not found for domain: ${domain}. Please reinstall the Bitrix24 app.`);
			}

			const instance = await this.createInstanceForConnector(
				domain,
				BigInt(instanceId!),
				apiToken,
				line,
			);

			await this.callBitrix24Method(domain, "imconnector.activate", {
				CONNECTOR: "social_connector",
				LINE: line,
				ACTIVE: true,
			}, accessToken);

			await this.updateConnectorLineData(domain, line, accessToken!);
			this.logger.info(`GREEN-API connector configured successfully for ${domain}`);

			return {
				success: true,
				message: "GREEN-API connector configured successfully! You can now send and receive WhatsApp messages in Bitrix24.",
				data: {
					instanceId: instance.idInstance.toString(),
					line: line,
					domain: domain,
				},
			};

		} catch (error: any) {
			this.logger.error(`Failed to save connector: ${error.message}`, {
				domain,
				instanceId,
				error: error.stack,
			});

			if (error.message.includes("User not found")) {
				throw new Error("Bitrix24 integration not properly installed. Please reinstall the app from Bitrix24 Market.");
			} else if (error.message.includes("GREEN-API validation failed")) {
				throw new Error("Invalid GREEN-API credentials. Please check your Instance ID and API Token.");
			} else if (error.message.includes("BITRIX24_API_ERROR")) {
				throw new Error("Failed to activate connector in Bitrix24. Please try again or contact support.");
			}

			throw error;
		}
	}

	private async updateConnectorLineData(domain: string, line: number, accessToken: string): Promise<void> {
		try {
			const appUrl = this.configService.get<string>("APP_URL");
			await this.callBitrix24Method(domain, "imconnector.connector.data.set", {
				CONNECTOR: "social_connector",
				LINE: line,
				DATA: {
					id: `social_connector_line_${line}`,
					url: `${appUrl}/webhooks/bitrix24`,
					name: "Social Connector",
					description: "Universal messenger connector",
				},
			}, accessToken);

			this.logger.info(`Connector data set successfully for ${domain}, line ${line}`);
		} catch (error: any) {
			this.logger.error(`Failed to update connector status: ${error.message}`);
		}
	}

	private async createInstanceForConnector(
		portalDomain: string,
		idInstance: number | bigint,
		apiTokenInstance: string,
		line: number,
	): Promise<Instance> {
		this.logger.info(`Creating GREEN-API instance ${idInstance} for portal ${portalDomain}, line ${line}`);
		const gaClient = this.createGreenApiClient({idInstance, apiTokenInstance});
		const stateInstance = await gaClient.getStateInstance().then(r => r.stateInstance);

		const user = await this.prisma.findUser(portalDomain);
		if (!user) {
			throw new NotFoundError(`User not found for portal ${portalDomain}`);
		}
		const existingInstance = await this.prisma.getInstanceByIdWithUser(idInstance);

		if (existingInstance) {
			if (existingInstance.userId === portalDomain && existingInstance.bitrixLine === line) {
				this.logger.info(`Instance ${idInstance} already configured for this portal and line, updating...`);

				const appBaseUrl = this.configService.get<string>("APP_URL");
				const settings: Settings = {
					webhookUrl: `${appBaseUrl}/webhooks/green-api`,
					webhookUrlToken: generateRandomToken(24),
					incomingWebhook: "yes",
					stateWebhook: "yes",
					incomingCallWebhook: "yes",
				};

				const updatedInstance = await this.prisma.updateInstance(idInstance, {
					apiTokenInstance,
					settings,
				});

				const client = this.createGreenApiClient({
					idInstance: BigInt(idInstance),
					stateInstance,
					apiTokenInstance,
					settings,
				});

				try {
					await client.getSettings();
					await client.setSettings(settings);
					this.logger.info(`Successfully updated instance ${idInstance}`);
				} catch (error: any) {
					throw new IntegrationError(`GREEN-API validation failed: ${error.message}`, "INTEGRATION_ERROR");
				}

				return updatedInstance;
			} else {
				const conflictDetails = existingInstance.userId !== portalDomain
					? `different portal (${existingInstance.user.portalDomain})`
					: `different line (line ${existingInstance.bitrixLine})`;

				throw new IntegrationError(
					`Instance ${idInstance} is already being used by ${conflictDetails}. Each GREEN-API instance can only be connected to one Bitrix24 line.`,
					"INSTANCE_ALREADY_IN_USE",
				);
			}
		}

		const instances = await this.prisma.getInstancesByUserId(portalDomain);
		const lineInstance = instances.find(inst => inst.bitrixLine === line);

		if (lineInstance) {
			this.logger.info(`Line ${line} already has instance ${lineInstance.idInstance}, replacing with ${idInstance}`);

			await this.prisma.removeInstance(lineInstance.idInstance);
			this.logger.info(`Removed old instance ${lineInstance.idInstance} from line ${line}`);
		}

		const appBaseUrl = this.configService.get<string>("APP_URL");
		const settings: Settings = {
			webhookUrl: `${appBaseUrl}/webhooks/green-api`,
			webhookUrlToken: generateRandomToken(24),
			incomingWebhook: "yes",
			stateWebhook: "yes",
			incomingCallWebhook: "yes",
		};

		try {
			const instanceData = {
				idInstance: BigInt(idInstance),
				apiTokenInstance,
				user: {connect: {id: user.id}},
				settings,
				stateInstance,
				bitrixLine: line,
			};

			const instance = await this.prisma.createInstance(instanceData);

			const client = this.createGreenApiClient({
				idInstance: BigInt(idInstance),
				apiTokenInstance,
				settings,
			});

			try {
				await client.getSettings();
				await client.setSettings(settings);

				this.logger.info(`Successfully created and configured instance ${idInstance} for portal ${portalDomain}`);
			} catch (error: any) {
				await this.prisma.removeInstance(instance.idInstance);
				throw new IntegrationError(`GREEN-API validation failed: ${error.message}`, "INTEGRATION_ERROR");
			}

			return instance;
		} catch (error: any) {
			this.logger.error(`Failed to create instance: ${error.message}`, {
				portalDomain,
				idInstance: idInstance.toString(),
				error: error.stack,
			});
			throw error;
		}
	}

	// Outgoing B24 → i2crm: оператор пишет в open-line 18/22 → отправляем
	// клиенту в Instagram через i2crm Public API.
	async handleI2crmOutgoing(webhook: Bitrix24WebhookDto, lineNumber: number): Promise<WebhookProcessResult> {
		const messages = webhook.data?.MESSAGES;
		if (!messages || messages.length === 0) {
			return { success: false, message: "no MESSAGES in webhook" };
		}
		const m = messages[0];

		const lineDirect = Number(this.configService.get<string>("I2CRM_LINE_ID_IG_DIRECT"));
		const lineComment = Number(this.configService.get<string>("I2CRM_LINE_ID_IG_COMMENT"));
		const isDirect = lineNumber === lineDirect;
		const isComment = lineNumber === lineComment;
		if (!isDirect && !isComment) {
			return { success: false, message: `line ${lineNumber} не Instagram (not 18/22)` };
		}

		// chat.id у нас:
		//   instdir:  i2crm_ig_<client_id>
		//   instcom:  i2crm_ig_<client_id>_c<media_id>  (A2: пост на сессию)
		// Старые сессии без media_id-суффикса поддерживаем для обратной совместимости.
		const rawChatId = String(m.chat?.id || "");
		// Форматы chat.id для IG (incoming пишет их же, должны сопадать):
		//   i2crm_ig_<clientId>                                   — direct
		//   i2crm_ig_<clientId>_c<mediaId>                        — старый comment (legacy)
		//   i2crm_ig_<clientId>_c<mediaId>_<accountId>            — текущий comment (A2, sha cacfa1f)
		// Раньше regex был только на первые два — все актуальные comments
		// падали в fallback \D → garbage склейка → i2crm «Некорректные данные».
		// Инцидент 25.05 14:31 (dima_kuznetsov reply «!!!» и «=)» — оба не дошли).
		const matchCommentFull = rawChatId.match(/^i2crm_ig_(\d+)_c(\d+)_(\d+)$/);
		const matchCommentLegacy = rawChatId.match(/^i2crm_ig_(\d+)_c(\d+)$/);
		const matchClientOnly = rawChatId.match(/^i2crm_ig_(\d+)$/);
		let clientId: string;
		let mediaIdFromChat = "";
		if (matchCommentFull) {
			clientId = matchCommentFull[1];
			mediaIdFromChat = matchCommentFull[2];
			// group 3 = accountId, нам он не нужен (источник = настроенный в .env)
		} else if (matchCommentLegacy) {
			clientId = matchCommentLegacy[1];
			mediaIdFromChat = matchCommentLegacy[2];
		} else if (matchClientOnly) {
			clientId = matchClientOnly[1];
		} else {
			this.logger.error(
				`handleI2crmOutgoing: chat.id "${rawChatId}" не матчит i2crm_ig_<num>(_c<num>(_<num>)?)? ` +
				`(line=${lineNumber}, isComment=${isComment})`,
			);
			return {
				success: false,
				message: `cannot parse client_id from chat.id=${rawChatId} (line=${lineNumber})`,
			};
		}
		if (!clientId) {
			return { success: false, message: `cannot parse client_id from chat.id=${rawChatId}` };
		}

		let text = m.message?.text || "";
		const files: any[] = (m.message as any)?.files || [];

		// «!» в начале ответа в чате Instagram-комментария → отправляем
		// ответ комментатору в ЛИЧКУ (Direct), а не публичным комментарием.
		// Позволяет отвечать на комментарии в Директ прямо из мобильного
		// приложения Б24 (вкладка-виджет СК в мобильном недоступна).
		let replyAsDirect = isDirect;
		if (isComment) {
			const marker = text.match(/^\s*!\s*/);
			if (marker) {
				text = text.slice(marker[0].length);
				replyAsDirect = true;
				this.logger.info(`i2crm: ответ в чате комментария с пометкой «!» → отправляем в Директ (client=${clientId})`);
			}
		}

		// B24 webhook кладёт каждый file с двумя полями: link (короткий ~auth-only)
		// и downloadLink (public ?FILE_ID=...&SIGN=... — открывается без cookie).
		// i2crm должна СКАЧАТЬ файл и переслать в Instagram, поэтому используем
		// downloadLink. Раньше код брал f.url (отсутствует в payload) → photo
		// массив получался [undefined] и i2crm молча игнорировала, оператор
		// видел "часики" вечно.
		const fileUrl = (f: any) =>
			String(f?.downloadLink || f?.link || f?.url || "").trim();

		// Pre-flight: Instagram Direct лимит 1000 символов. i2crm всё равно
		// вернёт {error, validation:{text:[...]}} — но оператор узнаёт об этом
		// только спустя минуту по серой плашке «не доставлено» в B24. Шлём
		// alerts заранее системным сообщением в B24-чат открытой линии.
		const IG_DIRECT_TEXT_LIMIT = 1000;
		if (replyAsDirect && text && text.length > IG_DIRECT_TEXT_LIMIT) {
			const chatId = (m as any)?.im?.chat_id;
			const alertText =
				`❌ Не отправлено: Instagram Direct ограничен ${IG_DIRECT_TEXT_LIMIT} символами. ` +
				`Сейчас ${text.length}. Сократи и попробуй заново.`;
			if (chatId) {
				try {
					await this.callBitrix24Method(webhook.auth.domain, "im.message.add", {
						DIALOG_ID: `chat${chatId}`,
						MESSAGE: alertText,
						SYSTEM: "Y",
					});
				} catch (e: any) {
					this.logger.warn(`pre-flight alert failed: ${e.message}`);
				}
			}
			return {
				success: false,
				message: `text exceeds ${IG_DIRECT_TEXT_LIMIT} chars (${text.length})`,
			};
		}

		const apiBase = this.configService.get<string>("I2CRM_API_BASE") || "https://app.i2crm.ru/api_v1";
		const targetKey = this.configService.get<string>("I2CRM_TARGET_KEY_PUBLICAPI");
		if (!targetKey) {
			return { success: false, message: "I2CRM_TARGET_KEY_PUBLICAPI not configured" };
		}
		// source — это account_id IG бизнес-аккаунта (8215238716), не source.id i2crm.
		// Эмпирически выяснено 2026-05-16: при source=14713 (внутренний i2crm-id) API
		// отвечал «Нет активного канала для написания ответов в Директ». source=account_id работает.
		const accountId = this.configService.get<string>("I2CRM_INSTAGRAM_ACCOUNT_ID");
		if (!accountId) {
			return { success: false, message: "I2CRM_INSTAGRAM_ACCOUNT_ID not configured" };
		}

		// Базовый body — общий для всех под-сообщений (см. цикл ниже).
		const baseBody: Record<string, any> = {
			domain: "instagram",
			source: String(accountId),
			client: String(clientId),
			type: replyAsDirect ? "direct" : "comment",
		};
		// Этап 3 v2: B24 open-lines не передаёт parent_id для «Ответить» в
		// outgoing-webhook — это просто focus в UI без API-связки. Но если
		// оператор воспользовался «Цитировать сообщение» (доп. в меню), то
		// в text прилетает BB-цитата с разделителями `------`. Парсим её,
		// извлекаем тело + ищем в IgInboundB24Link по `commentText` совпадение.
		// Если нашлось — отвечаем именно на тот comment_id.
		let replyMatched: { mediaId: string; commentId: string } | null = null;
		const imBlock: any = (m as any).im || {};
		const replyB24ChatId = String(imBlock?.chat_id || "");
		// Регексп цитаты: разделитель = строка из 20+ дефисов, дальше автор
		// `<name> [<date>]`, потом тело, потом ещё разделитель, потом ответ.
		const quoteRegex = /^-{20,}\s*\n[^\n]+\[[^\]]+\]\s*\n([\s\S]*?)\n-{20,}\s*\n([\s\S]*)$/;
		const quoteMatch = text.match(quoteRegex);
		let quotedBody = "";
		// Цитата всегда вырезается из text — клиенту в Instagram уходит только
		// сам ответ оператора, без BB-разделителей и текста цитируемого сообщения.
		// (Раньше вырезалось только в comment-режиме для матча commentId,
		// в Direct оставалось сырым → клиент видел «-------\ndima_kuznetsov
		// [сегодня, 16:30]\n…\n-------\nответ» как plain text. Жалоба 25.05.)
		if (quoteMatch) {
			quotedBody = quoteMatch[1].trim();
			// Очищаем тело цитаты для последующего матча в БД (только для comment):
			// — снимаем префикс «[Instagram комментарий к посту …]\n» (с/без BB-URL)
			// — раскрываем [URL=…]label[/URL] до raw URL
			quotedBody = quotedBody
				.replace(/^\[Instagram\s+комментарий\s+к\s+посту[^\n]*\n/i, "")
				.replace(/\[URL=([^\]]+)\][^\[]*\[\/URL\]/g, "$1")
				.trim();
			// Оператор-text = цитата + ответ → оставляем только ответ.
			text = quoteMatch[2].trim();
		}
		if (isComment && !replyAsDirect && quotedBody && replyB24ChatId) {
			try {
				// LIKE для устойчивости к мелкой разнице (emoji rendering, пробелы).
				// Берём первые ~120 cимволов тела цитаты — достаточно для точного матча.
				const needle = quotedBody.slice(0, 120);
				const rows: any[] = await (this.prisma as any).$queryRaw`
					SELECT b24MessageId, mediaId, commentId, commentText
					FROM IgInboundB24Link
					WHERE b24ChatId = ${replyB24ChatId}
					  AND commentText IS NOT NULL
					  AND commentText LIKE ${needle + "%"}
					ORDER BY createdAt DESC
					LIMIT 1
				`;
				if (rows.length > 0 && rows[0].commentId && rows[0].mediaId) {
					replyMatched = { mediaId: rows[0].mediaId, commentId: rows[0].commentId };
					this.logger.info(
						`i2crm reply: цитата «${needle.slice(0, 40)}» → comment ${rows[0].commentId} media ${rows[0].mediaId}`,
					);
				} else {
					this.logger.info(`i2crm reply: цитата «${needle.slice(0, 40)}» — match не найден, fallback на «последний коммент»`);
				}
			} catch (e: any) {
				this.logger.warn(`i2crm reply quote lookup failed: ${e.message}`);
			}
		}

		// Для публичного comment-ответа: media (post id) и comment (parent
		// comment id) обязательны после перехода i2crm на «официальный» способ.
		// Приоритет — replyMatched (reply на конкретное сообщение). Иначе
		// IgCommentContext по mediaId. Для replyAsDirect эти поля не нужны.
		if (isComment && !replyAsDirect) {
			try {
				let ctx: any = replyMatched;
				if (!ctx && mediaIdFromChat) {
					ctx = await (this.prisma as any).igCommentContext.findUnique({
						where: {
							clientId_mediaId: {
								clientId: String(clientId),
								mediaId: mediaIdFromChat,
							},
						},
					});
				}
				if (!ctx) {
					const rows = await (this.prisma as any).igCommentContext.findMany({
						where: { clientId: String(clientId) },
						orderBy: { updatedAt: "desc" },
						take: 1,
					});
					ctx = rows[0] || null;
				}
				if (ctx?.mediaId && ctx?.commentId) {
					baseBody.media = ctx.mediaId;
					baseBody.comment = ctx.commentId;
				} else {
					this.logger.warn(`i2crm comment: no context for client=${clientId} media=${mediaIdFromChat || "—"} — request will likely fail validation`);
				}
			} catch (e: any) {
				this.logger.warn(`i2crm comment: lookup failed: ${e.message}`);
			}
		}

		// Фото отправляем в i2crm multipart-загрузкой САМИХ БАЙТОВ файла (поле
		// `photo`), а не ссылкой. Ссылочный способ (`url`) ненадёжен: i2crm
		// определяет тип файла по расширению в URL, а B24 отдаёт ссылку вида
		// `…/im.file.php?FILE_ID=…` без расширения → «файл не поддерживается».
		// При загрузке байтов мы сами задаём имя (с расширением) и Content-Type.
		// На каждое фото — отдельный вызов; текст идёт вместе с первым.
		const photoFiles: any[] = replyAsDirect
			? files.filter((f) => fileUrl(f).length > 0)
			: []; // публичный ответ на Instagram-комментарий — только текст
		if (files.length > 0 && replyAsDirect && photoFiles.length === 0) {
			this.logger.warn(`i2crm outgoing: files.length=${files.length} но ссылка не извлечена (link/downloadLink пустые)`);
		}

		type SendPart =
			| { kind: "text"; text: string }
			| { kind: "photo"; file: any; text?: string };
		const parts: SendPart[] = [];
		if (photoFiles.length > 0) {
			photoFiles.forEach((f, i) => {
				parts.push({ kind: "photo", file: f, text: i === 0 && text ? text : undefined });
			});
		} else if (text) {
			parts.push({ kind: "text", text });
		}
		if (parts.length === 0) {
			return { success: false, message: "nothing to send (no text, no files)" };
		}

		this.logger.info(`i2crm outgoing: POST ${apiBase}/target/feedback`, {
			domain: baseBody.domain, source: baseBody.source, client: baseBody.client,
			type: baseBody.type, hasText: !!text, photos: photoFiles.length,
		});

		let lastResult: any = null;
		let externalMessageId: any = null;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			try {
				let resp: any;
				if (part.kind === "photo") {
					// Скачиваем файл из B24 (ссылка /pub/im.file.php?…&SIGN=… —
					// публичная, без авторизации) и грузим байты в i2crm.
					const dl = await axios.get(fileUrl(part.file), {
						responseType: "arraybuffer",
						timeout: 25000,
						maxContentLength: Infinity,
					});
					const buffer = Buffer.from(dl.data);
					const filename = String(part.file?.name || "image.jpg").replace(/[^\w.\-]/g, "_");
					const mime = String(part.file?.mime || "image/jpeg");
					const fields: Record<string, string> = {
						domain: baseBody.domain,
						source: baseBody.source,
						client: baseBody.client,
						type: baseBody.type,
					};
					if (part.text) fields.text = part.text;
					resp = await this._postI2crmFeedbackMultipart(
						apiBase, String(targetKey), fields, { buffer, filename, mime },
					);
				} else {
					resp = await axios.post(
						`${apiBase}/target/feedback`,
						{ ...baseBody, text: part.text },
						{
							params: { key: targetKey },
							// 60s — i2crm обрабатывает запрос синхронно и ждёт ответ
							// Instagram Graph API. При тормозах Meta 15s часто мало,
							// adapter падал «transport error: timeout of 15000ms exceeded»,
							// в UI плашка «не доставлено», хотя i2crm потом доставлял
							// (запрос-то прошёл, мы просто перестали ждать ответ).
							// Инцидент 25.05 — Анастасия Василенко, IG-direct.
							timeout: 60000,
							// i2crm возвращает 200 с error в теле даже для бизнес-ошибок.
							validateStatus: () => true,
						},
					);
				}
				const result = resp.data;
				// i2crm: {error:false,data:{...}} при успехе, {error:"<msg>",...} при ошибке.
				if (result?.error) {
					this.logger.error(`i2crm outgoing rejected by i2crm API (part ${i + 1}/${parts.length})`, {
						httpStatus: resp.status,
						error: result.error,
						data: result.data,
					});
					// Customer-360: delivery_status=failed для outgoing-pending ленты
					void this._emitMessageDeliveryEvent({
						idMessage: String(externalMessageId || (m as any)?.id || `i2crm-fail-${Date.now()}`),
						status: "failed",
						source: "bridge_ig",
						channel: "IG",
						connector: "i2crm",
						error: typeof result.error === "string" ? result.error : "validation failed",
					});
					return { success: false, message: `i2crm: ${typeof result.error === "string" ? result.error : "validation failed"}` };
				}
				this.logger.info(`i2crm outgoing OK (part ${i + 1}/${parts.length})`, { result });
				lastResult = result;
				externalMessageId = result?.data?.id || result?.data?.external_ids?.[0] || externalMessageId;
			} catch (err: any) {
				this.logger.error(`i2crm outgoing transport error: ${err.message}`);
				// Customer-360: delivery_status=failed (transport error)
				void this._emitMessageDeliveryEvent({
					idMessage: String(externalMessageId || (m as any)?.id || `i2crm-tx-${Date.now()}`),
					status: "failed",
					source: "bridge_ig",
					channel: "IG",
					connector: "i2crm",
					error: `transport: ${err.message}`.slice(0, 200),
				});
				return { success: false, message: `i2crm transport: ${err.message}` };
			}
		}
		// Customer-360: исходящее IG-сообщение в customer_events (best-effort).
		// A2: пишем media/comment/post_url, чтобы в ленте видно было, под каким
		// именно постом ответ ушёл (особенно важно когда у клиента несколько
		// открытых сессий-постов).
		void this._emitIgMessageEvent({
			clientId: String(clientId),
			direction: "out",
			text,
			igChannel: replyAsDirect ? "direct" : "comment",
			messageId: externalMessageId ? String(externalMessageId) : undefined,
			mediaId: baseBody.media ? String(baseBody.media) : undefined,
			commentId: baseBody.comment ? String(baseBody.comment) : undefined,
		});
		// Customer-360: delivery_status=sent сразу после успешного target/feedback.
		// IG (через i2crm) не присылает webhook delivery confirmation для нашего
		// outgoing — единственный сигнал успеха = response.error=false. Этого
		// достаточно чтобы /customer-360/outgoing-pending не показывал сообщение
		// как «зависшее».
		if (externalMessageId) {
			void this._emitMessageDeliveryEvent({
				idMessage: String(externalMessageId),
				status: "sent",
				source: "bridge_ig",
				channel: "IG",
				connector: "i2crm",
			});
		}

		// «!» из comment-чата → ответ ушёл клиенту в Direct, но B24 знает об этом
		// только в текущей **comment** open-line. Когда клиент ответит — i2crm
		// пришлёт нам Direct webhook и мы откроем отдельную Direct open-line,
		// но история переписки будет развязана: оператор не увидит свой первый
		// ответ в Direct-сессии.
		// Делаем зеркало: создаём direct open-line с тем же текстом, с
		// is_self_message=true чтобы B24 показал «это написал оператор».
		// Бесконечного цикла нет — is_self_message=true и B24 не webhookает
		// обратно (см. extra.is_self_message в widget mirror и i2crm incoming).
		if (replyAsDirect && isComment) {
			const portalDomain = webhook.auth?.domain;
			const directLine = Number(this.configService.get<string>("I2CRM_LINE_ID_IG_DIRECT"));
			// operatorId = тот оператор, который написал «!» в comment-чате.
			// Берём из webhook MESSAGES[0].message.user_id (это тот кто отправил
			// сообщение в B24-чате). Используем для auto-transfer Direct-сессии
			// сразу к нему, минуя очередь «Неотвеченные».
			const operatorId = Number(m?.message?.user_id) || 0;
			if (portalDomain && directLine) {
				const directUserKey = `i2crm_ig_${clientId}`;
				// Имя клиента: вытащим из B24 контакта по UF_CRM_IG_CHAT_ID если есть.
				// Иначе оставим username из i2crm-incoming context (последний known),
				// или просто client_id (B24 нормально с числом, контакт-резолв доберёт).
				let displayName: string = String(clientId);
				try {
					const cl: any = await this.callBitrix24Method(portalDomain, "crm.contact.list", {
						filter: { UF_CRM_IG_CHAT_ID: String(clientId) },
						select: ["NAME", "UF_CRM_IG_USERNAME"],
					});
					if (Array.isArray(cl) && cl.length > 0) {
						const u = cl[0].UF_CRM_IG_USERNAME?.toString().trim();
						const n = cl[0].NAME?.toString().trim();
						displayName = u || n || displayName;
					}
				} catch (e: any) {
					this.logger.warn(`mirror-to-direct: failed to resolve displayName for ${clientId}: ${e.message}`);
				}
				try {
					const mirrorResp: any = await this.callBitrix24Method(portalDomain, "imconnector.send.messages", {
						CONNECTOR: "social_connector",
						LINE: directLine,
						MESSAGES: [{
							user: {
								id: directUserKey,
								name: displayName,
								url: `https://instagram.com/${displayName}`,
							},
							message: {
								id: `mirror_${externalMessageId || Date.now()}`,
								date: Math.floor(Date.now() / 1000),
								text,
							},
							chat: { id: directUserKey, name: displayName, url: null },
							extra: { is_self_message: true },
						}],
					});
					this.logger.info(
						`mirror-to-direct: создана зеркальная Direct open-line ` +
						`(client=${clientId}, line=${directLine})`,
					);
					// Auto-transfer Direct-сессии на оператора, написавшего «!» —
					// чтобы диалог попадал сразу в его активную ленту, минуя очередь
					// «Неотвеченные». Аналог #47 widget MAX, но через operator.transfer
					// с TRANSFER_ID (а не operator.answer через user-auth — у нас в
					// outgoing-flow authId недоступен, есть только app-OAuth+operatorId
					// из webhook). Verified 25.05: app-OAuth operator.transfer работает.
					const mirrorChatId = Number(
						mirrorResp?.DATA?.RESULT?.[0]?.session?.CHAT_ID ||
						mirrorResp?.result?.DATA?.RESULT?.[0]?.session?.CHAT_ID || 0,
					);
					if (mirrorChatId && operatorId) {
						try {
							await this.callBitrix24Method(portalDomain, "imopenlines.operator.transfer", {
								CHAT_ID: mirrorChatId, TRANSFER_ID: operatorId, MODE: "USER",
							});
							this.logger.info(
								`mirror-to-direct: chat ${mirrorChatId} → operator ${operatorId} via operator.transfer`,
							);
						} catch (e: any) {
							this.logger.warn(`mirror-to-direct: operator.transfer failed: ${e.message}`);
						}
					}
					// Дозаполняем свежесозданный Direct-лид:
					//   - CONTACT_ID + UF_CRM_IG_CHAT_ID + UF_CRM_IG_USERNAME — чтобы лид не висел «оторванным»;
					//   - UF_CRM_LEAD_ID = открытый comment-лид клиента — чтобы оператор мог прыгнуть из Direct в Comment одним кликом.
					// Async, не блокируем основной flow.
					void this._backfillDirectMirrorLead(
						portalDomain, String(clientId), displayName, directLine,
					).catch((e: any) => this.logger.warn(`backfillDirectMirror failed for ${clientId}: ${e.message}`));
				} catch (e: any) {
					this.logger.warn(`mirror-to-direct failed for client=${clientId}: ${e.message}`);
				}
			}
		}

		return {
			success: true,
			message: "Sent to i2crm",
			data: { i2crmResponse: lastResult, externalMessageId, externalChatId: clientId },
		};
	}

	/**
	 * POST i2crm /target/feedback в формате multipart/form-data с файлом-фото.
	 * Тело собираем вручную. ВАЖНО: part `photo` — СЫРЫЕ БАЙТЫ файла. В API
	 * Blueprint i2crm показан `Content-Transfer-Encoding: base64`, но их парсер
	 * base64 не декодирует (проверено 2026-05-21: при base64 отвечает «Файл не
	 * является изображением»). Шлём обычный бинарный multipart-part.
	 * Возвращает axios-response.
	 */
	private async _postI2crmFeedbackMultipart(
		apiBase: string,
		targetKey: string,
		fields: Record<string, string>,
		photo: { buffer: Buffer; filename: string; mime: string },
	): Promise<any> {
		const boundary =
			"----i2crmBoundary" + Date.now().toString(16) + Math.random().toString(16).slice(2);
		const CRLF = "\r\n";
		const chunks: Buffer[] = [];
		for (const [name, value] of Object.entries(fields)) {
			chunks.push(
				Buffer.from(
					`--${boundary}${CRLF}` +
						`Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}` +
						`${value}${CRLF}`,
				),
			);
		}
		chunks.push(
			Buffer.from(
				`--${boundary}${CRLF}` +
					`Content-Disposition: form-data; name="photo"; filename="${photo.filename}"${CRLF}` +
					`Content-Type: ${photo.mime}${CRLF}${CRLF}`,
			),
		);
		chunks.push(photo.buffer); // сырые байты файла
		chunks.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`));
		return axios.post(`${apiBase}/target/feedback`, Buffer.concat(chunks), {
			params: { key: targetKey },
			// 60s — i2crm с фото ещё медленнее, чем без (upload + Meta API).
			// Раньше было 30s, иногда не хватало.
			timeout: 60000,
			headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
			maxBodyLength: Infinity,
			maxContentLength: Infinity,
			// i2crm возвращает 200 с error в теле даже для бизнес-ошибок.
			validateStatus: () => true,
		});
	}

	// Outgoing B24 → Telegram-бот: оператор пишет в чате открытой линии
	// инстанса (begovoy / support / …) → отправляем клиенту через нужный бот.
	// Эхо нет: Telegram Bot API не шлёт webhook о сообщениях самого бота,
	// поэтому отдельной защиты от self-message (как у Green API) не нужно.
	async handleTelegramBotOutgoing(webhook: Bitrix24WebhookDto): Promise<WebhookProcessResult> {
		const messages = webhook.data?.MESSAGES;
		if (!messages || messages.length === 0) {
			return { success: false, message: "no MESSAGES in webhook" };
		}
		const m = messages[0];

		// chat.id формат: <prefix><chatId>. Префикс определяет инстанс бота:
		// tgbot_ → begovoy, tgsupport_ → support.
		const rawChatId = String(m.chat?.id || "");
		const matched = rawChatId.match(/^(tgbot|tgsupport)_(-?\d+)$/);
		const prefix = matched ? matched[1] + "_" : "";
		const chatId = matched ? matched[2] : rawChatId.replace(/[^\d-]/g, "");
		if (!chatId) {
			return { success: false, message: `cannot parse chatId from chat.id=${rawChatId}` };
		}

		// Определяем инстанс: сначала по lineNumber (надёжнее), fallback по префиксу.
		const lineNumber = webhook.data?.LINE ? parseInt(webhook.data.LINE) : 0;
		const cfgByLine = this.getTgBotConfigByLine(lineNumber);
		const cfgByPrefix = prefix === "tgsupport_"
			? this.getTgBotConfig("support")
			: this.getTgBotConfig("begovoy");
		const cfg = cfgByLine || cfgByPrefix;
		if (!cfg) {
			return { success: false, message: `tg-bot: cannot resolve config (line=${lineNumber}, prefix=${prefix})` };
		}

		// B24 хранит эмодзи шорткодами (:trophy:, :muscle:) — конвертируем в
		// Unicode, иначе клиент в Telegram увидит сырой ":trophy:". Неизвестные
		// шорткоды emojify оставляет как есть.
		const text = emoji.emojify(m.message?.text || "");
		const files: any[] = (m.message as any)?.files || [];

		const token = cfg.token;
		if (!token) {
			return { success: false, message: `tg-bot[${cfg.name}]: token not configured` };
		}

		// B24 отдаёт файл двумя ссылками: link (auth-only) и downloadLink
		// (публичный ?FILE_ID=…&SIGN=…). Скачиваем downloadLink и грузим в Telegram.
		const fileUrl = (f: any) => String(f?.downloadLink || f?.link || f?.url || "").trim();
		const sendableFiles = files.filter((f) => fileUrl(f).length > 0);

		if (sendableFiles.length === 0 && !text) {
			return { success: false, message: "nothing to send (no text, no files)" };
		}

		// Короткий текст (≤1024) с файлом уходит подписью к первому файлу;
		// длинный или без файлов — отдельным сообщением (текст не теряется).
		const captionWithFile = sendableFiles.length > 0 && !!text && text.length <= 1024;
		let externalMessageId: any = null;

		for (let i = 0; i < sendableFiles.length; i++) {
			const f = sendableFiles[i];
			try {
				const dl = await axios.get(fileUrl(f), {
					responseType: "arraybuffer", timeout: 30000, maxContentLength: Infinity,
				});
				const buffer = Buffer.from(dl.data);
				const filename = String(f?.name || "file").replace(/[^\w.\-]/g, "_");
				const caption = i === 0 && captionWithFile ? text : undefined;
				const r = await this.sendTelegramMedia(token, chatId, buffer, filename, caption);
				if (!r.ok) {
					this.logger.error(`tg-bot outgoing media rejected: ${r.error}`);
					return { success: false, message: `Telegram: ${r.error}` };
				}
				externalMessageId = r.messageId || externalMessageId;
			} catch (err: any) {
				this.logger.error(`tg-bot outgoing media error: ${err.message}`);
				return { success: false, message: `Telegram media transport: ${err.message}` };
			}
		}

		// Текст: отдельным сообщением, если он не ушёл подписью к файлу.
		// Лимит Telegram sendMessage 4096 символов — длинный текст шлём частями.
		if (text && !captionWithFile) {
			const TG_TEXT_LIMIT = 4096;
			for (let i = 0; i < text.length; i += TG_TEXT_LIMIT) {
				const part = text.slice(i, i + TG_TEXT_LIMIT);
				try {
					const resp: any = await axios.post(
						`https://api.telegram.org/bot${token}/sendMessage`,
						{ chat_id: chatId, text: part },
						{ timeout: 15000, validateStatus: () => true },
					);
					if (resp.data?.ok !== true) {
						const desc = resp.data?.description || `HTTP ${resp.status}`;
						this.logger.error(`tg-bot outgoing rejected by Telegram: ${desc}`);
						return { success: false, message: `Telegram: ${desc}` };
					}
					externalMessageId = resp.data?.result?.message_id || externalMessageId;
				} catch (err: any) {
					this.logger.error(`tg-bot outgoing transport error: ${err.message}`);
					return { success: false, message: `Telegram transport: ${err.message}` };
				}
			}
		}
		this.logger.info(`tg-bot outgoing OK chat=${chatId} msg=${externalMessageId} files=${sendableFiles.length}`);

		// Журнал исходящего — outgoing-записи update_id не имеют, ставим
		// синтетический ключ, чтобы не конфликтовать с incoming по @@unique.
		try {
			await (this.prisma as any).tgBotEventLog.create({
				data: {
					updateId: `out_${Date.now()}_${externalMessageId || "0"}`,
					chatId, messageId: String(externalMessageId || ""),
					direction: "out", payload: JSON.stringify({ chat_id: chatId, text }),
					status: "sent", sentAt: new Date(),
				},
			});
		} catch (e: any) {
			this.logger.warn(`tg-bot: outgoing TgBotEventLog create failed: ${e.message}`);
		}

		// Зеркало ответа оператора в топик клиента — в группу инстанса.
		this.tgBotMirror.mirrorOutgoing({
			chatId, text,
			mirrorGroupId: cfg.mirrorGroupId || undefined,
		}).catch((e) => this.logger.warn(`tg-bot[${cfg.name}]: mirror outgoing failed (non-fatal): ${e.message}`));

		return {
			success: true,
			message: "Sent to Telegram",
			data: { externalMessageId, externalChatId: chatId },
		};
	}

	async handleBitrix24Webhook(webhook: Bitrix24WebhookDto): Promise<WebhookProcessResult> {
		this.logger.info(`Handling Bitrix24 webhook: ${webhook.event}`);

		if (webhook.event?.toUpperCase() === "ONIMCONNECTORMESSAGEADD") {
			this.logger.info("Processing outbound message from Bitrix24", {
				event: webhook.event,
				fields: webhook.data?.FIELDS,
			});

			const domain = webhook.auth.domain;
			const lineNumber = webhook.data?.LINE ? parseInt(webhook.data.LINE) : 0;
			const connector = String((webhook.data as any)?.CONNECTOR || "").toLowerCase();

			// Branch: Instagram через i2crm. CONNECTOR=i2crm выставляется B24
			// для линий 18/22 (CRM_SOURCE="18|I2CRM"/"22|I2CRM"). Если CONNECTOR
			// отсутствует в webhook (старые версии B24), проверяем по LINE.
			const lineDirect = Number(this.configService.get<string>("I2CRM_LINE_ID_IG_DIRECT"));
			const lineComment = Number(this.configService.get<string>("I2CRM_LINE_ID_IG_COMMENT"));
			if (connector === "i2crm" || connector === "social_connector" && (lineNumber === lineDirect || lineNumber === lineComment) || lineNumber === lineDirect || lineNumber === lineComment) {
				this.logger.info(`Routing outbound to i2crm pipeline (line=${lineNumber}, connector=${connector})`);
				const result = await this.handleI2crmOutgoing(webhook, lineNumber);
				if (result.success) {
					await this.sendDeliveryConfirmation(
						webhook,
						domain,
						lineNumber,
						{
							idMessage: (result.data as any)?.externalMessageId || `i2crm_${Date.now()}`,
						} as SendResponse,
						"social_connector",
					);
				}
				return result;
			}

			// Branch: Telegram-бот (любой инстанс — @begovoy_bot или @begovoy1support_bot)
			// подключён через наш коннектор, а не Green API. Линии берём из конфигов
			// бот-инстансов; если совпала любая — роутим в общий handleTelegramBotOutgoing.
			const tgCfg = this.getTgBotConfigByLine(lineNumber);
			if (tgCfg) {
				this.logger.info(`Routing outbound to Telegram-bot pipeline (line=${lineNumber}, bot=${tgCfg.name})`);
				const result = await this.handleTelegramBotOutgoing(webhook);
				if (result.success) {
					await this.sendDeliveryConfirmation(
						webhook,
						domain,
						lineNumber,
						{
							idMessage: (result.data as any)?.externalMessageId || `tgbot_${Date.now()}`,
						} as SendResponse,
						"social_connector",
					);
				}
				return result;
			}

			const instances = await this.prisma.getInstancesByUserId(domain);

			if (instances.length === 0) {
				this.logger.warn(`No GREEN-API instances found for portal ${domain}`);
				return {success: false, message: "No GREEN-API instances configured"};
			}

			let targetInstance = instances.find(inst => inst.bitrixLine === lineNumber);

			if (!targetInstance) {
				targetInstance = instances[0];
				this.logger.warn(`No instance found for line ${lineNumber}, using default instance ${targetInstance.idInstance}`);
			}

			try {
				const result = await this.handlePlatformWebhook(webhook, targetInstance.idInstance);

				this.logger.info(`Outbound message sent successfully`, {
					instanceId: targetInstance.idInstance,
					domain: domain,
					line: lineNumber,
				});

				await this.sendDeliveryConfirmation(webhook, domain, lineNumber, result as SendResponse);

				// Hint в wa-tg-bridge с именем оператора B24 — чтобы в TG-зеркале
				// outgoing-сообщения помечались "🧑‍💼 ФИО (B24): …" вместо
				// безликого "отправлено с мобильного". Best-effort, не валим успех
				// при ошибке.
				const senderUserId = String(
					(webhook.data?.MESSAGES?.[0] as any)?.message?.user_id || "",
				);
				const externalId = (result as SendResponse)?.idMessage;
				if (senderUserId && externalId) {
					this.sendOperatorHintToBridge(domain, senderUserId, externalId).catch((e: any) => {
						this.logger.warn(`operator-hint to bridge failed (non-fatal): ${e.message}`);
					});
				}

				return {
					success: true,
					message: "Message sent successfully",
					data: result,
				};

			} catch (error: any) {
				this.logger.error(`Failed to send outbound message: ${error.message}`, {
					instanceId: targetInstance.idInstance,
					domain: domain,
					line: lineNumber,
					error: error.stack,
				});

				return {
					success: false,
					message: `Failed to send message: ${error.message}`,
				};
			}
		}

		this.logger.debug(`Ignoring non-message event: ${webhook.event}`);
		return {success: true, message: "Event processed"};
	}

	private async sendDeliveryConfirmation(
		webhook: Bitrix24WebhookDto,
		domain: string,
		line: number,
		greenApiResult: SendResponse,
		connectorId: string = "social_connector",
	): Promise<void> {
		try {
			if (!webhook.data?.MESSAGES || webhook.data.MESSAGES.length === 0) {
				this.logger.warn("No MESSAGES in webhook for delivery confirmation");
				return;
			}

			const originalMessage = webhook.data.MESSAGES[0];

			const externalMessageId = greenApiResult.idMessage;
			const externalChatId = originalMessage.chat?.id || "unknown";

			// B24 ждёт id строкой — для i2crm IG прилетает числовой external_id
			// (result.data.id от i2crm = 619666523). При числовом id B24 в UI
			// показывает «сообщение не доставлено», хотя delivery confirmation
			// ушёл успешно. WA шлёт hex-строку — там всё ОК. (Инцидент 25.05.)
			const externalMessageIdStr = String(externalMessageId);

			await this.callBitrix24Method(domain, "imconnector.send.status.delivery", {
				CONNECTOR: connectorId,
				LINE: line,
				MESSAGES: [{
					im: originalMessage.im,
					message: {
						id: [externalMessageIdStr],
						status: "delivered",
					},
					chat: {
						id: externalChatId,
					},
				}],
			});

			this.logger.info("Delivery confirmation sent to Bitrix24", {
				domain,
				line,
				externalMessageId,
				externalChatId,
			});

			// Сохраняем mapping в БД для проксирования статусов sent/read когда
			// Green API уведомит позже через outgoingMessageStatus webhook.
			// Persistent — переживает рестарт adapter'а.
			if (externalMessageId && originalMessage.im?.chat_id && originalMessage.im?.message_id) {
				try {
					await (this.prisma as any).outgoingMessage.upsert({
						where: { idMessage: String(externalMessageId) },
						create: {
							idMessage: String(externalMessageId),
							b24ChatId: String(originalMessage.im.chat_id),
							b24MessageId: String(originalMessage.im.message_id),
							externalChatId,
							line,
							connector: connectorId,
							expiresAt: new Date(Date.now() + OUTGOING_MAP_TTL_MS),
						},
						update: {
							b24ChatId: String(originalMessage.im.chat_id),
							b24MessageId: String(originalMessage.im.message_id),
							externalChatId,
							line,
							connector: connectorId,
							expiresAt: new Date(Date.now() + OUTGOING_MAP_TTL_MS),
						},
					});
				} catch (e: any) {
					this.logger.debug(`OutgoingMessage upsert failed for ${externalMessageId}: ${e.message}`);
				}
			}
		} catch (error: any) {
			this.logger.error(`Failed to send delivery confirmation: ${error.message}`, {
				domain,
				line,
				error: error.stack,
			});
		}
	}

	/**
	 * Обработчик outgoingMessageStatus от Green API: когда Green API уведомляет
	 * что наше outgoing-сообщение прошло через sent → delivered → read, мы
	 * проксируем статус в B24 чтобы оператор видел синие галочки.
	 *
	 * Без mapping'а (т.е. для сообщений отправленных через мобильный WA, не
	 * через adapter) — молча игнорируем (separate task).
	 */
	async handleOutgoingMessageStatus(webhook: any): Promise<void> {
		const idMessage = String(webhook?.idMessage || "");
		const status = String(webhook?.status || "").toLowerCase();
		if (!idMessage || !isValidOutgoingStatus(status)) return;

		const entry = await (this.prisma as any).outgoingMessage.findUnique({
			where: { idMessage },
		});
		if (!entry) {
			// Сообщение не отправлено через adapter (мобильный WA / устройство) —
			// нет mapping'а для проксирования статуса.
			return;
		}
		if (isOutgoingExpired(entry.expiresAt)) {
			await (this.prisma as any).outgoingMessage.delete({ where: { idMessage } }).catch(() => undefined);
			return;
		}
		// Дедуп дублирующихся webhook'ов Green API. Если этот статус (или
		// более продвинутый) уже обработан — skip. Иначе при retry'е
		// Green API мы каждый раз дёргали бы B24 imconnector.send.status.delivery,
		// забивая rate-limit и засоряя logs.
		const last = entry.lastStatusSeen ? String(entry.lastStatusSeen) : "";
		if (shouldSkipOutgoingStatus(last, status)) {
			this.logger.debug(
				`outgoingStatus dedup: idMessage=${idMessage} already at ${last}, ignoring ${status}`,
			);
			return;
		}

		const users = await (this.prisma as any).user.findMany({ take: 1 });
		const portalDomain = users[0]?.portalDomain;
		if (!portalDomain) return;

		try {
			await this.callBitrix24Method(portalDomain, "imconnector.send.status.delivery", {
				CONNECTOR: entry.connector,
				LINE: entry.line,
				MESSAGES: [{
					im: { chat_id: entry.b24ChatId, message_id: entry.b24MessageId },
					message: { id: [idMessage], status },
					chat: { id: entry.externalChatId },
				}],
			});
			this.logger.debug(
				`Forwarded outgoing status ${status} for idMessage=${idMessage} → B24 chat_id=${entry.b24ChatId}`,
			);
			// Customer-360: emit delivery_status в customer_events для
			// /customer-360/outgoing-pending ленты. source/channel выводим
			// из connector_id (wa/max/tg/ig).
			const sc = this._sourceFromConnector(entry.connector);
			void this._emitMessageDeliveryEvent({
				idMessage,
				status: status as "sent" | "delivered" | "read",
				source: sc.source,
				channel: sc.channel,
				connector: entry.connector,
				b24ChatId: entry.b24ChatId,
			});
			// Когда дошло до read — удаляем (дальше Green API не шлёт).
			if (status === "read") {
				await (this.prisma as any).outgoingMessage.delete({ where: { idMessage } }).catch(() => undefined);
			} else {
				// Фиксируем последний обработанный статус для дедупа.
				await (this.prisma as any).outgoingMessage.update({
					where: { idMessage },
					data: { lastStatusSeen: status },
				}).catch(() => undefined);
			}
		} catch (e: any) {
			this.logger.warn(`Forward outgoing status ${status} for ${idMessage} failed: ${e.message}`);
		}
	}

	/**
	 * Cleanup expired OutgoingMessage записей. Запускается раз в час
	 * фоновой задачей (см. AppController.scheduleOutgoingCleanup или
	 * cron-вызов /internal/cleanup-outgoing).
	 */
	async cleanupExpiredOutgoingMessages(): Promise<number> {
		try {
			const result = await (this.prisma as any).outgoingMessage.deleteMany({
				where: { expiresAt: { lt: new Date() } },
			});
			if (result.count > 0) {
				this.logger.info(`Cleaned up ${result.count} expired OutgoingMessage rows`);
			}
			return result.count;
		} catch (e: any) {
			this.logger.warn(`OutgoingMessage cleanup failed: ${e.message}`);
			return 0;
		}
	}

	/**
	 * Найти UF_CRM_IG_USERNAME клиента в B24 по IG client_id. Сначала ищет
	 * среди лидов (там username чаще backfill'ится), потом среди контактов.
	 * Используется backfill'ом IG-pinned-карточек (нужно знать @username для
	 * ссылки https://instagram.com/<username>/).
	 */
	async findIgUsername(clientId: string): Promise<string | null> {
		const users = await (this.prisma as any).user.findMany({ take: 1 });
		const portalDomain = users[0]?.portalDomain;
		if (!portalDomain) return null;
		try {
			const leads: any = await this.callBitrix24Method(portalDomain, "crm.lead.list", {
				filter: { UF_CRM_IG_CHAT_ID: String(clientId) },
				select: ["UF_CRM_IG_USERNAME"],
				order: { DATE_CREATE: "DESC" },
			});
			if (Array.isArray(leads)) {
				for (const l of leads) {
					const u = String(l?.UF_CRM_IG_USERNAME || "").trim();
					if (u) return u.replace(/^@/, "");
				}
			}
		} catch (e: any) {
			this.logger.debug(`findIgUsername: lead.list failed for ${clientId}: ${e.message}`);
		}
		try {
			const contacts: any = await this.callBitrix24Method(portalDomain, "crm.contact.list", {
				filter: { UF_CRM_IG_CHAT_ID: String(clientId) },
				select: ["UF_CRM_IG_USERNAME"],
			});
			if (Array.isArray(contacts)) {
				for (const c of contacts) {
					const u = String(c?.UF_CRM_IG_USERNAME || "").trim();
					if (u) return u.replace(/^@/, "");
				}
			}
		} catch (e: any) {
			this.logger.debug(`findIgUsername: contact.list failed for ${clientId}: ${e.message}`);
		}
		return null;
	}

	// ----- Contact-name lookup (для wa-tg-bridge: имя темы из B24) ---
	// Кеш phone/igClientId → ФИО клиента из B24. TTL 10 мин, чтобы не дёргать
	// B24 на каждое incoming-сообщение. При обновлении ФИО в B24 — мост подтянет
	// новое имя через max 10 минут (а если был direct refresh — мгновенно).
	private contactNameCache = new Map<string, { name: string | null; expires: number; entityId?: number | null; link?: string | null; igUsername?: string | null }>();

	async getContactName(input: { phone?: string; igClientId?: string; tgChatId?: string; maxChatId?: string }): Promise<{ name: string | null; source: string | null; entityId: number | null; link: string | null; igUsername?: string | null }> {
		const phone = (input.phone || "").trim();
		const igClientId = (input.igClientId || "").trim();
		const tgChatId = (input.tgChatId || "").trim();
		const maxChatId = (input.maxChatId || "").trim();
		const empty = { name: null, source: null, entityId: null, link: null, igUsername: null };
		if (!phone && !igClientId && !tgChatId && !maxChatId) return empty;
		const key = phone
			? `phone:${phone}`
			: igClientId
				? `ig:${igClientId}`
				: tgChatId
					? `tg:${tgChatId}`
					: `max:${maxChatId}`;
		const cached: any = this.contactNameCache.get(key);
		if (cached && cached.expires > Date.now()) {
			return {
				name: cached.name, source: cached.name ? "cache" : null,
				entityId: cached.entityId || null, link: cached.link || null,
				igUsername: cached.igUsername || null,
			};
		}

		const users = await (this.prisma as any).user.findMany({ take: 1 });
		const user = users[0];
		if (!user) return empty;
		const portalDomain = user.portalDomain;

		const buildName = (rec: any): string | null => {
			if (!rec) return null;
			const parts = [rec.NAME, rec.LAST_NAME].filter((s: any) => s && String(s).trim());
			return parts.length ? parts.join(" ").trim() : null;
		};

		let name: string | null = null;
		let source: string | null = null;
		let entityId: number | null = null;
		let link: string | null = null;
		let igUsername: string | null = null;

		try {
			if (phone) {
				const dup: any = await this.callBitrix24Method(portalDomain, "crm.duplicate.findbycomm", {
					entity_type: "CONTACT",
					type: "PHONE",
					values: [phone],
				});
				const contactId = dup?.CONTACT?.[0];
				if (contactId) {
					const c: any = await this.callBitrix24Method(portalDomain, "crm.contact.get", { id: contactId });
					name = buildName(c);
					source = "contact";
					entityId = parseInt(contactId, 10);
					link = `https://${portalDomain}/crm/contact/details/${entityId}/`;
				}
				if (!name) {
					const dupL: any = await this.callBitrix24Method(portalDomain, "crm.duplicate.findbycomm", {
						entity_type: "LEAD",
						type: "PHONE",
						values: [phone],
					});
					const leadId = dupL?.LEAD?.[0];
					if (leadId) {
						const l: any = await this.callBitrix24Method(portalDomain, "crm.lead.get", { id: leadId });
						name = buildName(l);
						source = "lead";
						entityId = parseInt(leadId, 10);
						link = `https://${portalDomain}/crm/lead/details/${entityId}/`;
					}
				}
			} else if (igClientId) {
				const cList: any = await this.callBitrix24Method(portalDomain, "crm.contact.list", {
					filter: { UF_CRM_IG_CHAT_ID: igClientId },
					select: ["ID", "NAME", "LAST_NAME", "UF_CRM_IG_USERNAME"],
				});
				if (Array.isArray(cList) && cList.length > 0) {
					name = buildName(cList[0]);
					source = "contact";
					entityId = parseInt(cList[0].ID, 10);
					link = `https://${portalDomain}/crm/contact/details/${entityId}/`;
					igUsername = String(cList[0]?.UF_CRM_IG_USERNAME || "").trim().replace(/^@/, "") || null;
				}
				if (!name || !igUsername) {
					const lList: any = await this.callBitrix24Method(portalDomain, "crm.lead.list", {
						filter: { UF_CRM_IG_CHAT_ID: igClientId },
						select: ["ID", "NAME", "LAST_NAME", "UF_CRM_IG_USERNAME"],
					});
					if (Array.isArray(lList) && lList.length > 0) {
						if (!name) {
							name = buildName(lList[0]);
							source = "lead";
							entityId = parseInt(lList[0].ID, 10);
							link = `https://${portalDomain}/crm/lead/details/${entityId}/`;
						}
						if (!igUsername) {
							for (const l of lList) {
								const u = String(l?.UF_CRM_IG_USERNAME || "").trim().replace(/^@/, "");
								if (u) { igUsername = u; break; }
							}
						}
					}
				}
			}
			// Telegram/MAX: client id не телефон — ищем по UF_CRM_TG/MAX_CHAT_ID.
			if (!name && (tgChatId || maxChatId)) {
				const chatIdUf = maxChatId ? "UF_CRM_MAX_CHAT_ID" : "UF_CRM_TG_CHAT_ID";
				const chatIdValue = maxChatId || tgChatId;
				const cList: any = await this.callBitrix24Method(portalDomain, "crm.contact.list", {
					filter: { [chatIdUf]: chatIdValue },
					select: ["ID", "NAME", "LAST_NAME"],
				});
				if (Array.isArray(cList) && cList.length > 0) {
					name = buildName(cList[0]);
					source = "contact";
					entityId = parseInt(cList[0].ID, 10);
					link = `https://${portalDomain}/crm/contact/details/${entityId}/`;
				}
				if (!name) {
					const lList: any = await this.callBitrix24Method(portalDomain, "crm.lead.list", {
						filter: { [chatIdUf]: chatIdValue },
						select: ["ID", "NAME", "LAST_NAME"],
					});
					if (Array.isArray(lList) && lList.length > 0) {
						name = buildName(lList[0]);
						source = "lead";
						entityId = parseInt(lList[0].ID, 10);
						link = `https://${portalDomain}/crm/lead/details/${entityId}/`;
					}
				}
			}
		} catch (e: any) {
			this.logger.warn(`getContactName failed for ${key}: ${e.message}`);
		}

		this.contactNameCache.set(key, { name, expires: Date.now() + 600_000, entityId, link, igUsername } as any);
		if (this.contactNameCache.size > 1000) {
			const now = Date.now();
			for (const [k, v] of this.contactNameCache) {
				if (v.expires < now) this.contactNameCache.delete(k);
			}
		}
		return { name, source, entityId, link, igUsername };
	}

	// ----- Operator name cache + hint forwarding ----------------------
	// Cache: B24 user_id → "Имя Фамилия". TTL 1 час (имена сотрудников редко
	// меняются, но при увольнении/добавлении хотим подхватить).
	private operatorNameCache = new Map<string, { name: string; expires: number }>();

	private async getOperatorName(domain: string, userId: string): Promise<string | null> {
		if (!userId) return null;
		const now = Date.now();
		const cached = this.operatorNameCache.get(userId);
		if (cached && cached.expires > now) {
			return cached.name;
		}
		try {
			const resp: any = await this.callBitrix24Method(domain, "user.get", { ID: userId });
			// callBitrix24Method уже возвращает response.data.result — не оборачивай ещё раз.
			// Был баг: проверяли resp.result (внутри уже-result'а), всегда null → hint
			// до wa-tg-bridge не доходил, в TG-зеркале висел fallback «отправлено с мобильного».
			const u = Array.isArray(resp) ? resp[0] : null;
			if (!u) return null;
			const name = [u.NAME, u.LAST_NAME].filter(Boolean).join(" ").trim()
				|| u.WORK_POSITION
				|| u.EMAIL
				|| `B24#${userId}`;
			this.operatorNameCache.set(userId, { name, expires: now + 3600_000 });
			// Бесконтрольно расти не даём — самая простая защита.
			if (this.operatorNameCache.size > 500) {
				const t = now;
				for (const [k, v] of this.operatorNameCache) {
					if (v.expires < t) this.operatorNameCache.delete(k);
				}
			}
			return name;
		} catch (e: any) {
			this.logger.warn(`user.get failed for B24 user ${userId}: ${e.message}`);
			return null;
		}
	}

	private async sendOperatorHintToBridge(
		domain: string, b24UserId: string, idMessage: string,
		source: "B24" | "mobile" = "B24",
	): Promise<void> {
		const bridgeUrl = this.configService.get<string>("BRIDGE_HINT_URL");
		if (!bridgeUrl) return; // фича отключена если переменная не задана
		const secret = this.configService.get<string>("BRIDGE_HINT_SECRET") || "";
		const name = await this.getOperatorName(domain, b24UserId);
		if (!name) return;
		await axios.post(bridgeUrl, { idMessage, operatorName: name, source }, {
			timeout: 3000,
			headers: secret ? { "X-Hint-Secret": secret } : undefined,
		});
		this.logger.debug(`operator-hint sent to bridge: ${idMessage} → ${name} [${source}]`);
	}

	/** Находит оператора, который «взял» открытую B24-сессию клиента (по phone).
	 *  Используется для outgoing-from-mobile: Green API не передаёт автора
	 *  ручного сообщения с мобильного клиента — берём его из текущей сессии. */
	private async resolveActiveOperatorByPhone(
		domain: string, phone: string,
	): Promise<string | null> {
		try {
			const dup: any = await this.callBitrix24Method(domain, "crm.duplicate.findbycomm", {
				type: "PHONE", values: [phone], entity_type: "CONTACT",
			});
			const contactId = Number(dup?.CONTACT?.[0]);
			if (!contactId) return null;
			// Открытые сессии открытой линии на этом контакте, сортируем по
			// последней. PROVIDER_PARAMS.USER_CODE имеет вид
			// `<connector>|<line>|<chat>|<operator_id>` — если оператор взял.
			const acts: any = await this.callBitrix24Method(domain, "crm.activity.list", {
				filter: {
					PROVIDER_ID: "IMOPENLINES_SESSION",
					OWNER_TYPE_ID: 3, OWNER_ID: contactId, // CONTACT
					COMPLETED: "N",
				},
				select: ["ID", "RESPONSIBLE_ID", "PROVIDER_PARAMS"],
				order: { ID: "DESC" },
			});
			const list = Array.isArray(acts) ? acts : [];
			for (const a of list) {
				const code = String(a?.PROVIDER_PARAMS?.USER_CODE || "");
				const parts = code.split("|");
				const opIdFromCode = parts.length >= 4 ? parts[parts.length - 1] : "";
				const operatorId = /^\d+$/.test(opIdFromCode) ? opIdFromCode : String(a?.RESPONSIBLE_ID || "");
				if (operatorId && operatorId !== "0") return operatorId;
			}
			return null;
		} catch (e: any) {
			this.logger.debug(`resolveActiveOperatorByPhone failed: ${e.message}`);
			return null;
		}
	}
}