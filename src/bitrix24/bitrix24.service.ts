import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios, { AxiosInstance } from "axios";

// Маппинг префикса idInstance → API URL. Дублирует helper из widget.controller.ts.
// При появлении новых shard'ов дополнять оба места.
function greenApiUrlForInstance(idInstance: string): string {
	const known: Record<string, string> = {
		"1103487233": "https://1103.api.green-api.com",
		"1101948511": "https://api.green-api.com",
		"3100621187": "https://3100.api.green-api.com",
		"4100621194": "https://4100.api.green-api.com",
	};
	return known[idInstance] || "https://api.green-api.com";
}
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

@Injectable()
export class Bitrix24Service extends BaseAdapter<
	Bitrix24WebhookDto,
	Bitrix24PlatformMessage,
	User,
	Instance
> {
	private readonly logger = GreenApiLogger.getInstance(Bitrix24Service.name);

	constructor(
		protected readonly bitrix24Transformer: Bitrix24Transformer,
		protected readonly prisma: PrismaService,
		private readonly configService: ConfigService,
		private readonly i2crmTgMirror: I2crmTgMirrorService,
	) {
		super(bitrix24Transformer, prisma);
	}

	private async refreshAccessToken(user: User): Promise<string> {
		if (!user.refreshToken) {
			throw new IntegrationError("No refresh token available", "UNAUTHORIZED");
		}

		try {
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
			this.logger.error(`Failed to refresh token for ${user.portalDomain}:`, error.response?.data || error.message);
			throw new IntegrationError("Failed to refresh access token", "UNAUTHORIZED");
		}
	}

	private async callBitrix24Method(
		portalDomain: string,
		method: string,
		params: Record<string, any> = {},
		accessToken?: string,
		retryCount: number = 0,
	): Promise<unknown> {
		const user = await this.prisma.findUser(portalDomain);
		let token = accessToken || user?.accessToken;

		if (!token) {
			throw new IntegrationError(`No access token for portal ${portalDomain}`, "UNAUTHORIZED");
		}

		try {
			const url = `https://${portalDomain}/rest/${method}?auth=${token}`;
			// Маскируем токен в логах — он попадает в docker logs/transcript.
			const safeUrl = url.replace(/(auth=)[^&]+/, "$1<masked>");
			this.logger.debug(`Calling Bitrix24 method: ${method}`, {url: safeUrl, params});

			const response = await axios.post(url, params);

			// Логируем результат для диагностики (особенно полезно для imconnector.send.messages,
			// где B24 возвращает per-message статусы — успех ≠ привязка к CRM).
			if (method === "imconnector.send.messages") {
				this.logger.info(`B24 response for ${method}`, {result: response.data?.result});
			}

			if (response.data.error) {
				if (response.data.error === "expired_token" && retryCount === 0 && user?.refreshToken) {
					this.logger.warn(`Token expired for ${portalDomain}, attempting refresh...`);

					try {
						const newToken = await this.refreshAccessToken(user);
						return this.callBitrix24Method(portalDomain, method, params, newToken, retryCount + 1);
					} catch (refreshError) {
						this.logger.error(`Token refresh failed for ${portalDomain}:`, refreshError);
						throw new IntegrationError("Authentication failed - please reinstall the app", "UNAUTHORIZED");
					}
				}
				throw new Error(`Bitrix24 API Error: ${response.data.error_description || response.data.error}`);
			}

			return response.data.result;
		} catch (error: any) {
			if (error.response?.status === 401 && retryCount === 0 && user?.refreshToken) {
				this.logger.warn(`HTTP 401 error for ${portalDomain}, attempting token refresh...`);
				try {
					const newToken = await this.refreshAccessToken(user);
					return this.callBitrix24Method(portalDomain, method, params, newToken, retryCount + 1);
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

	// Простой мьютекс на phone, чтобы два одновременных webhook'а от Green API не
	// создали два дублирующих лида до того как первый успеет завершить crm.lead.add.
	private readonly _ensureLeadLocks = new Map<string, Promise<void>>();

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
	 * Идемпотентность обеспечивается мьютексом по phone и проверкой 2-3.
	 */
	async ensureOpenLeadForPhone(
		portalDomain: string,
		phoneE164: string,
		senderName: string,
		lineId: number,
		channelLabel: string = "WhatsApp",
		chatId?: string,
	): Promise<void> {
		const lockKey = `${portalDomain}:${phoneE164}:${chatId || ""}`;
		const existing = this._ensureLeadLocks.get(lockKey);
		if (existing) {
			await existing;
			return;
		}
		const task = (async () => {
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
					return;
				}
				// Если нашли контакт И есть chatId — сохраняем chatId в UF контакта
				// (только если поле сейчас пустое). Это даст матч по chatId для
				// будущих сообщений когда phone недоступен.
				if (chatId && chatIdUf) {
					try {
						const contactData: any = await this.callBitrix24Method(portalDomain, "crm.contact.get", { id: contactId });
						const existingValue = contactData?.[chatIdUf];
						if (!existingValue) {
							await this.callBitrix24Method(portalDomain, "crm.contact.update", {
								id: contactId,
								fields: { [chatIdUf]: chatId },
							});
							this.logger.info(`ensureLead: saved ${chatIdUf}=${chatId} on contact ${contactId}`);
						}
					} catch (e: any) {
						this.logger.warn(`ensureLead: failed to save chatId on contact ${contactId}: ${e.message}`);
					}
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
					return;
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
					return;
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
				};
				if (sourceId) fields.SOURCE_ID = sourceId;

				const createdId: any = await this.callBitrix24Method(portalDomain, "crm.lead.add", { fields });
				this.logger.info(`ensureLead: created lead ${createdId} for contact ${contactId} (phone ${phoneE164})`);
			} catch (err: any) {
				// Не блокируем доставку сообщения, только логируем
				this.logger.error(`ensureLead failed: ${err.message}`);
			}
		})();
		this._ensureLeadLocks.set(lockKey, task);
		try {
			await task;
		} finally {
			this._ensureLeadLocks.delete(lockKey);
		}
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

		// Сохраним username отдельно (косметика, ссылка @user).
		if (username) {
			try {
				const dup: any = await this.callBitrix24Method(portalDomain, "crm.contact.list", {
					filter: { UF_CRM_IG_CHAT_ID: String(clientId) },
					select: ["ID", "UF_CRM_IG_USERNAME"],
				});
				if (Array.isArray(dup) && dup.length > 0) {
					const cid = dup[0].ID;
					if (!dup[0].UF_CRM_IG_USERNAME) {
						await this.callBitrix24Method(portalDomain, "crm.contact.update", {
							id: cid,
							fields: { UF_CRM_IG_USERNAME: username },
						});
					}
				}
			} catch (e: any) {
				this.logger.warn(`i2crm: failed to set IG_USERNAME: ${e.message}`);
			}
		}

		// Текст для B24. Для comment-канала добавляем контекст что это коммент,
		// поскольку Direct и Comment могут идти от одного клиента и нужно различать.
		const isComment = channel === "instcom";
		const postUrl = payload?.post_url || payload?.media_url || "";
		const finalText = isComment
			? `[Instagram комментарий${postUrl ? " к посту " + postUrl : ""}]\n${text}`
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
				url: username ? `https://instagram.com/${username}` : undefined,
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

		try {
			await this.callBitrix24Method(portalDomain, "imconnector.send.messages", {
				CONNECTOR: "social_connector",
				LINE: lineId,
				MESSAGES: [messagePayload],
			});
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

		return { success: true };
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
			body.photo = files.map((f: any) => f.url);
		}
		// Для comment: media (post id) и comment (parent comment id) обязательны
		// по спеке, но контекст обычно теряется в B24-pipeline. i2crm сам сопоставляет
		// по client_id с последним комментарием пользователя (см. описание поля).

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

		} catch (error: any) {
			this.logger.error(`Failed to send delivery confirmation: ${error.message}`, {
				domain,
				line,
				error: error.stack,
			});
		}
	}
}