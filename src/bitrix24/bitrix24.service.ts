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
					const upd: Record<string, any> | null = buildUpdate(lead?.UF_CRM_IG_CHAT_ID, lead?.UF_CRM_IG_USERNAME, lead?.UF_CRM_INSTAGRAM);

					// LINK0 — стандартный multi-field LINK с подтипом LINK0
					// («активная ссылка на пост источника лида»). Записываем
					// для комментариев, где i2crm передаёт src=URL поста.
					// Перезаписываем при каждом новом комменте — актуальный пост.
					if (postUrl) {
						const existingLinks: any[] = Array.isArray(lead?.LINK) ? lead.LINK : [];
						const link0 = existingLinks.find((l) => l?.VALUE_TYPE === "LINK0");
						if (!link0 || link0.VALUE !== postUrl) {
							// Сохраняем остальные значения LINK (не LINK0) + добавляем/обновляем LINK0
							const newLinks: any[] = existingLinks
								.filter((l) => l?.VALUE_TYPE !== "LINK0")
								.map((l) => ({ ID: l.ID, VALUE: l.VALUE, VALUE_TYPE: l.VALUE_TYPE }));
							newLinks.push({ VALUE: postUrl, VALUE_TYPE: "LINK0" });
							if (upd) {
								(upd as any).LINK = newLinks;
							} else {
								await this.callBitrix24Method(portalDomain, "crm.lead.update", {
									id: ownerId,
									fields: { LINK: newLinks },
								});
								this.logger.info(`i2crm: updated lead ${ownerId} LINK0=${postUrl}`);
							}
						}
					}

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

		} catch (error: any) {
			this.logger.error(`Failed to send delivery confirmation: ${error.message}`, {
				domain,
				line,
				error: error.stack,
			});
		}
	}

	// ----- Contact-name lookup (для wa-tg-bridge: имя темы из B24) ---
	// Кеш phone/igClientId → ФИО клиента из B24. TTL 10 мин, чтобы не дёргать
	// B24 на каждое incoming-сообщение. При обновлении ФИО в B24 — мост подтянет
	// новое имя через max 10 минут (а если был direct refresh — мгновенно).
	private contactNameCache = new Map<string, { name: string | null; expires: number; entityId?: number | null; link?: string | null }>();

	async getContactName(input: { phone?: string; igClientId?: string }): Promise<{ name: string | null; source: string | null; entityId: number | null; link: string | null }> {
		const phone = (input.phone || "").trim();
		const igClientId = (input.igClientId || "").trim();
		const empty = { name: null, source: null, entityId: null, link: null };
		if (!phone && !igClientId) return empty;
		const key = phone ? `phone:${phone}` : `ig:${igClientId}`;
		const cached = this.contactNameCache.get(key);
		if (cached && cached.expires > Date.now()) {
			const c: any = cached;
			return { name: c.name, source: c.name ? "cache" : null, entityId: c.entityId || null, link: c.link || null };
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
						filter: { UF_CRM_IG_CHAT_ID: igClientId },
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

		this.contactNameCache.set(key, { name, expires: Date.now() + 600_000, entityId, link } as any);
		if (this.contactNameCache.size > 1000) {
			const now = Date.now();
			for (const [k, v] of this.contactNameCache) {
				if (v.expires < now) this.contactNameCache.delete(k);
			}
		}
		return { name, source, entityId, link };
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
			const u = Array.isArray(resp?.result) ? resp.result[0] : null;
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