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
	GreenApiLogger, SendResponse, generateRandomToken,
} from "@green-api/greenapi-integration";
import { Bitrix24Transformer } from "./bitrix24.transformer";
import { I2crmTgMirrorService } from "./i2crm-tg-mirror.service";
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

export interface EnsureLeadResult {
	contactId?: number;
	contactName?: string;
	contactLastName?: string;
	createdLeadId?: number;
}

// TTL для записи OutgoingMessage: Green API после доставки не шлёт более
// чем 24 часа.
const OUTGOING_MAP_TTL_MS = 24 * 3600 * 1000;

// Per-portal mutex для token refresh — без него два concurrent 401-ответа
// (например, две параллельные imconnector.send.messages на один портал)
// оба запустили бы refreshAccessToken, перезатёрли друг друга в БД и
// пошли retry'ить с разными токенами. См. agent-аудит 2026-05-19.
type RefreshKey = string;  // portalDomain или portalDomain:appKind
const _refreshLocks: Map<RefreshKey, Promise<string>> = new Map();

@Injectable()
export class Bitrix24Service extends BaseAdapter<
	Bitrix24WebhookDto,
	Bitrix24PlatformMessage,
	User,
	Instance
> {
	private readonly logger = GreenApiLogger.getInstance(Bitrix24Service.name);
	private _outgoingCleanupInterval: NodeJS.Timeout | null = null;

	constructor(
		protected readonly bitrix24Transformer: Bitrix24Transformer,
		protected readonly prisma: PrismaService,
		private readonly configService: ConfigService,
		private readonly i2crmTgMirror: I2crmTgMirrorService,
	) {
		super(bitrix24Transformer, prisma);
		// Cleanup expired OutgoingMessage записей раз в час. Делаем через
		// setInterval а не cron, чтобы не вводить новую инфру. Первый запуск
		// через 5 минут после старта (даём миграциям прокатиться).
		this._outgoingCleanupInterval = setInterval(
			() => { void this.cleanupExpiredOutgoingMessages(); },
			60 * 60 * 1000,
		);
		setTimeout(() => { void this.cleanupExpiredOutgoingMessages(); }, 5 * 60 * 1000);
	}

	onModuleDestroy() {
		if (this._outgoingCleanupInterval) {
			clearInterval(this._outgoingCleanupInterval);
			this._outgoingCleanupInterval = null;
		}
	}

	private async refreshAccessToken(user: User): Promise<string> {
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
				if (fresh && fresh.tokenExpiresAt && new Date(fresh.tokenExpiresAt).getTime() > Date.now() + 30_000) {
					this.logger.info(`Token already fresh for ${user.portalDomain} (TTL>30s), skip refresh`);
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
	): Promise<EnsureLeadResult> {
		const lockKey = `${portalDomain}:${phoneE164}:${chatId || ""}`;
		const existing = this._ensureLeadLocks.get(lockKey);
		if (existing) return existing;
		const task: Promise<EnsureLeadResult> = (async (): Promise<EnsureLeadResult> => {
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
						this.logger.info(`ensureLead: contact ${contactId} found via ${chatIdUf}=${chatId}`);
					}
				}
				if (!contactId) {
					this.logger.info(`ensureLead: no existing contact for ${phoneE164}/${chatId || "-"}, leaving creation to B24`);
					return {};
				}
				// Если нашли контакт И есть chatId — сохраняем chatId в UF контакта
				// (только если поле сейчас пустое). Это даст матч по chatId для
				// будущих сообщений когда phone недоступен. Заодно читаем имя
				// для возврата вызывающему (widget использует его как displayName
				// в imconnector и для backfill созданного лида).
				let contactName: string | undefined;
				let contactLastName: string | undefined;
				try {
					const contactData: any = await this.callBitrix24Method(portalDomain, "crm.contact.get", { id: contactId });
					contactName = (contactData?.NAME || "").toString().trim() || undefined;
					contactLastName = (contactData?.LAST_NAME || "").toString().trim() || undefined;
					if (chatId && chatIdUf) {
						const existingValue = contactData?.[chatIdUf];
						if (!existingValue) {
							await this.callBitrix24Method(portalDomain, "crm.contact.update", {
								id: contactId,
								fields: { [chatIdUf]: chatId },
							});
							this.logger.info(`ensureLead: saved ${chatIdUf}=${chatId} on contact ${contactId}`);
						}
					}
				} catch (e: any) {
					this.logger.warn(`ensureLead: failed to read/save contact ${contactId}: ${e.message}`);
				}

				const baseResult: EnsureLeadResult = { contactId, contactName, contactLastName };

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
					select: ["ID"],
				});
				if (Array.isArray(openLeads) && openLeads.length > 0) {
					this.logger.info(`ensureLead: contact ${contactId} has ${openLeads.length} open lead(s) — no action`);
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
					// Yandex Metrika ClientId: с сайта заполняется через NetForm
					// (заявка/звонок), у лидов из мессенджеров его нет. B24 требует
					// поле при смене стадии — ставим "-" чтобы не блокировать оператора.
					UF_CRM_NF_YM_CLIENT_ID: "-",
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

		// Резолвим customer
		const phone = this._pickFirstPhone(snap);
		const email = this._pickFirstEmail(snap);
		let resolveAlias: { type: string; value: string } | null = null;
		if (phone) resolveAlias = { type: "phone", value: phone };
		else if (email) resolveAlias = { type: "email", value: email };
		else resolveAlias = { type: entity === "lead" ? "b24_lead" : entity === "contact" ? "b24_contact" : "b24_deal", value: String(entityId) };

		// Если UF_CRM_PB_CUSTOMER_UUID уже стоит — используем напрямую
		const customerUuid: string | undefined = snap.UF_CRM_PB_CUSTOMER_UUID || undefined;

		// Summary
		const title = snap.TITLE || `${snap.NAME || ""} ${snap.LAST_NAME || ""}`.trim() || `#${entityId}`;
		let summary = `${entity} ${action}: ${title}`;
		if (entity !== "contact" && snap.STATUS_ID) summary += ` [STATUS=${snap.STATUS_ID}]`;
		if (entity === "deal" && snap.STAGE_ID) summary += ` [STAGE=${snap.STAGE_ID}]`;

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

		// Customer-360 event ingest (best-effort, не блокируем)
		try {
			await this._eventsIngest({
				resolveAlias: { type: "phone", value: phone },
				source: "bridge_wa",
				eventType: "message_out",
				channel: "WA",
				summary: text.slice(0, 300),
				payload: {
					idMessage: webhook?.idMessage,
					mtype,
					sender_by_mobile: true,
					chatId: clientChatId,
				},
			});
		} catch (e: any) {
			this.logger.debug(`outgoing-from-mobile event ingest failed: ${e.message}`);
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
	 * crm.timeline.comment.add в указанную сделку/лид. Возвращает id комментария
	 * или null при ошибке (логируется warn). Используется в widget /send для
	 * фиксации исходящего сообщения в открытой сущности клиента вместо создания
	 * imconnector-сессии (см. findOpenCrmEntityForContact).
	 */
	async addTimelineComment(
		portalDomain: string,
		entityType: "deal" | "lead",
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
			contactId: number;
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
				if (!target.CONTACT_ID || Number(target.CONTACT_ID) === 0) {
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
				if (phoneE164 || chatIdForUf) {
					await this.ensureOpenLeadForPhone(
						instance.user.portalDomain,
						phoneE164 || "",
						message.senderName || `${channelLabel} ${message.phone}`,
						line,
						channelLabel,
						chatIdForUf,
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
				messagePayload.message.files = message.attachments.map(attachment => ({
					url: attachment.url,
					name: attachment.fileName || "attachment",
				}));

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

	// Incoming Instagram-сообщение от i2crm Public API.
	// Линии 18 (Direct) и 22 (Comment) уже зарегистрированы за CONNECTOR=i2crm
	// в B24 (CRM_SOURCE="18|I2CRM"/"22|I2CRM"). Отправляем через imconnector.send.messages
	// напрямую, минуя Green API pipeline (i2crm — не Green API инстанс).
	async handleI2crmIncoming(payload: any): Promise<{ success: boolean; reason?: string }> {
		// Эхо: outgoing от оператора возвращается нам обратно — игнорируем.
		if (payload?.incoming === false) {
			return { success: true, reason: "outgoing-echo-ignored" };
		}

		const channel = String(payload?.channel || "");
		const clientId = payload?.client_id;
		const messageId = payload?.message_id;
		const text = payload?.text || "";
		const type = String(payload?.type || "text");
		const username = payload?.client_username || "";
		const clientName = payload?.client_name || username || `IG_${clientId}`;
		const phone = payload?.phone_number || "";
		const externalId = payload?.external_id || "";
		const datetime = payload?.datetime;

		if (!clientId || !messageId) {
			return { success: false, reason: "missing client_id or message_id" };
		}
		if (channel !== "instdir" && channel !== "instcom") {
			return { success: false, reason: `unsupported channel: ${channel}` };
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
		const lineEnv = channel === "instdir" ? "I2CRM_LINE_ID_IG_DIRECT" : "I2CRM_LINE_ID_IG_COMMENT";
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
		const phoneE164 = phone && /^\+?\d{10,15}$/.test(String(phone))
			? (String(phone).startsWith("+") ? String(phone) : `+${phone}`)
			: "";
		try {
			await this.ensureOpenLeadForPhone(
				portalDomain,
				phoneE164,
				clientName,
				lineId,
				channelLabel,
				String(clientId),
			);
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
		const finalText = isComment
			? `[Instagram комментарий${igPostUrl ? " к посту " + igPostUrl : ""}]\n${text}`
			: text;

		const userKey = `i2crm_ig_${clientId}`;
		const ts = datetime ? Math.floor(new Date(datetime).getTime() / 1000) : Math.floor(Date.now() / 1000);

		const messagePayload: any = {
			user: {
				id: userKey,
				name: clientName,
				url: username ? `https://instagram.com/${username}` : undefined,
			},
			message: {
				id: String(messageId),
				date: ts,
				text: finalText,
			},
			chat: {
				id: userKey,
				name: clientName,
				// B24 рендерит chat.url как «Ссылка на исходный пост: <url>» в чате
				// открытой линии. Для IG-comment — URL поста (igPostUrl), для IG-direct —
				// URL профиля клиента. Раньше для обоих был профиль — для коммента это
				// было неправильно (теряли контекст какой пост обсуждается).
				url: isComment && igPostUrl
					? igPostUrl
					: username ? `https://instagram.com/${username}` : undefined,
			},
			extra: { crm: "Y" },
		};

		// Аттачи (если type=image/video/audio/file)
		if (type !== "text" && (payload?.media_url || payload?.media)) {
			const mediaUrl = payload.media_url || payload.media?.url;
			if (mediaUrl) {
				messagePayload.message.files = [
					{
						url: mediaUrl,
						name: payload.media?.file_name || `${type}.bin`,
					},
				];
			}
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
			const r0 = response?.DATA?.RESULT?.[0];
			if (r0?.session) {
				sessionInfo.sessionId = String(r0.session.ID || "");
				sessionInfo.chatId = String(r0.session.CHAT_ID || "");
			}
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

		// Сохраняем последний media+comment-id для outgoing /target/feedback type=comment.
		// После переключения i2crm на «официальный» способ подключения эти поля стали
		// обязательными (раньше i2crm сопоставлял по client_id сам).
		if (isComment && payload?.media_id && payload?.comment_id) {
			(this.prisma as any).igCommentContext.upsert({
				where: { clientId: String(clientId) },
				create: {
					clientId: String(clientId),
					mediaId: String(payload.media_id),
					commentId: String(payload.comment_id),
				},
				update: {
					mediaId: String(payload.media_id),
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
		this.backfillIgUfFields(portalDomain, String(clientId), username, channelLabel, channel, sessionInfo, igPostUrl).catch((e) => {
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

	private async backfillIgUfFields(
		portalDomain: string,
		clientId: string,
		username: string,
		channelLabel: string,
		channel: string = "instdir",
		sessionInfo: { sessionId?: string; chatId?: string } = {},
		postUrl: string = "",
	): Promise<void> {
		const userCode = `i2crm_ig_${clientId}`;
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

		// chat.id у нас = `i2crm_ig_<client_id>` (см. handleI2crmIncoming).
		// Если же пришёл outgoing от ручного теста без incoming — chat.id может быть
		// сырым числом. Поддерживаем оба формата.
		const rawChatId = String(m.chat?.id || "");
		const match = rawChatId.match(/^i2crm_ig_(\d+)$/);
		const clientId = match ? match[1] : rawChatId.replace(/\D/g, "");
		if (!clientId) {
			return { success: false, message: `cannot parse client_id from chat.id=${rawChatId}` };
		}

		const text = m.message?.text || "";
		const files: any[] = (m.message as any)?.files || [];

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
		if (isDirect && text && text.length > IG_DIRECT_TEXT_LIMIT) {
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

		const body: Record<string, any> = {
			domain: "instagram",
			source: String(accountId),
			client: String(clientId),
			type: isDirect ? "direct" : "comment",
		};
		if (text) body.text = text;
		if (files.length > 0) {
			const photoUrls = files.map(fileUrl).filter((u) => u.length > 0);
			if (photoUrls.length > 0) {
				// i2crm /target/feedback принимает 'photo' как массив URL'ов
				// (видео не поддерживаются IG Direct API).
				body.photo = photoUrls;
				this.logger.info(`i2crm outgoing: ${photoUrls.length} photo URLs`, {
					urls: photoUrls.map((u) => u.replace(/SIGN=[^&]+/, "SIGN=<masked>")),
				});
			} else {
				this.logger.warn(`i2crm outgoing: files.length=${files.length} но URL не извлечён (link/downloadLink пустые)`);
			}
		}
		// Для comment: media (post id) и comment (parent comment id) обязательны
		// после переключения i2crm на «официальный» способ подключения. Берём из
		// IgCommentContext (записывается при incoming type=comment).
		if (isComment) {
			try {
				const ctx = await (this.prisma as any).igCommentContext.findUnique({
					where: { clientId: String(clientId) },
				});
				if (ctx?.mediaId && ctx?.commentId) {
					body.media = ctx.mediaId;
					body.comment = ctx.commentId;
				} else {
					this.logger.warn(`i2crm comment: no IgCommentContext for client=${clientId} — request will likely fail validation`);
				}
			} catch (e: any) {
				this.logger.warn(`i2crm comment: load IgCommentContext failed: ${e.message}`);
			}
		}

		this.logger.info(`i2crm outgoing: POST ${apiBase}/target/feedback`, {
			domain: body.domain, source: body.source, client: body.client, type: body.type,
			hasText: !!text, files: files.length,
		});

		try {
			const resp = await axios.post(`${apiBase}/target/feedback`, body, {
				params: { key: targetKey },
				timeout: 15000,
				// Не выкидываем axios-исключение при 4xx/5xx — i2crm возвращает 200 с error
				// в теле даже для бизнес-ошибок, нужна единая обработка.
				validateStatus: () => true,
			});
			const result = resp.data;
			// i2crm возвращает {error: false, data: {...}} при успехе, {error: "<msg>", data: {...}} при ошибке.
			if (result?.error) {
				this.logger.error(`i2crm outgoing rejected by i2crm API`, {
					httpStatus: resp.status,
					error: result.error,
					data: result.data,
				});
				return { success: false, message: `i2crm: ${typeof result.error === "string" ? result.error : "validation failed"}` };
			}
			this.logger.info(`i2crm outgoing OK`, { result });
			const externalMessageId = result?.data?.id || result?.data?.external_ids?.[0] || null;
			return {
				success: true,
				message: "Sent to i2crm",
				data: { i2crmResponse: result, externalMessageId, externalChatId: clientId },
			};
		} catch (err: any) {
			this.logger.error(`i2crm outgoing transport error: ${err.message}`);
			return { success: false, message: `i2crm transport: ${err.message}` };
		}
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

			await this.callBitrix24Method(domain, "imconnector.send.status.delivery", {
				CONNECTOR: connectorId,
				LINE: line,
				MESSAGES: [{
					im: originalMessage.im,
					message: {
						id: [externalMessageId],
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
		if (!idMessage || !["sent", "delivered", "read"].includes(status)) return;

		const entry = await (this.prisma as any).outgoingMessage.findUnique({
			where: { idMessage },
		});
		if (!entry) {
			// Сообщение не отправлено через adapter (мобильный WA / устройство) —
			// нет mapping'а для проксирования статуса.
			return;
		}
		if (entry.expiresAt.getTime() < Date.now()) {
			await (this.prisma as any).outgoingMessage.delete({ where: { idMessage } }).catch(() => undefined);
			return;
		}
		// Дедуп дублирующихся webhook'ов Green API. Если этот статус (или
		// более продвинутый) уже обработан — skip. Иначе при retry'е
		// Green API мы каждый раз дёргали бы B24 imconnector.send.status.delivery,
		// забивая rate-limit и засоряя logs.
		const STATUS_ORDER: Record<string, number> = { sent: 1, delivered: 2, read: 3 };
		const last = entry.lastStatusSeen ? String(entry.lastStatusSeen) : "";
		if (last && (STATUS_ORDER[last] || 0) >= (STATUS_ORDER[status] || 0)) {
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

	async getContactName(input: { phone?: string; igClientId?: string }): Promise<{ name: string | null; source: string | null; entityId: number | null; link: string | null; igUsername?: string | null }> {
		const phone = (input.phone || "").trim();
		const igClientId = (input.igClientId || "").trim();
		const empty = { name: null, source: null, entityId: null, link: null, igUsername: null };
		if (!phone && !igClientId) return empty;
		const key = phone ? `phone:${phone}` : `ig:${igClientId}`;
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
	): Promise<void> {
		const bridgeUrl = this.configService.get<string>("BRIDGE_HINT_URL");
		if (!bridgeUrl) return; // фича отключена если переменная не задана
		const secret = this.configService.get<string>("BRIDGE_HINT_SECRET") || "";
		const name = await this.getOperatorName(domain, b24UserId);
		if (!name) return;
		await axios.post(bridgeUrl, { idMessage, operatorName: name }, {
			timeout: 3000,
			headers: secret ? { "X-Hint-Secret": secret } : undefined,
		});
		this.logger.debug(`operator-hint sent to bridge: ${idMessage} → ${name}`);
	}
}