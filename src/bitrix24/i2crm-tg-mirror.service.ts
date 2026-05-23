import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import { GreenApiLogger } from "@green-api/greenapi-integration";

// Зеркало Instagram-сообщений (i2crm Public API) в Telegram-группу — каждый
// клиент в отдельный топик. Симметрично с WA/MAX/TG-зеркалами из wa-tg-bridge,
// но реализовано прямо в adapter (i2crm — не Green API, отдельный pipeline).
//
// Хранилище маппинга client_id → topic_id — JSON-файл (на одном портале простой
// надёжный вариант, если потребуется — мигрировать в Prisma table).
interface MirrorState {
	topics: Record<string, number>;       // clientId → topic_id
	cardsPosted: Record<string, true>;    // leadId → true (карточка клиента уже постилась)
	pinnedCards?: Record<string, true>;   // `<groupId>:<clientId>` → true (pinned-card готова)
}

@Injectable()
export class I2crmTgMirrorService {
	private readonly logger = GreenApiLogger.getInstance(I2crmTgMirrorService.name);
	private readonly botToken: string | undefined;
	private readonly groupIdDirect: string | undefined;
	private readonly groupIdComment: string | undefined;
	private readonly mapPath: string;
	private state: MirrorState = { topics: {}, cardsPosted: {}, pinnedCards: {} };
	private mapLoaded = false;
	private writeLock: Promise<void> = Promise.resolve();

	constructor(private readonly configService: ConfigService) {
		this.botToken = this.configService.get<string>("TG_MIRROR_BOT_TOKEN");
		// Direct и Comments — в разные группы. Если *_DIRECT не задано —
		// fallback на общую I2CRM_TG_MIRROR_GROUP_ID (обратная совместимость).
		const fallback = this.configService.get<string>("I2CRM_TG_MIRROR_GROUP_ID");
		this.groupIdDirect = this.configService.get<string>("I2CRM_TG_MIRROR_GROUP_ID_DIRECT") || fallback;
		this.groupIdComment = this.configService.get<string>("I2CRM_TG_MIRROR_GROUP_ID_COMMENT") || fallback;
		this.mapPath = this.configService.get<string>("I2CRM_TG_MIRROR_TOPIC_MAP") || "/app/data/i2crm-topics.json";
	}

	get enabled(): boolean {
		return !!(this.botToken && (this.groupIdDirect || this.groupIdComment));
	}

	private groupForChannel(channel: string | undefined): string | undefined {
		return channel === "instcom" ? this.groupIdComment : this.groupIdDirect;
	}

	// Ключ маппинга — `<groupId>:<clientId>`. Один клиент может писать
	// и в Direct и в Comments (разные группы) — у него будут два разных топика.
	private topicKey(groupId: string, clientId: string): string {
		return `${groupId}:${clientId}`;
	}

	private async loadMap(): Promise<void> {
		if (this.mapLoaded) return;
		try {
			if (fs.existsSync(this.mapPath)) {
				const raw = fs.readFileSync(this.mapPath, "utf-8");
				const parsed = JSON.parse(raw || "{}");
				// Совместимость со старым форматом `{ clientId: topicId }`.
				if (parsed && typeof parsed === "object" && parsed.topics) {
					this.state = {
						topics: parsed.topics || {},
						cardsPosted: parsed.cardsPosted || {},
						pinnedCards: parsed.pinnedCards || {},
					};
				} else {
					this.state = { topics: parsed || {}, cardsPosted: {}, pinnedCards: {} };
				}
			} else {
				const dir = path.dirname(this.mapPath);
				if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(this.mapPath, JSON.stringify(this.state));
			}
		} catch (e: any) {
			this.logger.warn(`tg-mirror: failed to load state from ${this.mapPath}: ${e.message}`);
			this.state = { topics: {}, cardsPosted: {} };
		}
		this.mapLoaded = true;
	}

	private async persistMap(): Promise<void> {
		const job = this.writeLock.then(async () => {
			try {
				fs.writeFileSync(this.mapPath, JSON.stringify(this.state, null, 2));
			} catch (e: any) {
				this.logger.error(`tg-mirror: failed to persist state: ${e.message}`);
			}
		});
		this.writeLock = job;
		await job;
	}

	private async botApi(method: string, body: any): Promise<any> {
		const url = `https://api.telegram.org/bot${this.botToken}/${method}`;
		const r = await axios.post(url, body, { timeout: 15000 });
		if (r.data?.ok === false) {
			throw new Error(`Telegram API ${method} failed: ${r.data?.description || JSON.stringify(r.data)}`);
		}
		return r.data?.result;
	}

	private async createTopic(groupId: string, clientId: string, name: string): Promise<number> {
		const result = await this.botApi("createForumTopic", {
			chat_id: groupId,
			name: name.slice(0, 128),
		});
		const topicId = result.message_thread_id;
		this.state.topics[this.topicKey(groupId, clientId)] = topicId;
		await this.persistMap();
		this.logger.info(`tg-mirror: created topic ${topicId} in group ${groupId} for client ${clientId} (${name})`);
		return topicId;
	}

	private async findOrCreateTopic(
		groupId: string, clientId: string, name: string,
	): Promise<{ topicId: number; created: boolean }> {
		await this.loadMap();
		const key = this.topicKey(groupId, clientId);
		if (this.state.topics[key]) return { topicId: this.state.topics[key], created: false };
		// Legacy: один клиент мог быть сохранён как просто `<clientId>` (без groupId)
		// до разделения групп. Подхватываем такие записи в группу Comments
		// (где раньше был fallback).
		if (groupId === this.groupIdComment && this.state.topics[clientId]) {
			const oldTopic = this.state.topics[clientId];
			this.state.topics[key] = oldTopic;
			delete this.state.topics[clientId];
			await this.persistMap();
			this.logger.info(`tg-mirror: migrated legacy topic ${oldTopic} to key ${key}`);
			return { topicId: oldTopic, created: false };
		}
		const topicId = await this.createTopic(groupId, clientId, name);
		return { topicId, created: true };
	}

	/**
	 * Постит pinned-карточку клиента в новый IG-топик: аватарка из IG
	 * (profile_pic_url из i2crm payload) + имя + ссылка
	 * https://instagram.com/<username>/ + Direct/Comment отметка.
	 * Идёт async-задачей, чтобы не блокировать первое incoming-сообщение.
	 * При ошибке download/sendPhoto — fallback на текст. Pin best-effort.
	 */
	private async postIgPinnedCard(
		groupId: string, topicId: number, payload: any,
	): Promise<void> {
		try {
			const username = String(payload?.client_username || "").trim();
			const clientName = String(payload?.client_name || username || `IG_${payload?.client_id || ""}`).trim();
			const channel = String(payload?.channel || "");
			const channelLabel = channel === "instcom" ? "📷 Instagram коммент" : "💬 Instagram Direct";
			const igLink = username
				? `\nInstagram: <a href="https://instagram.com/${this.escapeHtml(username)}/">@${this.escapeHtml(username)}</a>`
				: "";
			const accountName = String(payload?.account_name || "").trim();
			// «@1begovoy.ru» без HTML-обёртки Telegram автолинкует как свой
			// username (несуществующий) — оборачиваем в ссылку на Instagram-
			// бизнес-аккаунт, как сделано для @клиента в шапке.
			const accountLine = accountName
				? `\nЛиния: <a href="https://instagram.com/${this.escapeHtml(accountName)}/">@${this.escapeHtml(accountName)}</a>`
				: "";
			const caption =
				`📋 Карточка клиента (${channelLabel.replace(/^[^\s]+\s+/, "")})\n` +
				`Имя: ${this.escapeHtml(clientName)}` +
				igLink + accountLine;

			let photoUrl: string | undefined;
			const profilePic = payload?.profile_pic_url || payload?.client_profile_pic_url
				|| payload?.client_pic_url || payload?.client?.profile_pic_url;
			if (profilePic && typeof profilePic === "string") {
				photoUrl = profilePic;
			}

			let sentMessageId: number | undefined;
			if (photoUrl) {
				try {
					const res = await this.botApi("sendPhoto", {
						chat_id: groupId,
						message_thread_id: topicId,
						photo: photoUrl,
						caption,
						parse_mode: "HTML",
						disable_notification: true,
					});
					sentMessageId = res?.message_id;
				} catch (e: any) {
					this.logger.debug(`tg-mirror: IG pinned sendPhoto failed (${e.message}), falling back to text`);
				}
			}
			if (!sentMessageId) {
				const res = await this.botApi("sendMessage", {
					chat_id: groupId,
					message_thread_id: topicId,
					text: caption,
					parse_mode: "HTML",
					disable_web_page_preview: true,
					disable_notification: true,
				});
				sentMessageId = res?.message_id;
			}
			if (sentMessageId) {
				try {
					await this.botApi("pinChatMessage", {
						chat_id: groupId,
						message_id: sentMessageId,
						disable_notification: true,
					});
				} catch (e: any) {
					this.logger.debug(`tg-mirror: IG pinChatMessage failed: ${e.message}`);
				}
			}
			const clientId = String(payload?.client_id || "");
			if (clientId) {
				if (!this.state.pinnedCards) this.state.pinnedCards = {};
				this.state.pinnedCards[this.topicKey(groupId, clientId)] = true;
				await this.persistMap();
			}
		} catch (e: any) {
			this.logger.warn(`tg-mirror: IG pinned card failed: ${e.message}`);
		}
	}

	/**
	 * One-shot backfill для существующих IG-топиков. Идёт по state.topics,
	 * пропускает уже отмеченные в state.pinnedCards. Для каждого:
	 *   1. Дёргает adapter self-call /internal/contact-name по clientId
	 *      (узнаёт ФИО + UF_CRM_IG_USERNAME из B24).
	 *   2. Постит pinned-карточку: имя + ссылка instagram.com/<username>/.
	 *      Аватарки нет (state не хранил profile_pic_url; для новых
	 *      incoming-сообщений аватарка приходит сразу через postIgPinnedCard).
	 *   3. pin_chat_message + mark в pinnedCards.
	 * Между топиками sleep delaySec секунд.
	 */
	async backfillExistingTopicCards(delaySec: number = 30): Promise<{
		total: number; posted: number; skipped: number; errors: number;
	}> {
		if (!this.enabled) return { total: 0, posted: 0, skipped: 0, errors: 0 };
		await this.loadMap();
		const delay = Math.max(5, delaySec);
		const pinned = this.state.pinnedCards || {};
		const entries = Object.entries(this.state.topics).filter(([k]) => !pinned[k]);
		let posted = 0; let skipped = 0; let errors = 0;
		const total = entries.length;
		this.logger.info(
			`tg-mirror: IG backfill started, ${total} topic(s), delay=${delay}s ETA ~${Math.round((total * delay) / 60)}min`,
		);
		const port = this.configService.get<string>("PORT") || "3000";
		const secret = this.configService.get<string>("BRIDGE_HINT_SECRET") || "";
		for (const [key, topicId] of entries) {
			let groupId: string; let clientId: string;
			if (key.includes(":")) {
				const parts = key.split(":", 2);
				groupId = parts[0]; clientId = parts[1];
			} else {
				groupId = this.groupIdComment || "";
				clientId = key;
			}
			if (!groupId || !clientId) { skipped++; continue; }
			let channel: string;
			if (groupId === this.groupIdComment) channel = "instcom";
			else if (groupId === this.groupIdDirect) channel = "instdir";
			else { skipped++; continue; }

			let name: string | null = null;
			let username: string | null = null;
			try {
				const resp = await axios.post(
					`http://127.0.0.1:${port}/webhooks/internal/contact-name`,
					{ igClientId: String(clientId) },
					{
						headers: secret ? { "X-Hint-Secret": secret } : undefined,
						timeout: 20000,
						validateStatus: () => true,
					},
				);
				if (resp.status === 200) {
					name = (resp.data?.name as string) || null;
					username = (resp.data?.igUsername as string) || null;
				}
			} catch (e: any) {
				this.logger.debug(`IG backfill: contact-name lookup failed for ${clientId}: ${e.message}`);
			}

			try {

				await this.postIgPinnedCard(groupId, topicId, {
					client_id: clientId,
					client_name: name || (username ? username : `IG_${clientId}`),
					client_username: username || "",
					channel,
				});
				posted++;
			} catch (e: any) {
				this.logger.warn(`IG backfill: failed for ${key}: ${e.message}`);
				errors++;
			}
			await new Promise((r) => setTimeout(r, delay * 1000));
		}
		this.logger.info(`tg-mirror: IG backfill finished total=${total} posted=${posted} skipped=${skipped} errors=${errors}`);
		return { total, posted, skipped, errors };
	}


	private buildCaption(payload: any): string {
		// HTML-формат: @username из IG оборачиваем в <a href="instagram.com/...">
		// чтобы клик открыл профиль Instagram, а не пытался искать username в TG
		// (Telegram автолинкует голый @logn на свою сеть). Используется
		// parse_mode='HTML' во всех вызовах sendMessage/sendPhoto/sendVideo.
		const clientNameRaw = payload?.client_name || `IG_${payload?.client_id}`;
		const clientName = this.escapeHtml(String(clientNameRaw));
		const username = payload?.client_username;
		const channel = String(payload?.channel || "");
		const isComment = channel === "instcom";
		const channelLabel = isComment ? "📷 Instagram коммент" : "💬 Instagram Direct";
		const usernameLink = username
			? ` (<a href="https://instagram.com/${this.escapeHtml(username)}/">@${this.escapeHtml(username)}</a>)`
			: "";
		const header = `${clientName}${usernameLink}`;
		// URL поста в i2crm payload приходит в `src` (основное поле, как для
		// фото-сообщений), `post_url` / `media_url` — legacy fallback. Раньше
		// читали только post_url → в зеркале «К посту:» терялся.
		const postUrl = String(payload?.src || payload?.post_url || payload?.media_url || "");
		const postCtx = isComment && postUrl
			? `\nК посту: <a href="${this.escapeHtml(postUrl)}">${this.escapeHtml(postUrl)}</a>`
			: "";
		const text = payload?.text ? `\n\n${this.escapeHtml(String(payload.text))}` : "";
		return `${channelLabel}\n${header}${postCtx}${text}`;
	}

	async mirrorIncoming(payload: any): Promise<void> {
		if (!this.enabled) {
			this.logger.debug("tg-mirror: disabled (no token or group_id)");
			return;
		}
		const clientId = String(payload?.client_id || "");
		if (!clientId) {
			this.logger.warn("tg-mirror: payload missing client_id, skipping");
			return;
		}
		const channel = String(payload?.channel || "");
		const groupId = this.groupForChannel(channel);
		if (!groupId) {
			this.logger.warn(`tg-mirror: no group configured for channel ${channel}`);
			return;
		}
		const username = payload?.client_username;
		const clientName = payload?.client_name || username || `IG_${clientId}`;
		// Префикс канала в названии темы — "IG Direct @1begovoy.ru" /
		// "IG Comment @1begovoy.ru". Имя бизнес-аккаунта берём из payload
		// (account_name). При нескольких подключённых IG-аккаунтах поможет
		// визуально различать их в общем списке тем TG-группы.
		const accountName = String(payload?.account_name || "").trim();
		const accountTag = accountName ? ` @${accountName}` : "";
		const channelPrefix = (channel === "instcom" ? "IG Comment" : "IG Direct") + accountTag;
		// ФИО клиента из B24 — через HTTP self-call к собственному endpoint
		// /webhooks/internal/contact-name. Прямая инжекция bitrix24Service'а
		// сюда даст circular dep (он же инжектит i2crm-tg-mirror), поэтому
		// идём через HTTP. Timeout 15с т.к. под нагрузкой backfill B24 может
		// отвечать медленно (OPERATION_TIME_LIMIT).
		let b24Name: string | null = null;
		try {
			const secret = this.configService.get<string>("BRIDGE_HINT_SECRET") || "";
			const port = this.configService.get<string>("PORT") || "3000";
			const resp = await axios.post(
				`http://127.0.0.1:${port}/webhooks/internal/contact-name`,
				{ igClientId: String(clientId) },
				{
					headers: secret ? { "X-Hint-Secret": secret } : undefined,
					timeout: 15000,
					validateStatus: () => true,
				},
			);
			if (resp.status === 200) {
				b24Name = (resp.data?.name as string) || null;
			}
		} catch (e: any) {
			this.logger.debug(`tg-mirror: B24 name self-lookup failed: ${e.message}`);
		}
		const baseName = b24Name || (username ? `@${username}` : clientName);
		const topicName = `${channelPrefix} · ${baseName}`;

		try {
			const { topicId, created } = await this.findOrCreateTopic(groupId, clientId, topicName);
			if (created) {
				// Pinned-карточка идёт фоновой задачей — не блокирует основное
				// зеркало incoming-сообщения. Аватарка из IG (profile_pic_url
				// из i2crm payload, если есть) + кликабельная ссылка
				// https://instagram.com/<username>/.
				void this.postIgPinnedCard(groupId, topicId, payload);
			}
			const caption = this.buildCaption(payload);
			const mediaUrl = payload?.media_url || payload?.media?.url;
			const type = String(payload?.type || "text");

			// Telegram caption-лимит = 1024 символа. Длинные подписи режем и
			// досылаем полный текст вторым sendMessage в тот же топик.
			const CAPTION_MAX = 1024;
			const truncated = caption.length > CAPTION_MAX
				? caption.slice(0, CAPTION_MAX - 3).trimEnd() + "…"
				: caption;
			const sendOverflow = async () => {
				if (caption.length <= CAPTION_MAX) return;
				await this.botApi("sendMessage", {
					chat_id: groupId,
					message_thread_id: topicId,
					text: caption,
					parse_mode: "HTML",
					disable_web_page_preview: true,
				});
			};

			if (mediaUrl && (type === "image" || type === "photo")) {
				await this.botApi("sendPhoto", {
					chat_id: groupId,
					message_thread_id: topicId,
					photo: mediaUrl,
					caption: truncated,
					parse_mode: "HTML",
				});
				await sendOverflow();
			} else if (mediaUrl && type === "video") {
				await this.botApi("sendVideo", {
					chat_id: groupId,
					message_thread_id: topicId,
					video: mediaUrl,
					caption: truncated,
					parse_mode: "HTML",
				});
				await sendOverflow();
			} else {
				// Текстовое сообщение — TG-лимит 4096 символов. На IG-комменте
				// маловероятно (Instagram сам режет до 2200), но защитимся.
				const TEXT_MAX = 4096;
				const text = caption.length > TEXT_MAX
					? caption.slice(0, TEXT_MAX - 3).trimEnd() + "…"
					: caption;
				await this.botApi("sendMessage", {
					chat_id: groupId,
					message_thread_id: topicId,
					text,
					parse_mode: "HTML",
					disable_web_page_preview: true,
				});
			}
			this.logger.info(`tg-mirror: mirrored msg to group ${groupId} topic ${topicId} (client=${clientId} channel=${channel})`);
		} catch (e: any) {
			this.logger.error(`tg-mirror: failed for client ${clientId}: ${e.message}`);
		}
	}

	// Постит карточку клиента в существующий топик: B24-лид, session, chat.
	// Идемпотентно — каждый leadId постится один раз (хранится в state.cardsPosted).
	// Вызывается из backfillIgUfFields после нахождения OWNER_ID.
	async postClientCard(input: {
		clientId: string;
		leadId: number;
		leadTitle?: string;
		sessionId?: string;
		chatId?: string;
		channel: "instdir" | "instcom" | string;
		portalDomain?: string;
	}): Promise<void> {
		if (!this.enabled) return;
		await this.loadMap();

		const leadKey = String(input.leadId);
		if (this.state.cardsPosted[leadKey]) {
			this.logger.debug(`tg-mirror: card already posted for lead ${leadKey}, skipping`);
			return;
		}

		const groupId = this.groupForChannel(input.channel);
		if (!groupId) {
			this.logger.warn(`tg-mirror: no group for channel ${input.channel}, cannot post card`);
			return;
		}
		const topicId = this.state.topics[this.topicKey(groupId, input.clientId)]
			|| this.state.topics[input.clientId]; // legacy fallback
		if (!topicId) {
			this.logger.warn(`tg-mirror: no topic in group ${groupId} for client ${input.clientId}, cannot post card`);
			return;
		}

		const portal = input.portalDomain || "1begovoy.bitrix24.ru";
		const channelLabel = input.channel === "instcom" ? "Comments" : "Direct";
		const title = input.leadTitle ? this.escapeHtml(input.leadTitle) : "";
		const sessionPart = input.sessionId && input.chatId
			? `\nSession ID: ${input.sessionId} · Chat: chat${input.chatId}`
			: input.sessionId
				? `\nSession ID: ${input.sessionId}`
				: "";
		const text = `📋 Карточка клиента (Instagram ${channelLabel})\n` +
			`Лид Bitrix: <a href="https://${portal}/crm/lead/details/${input.leadId}/">#${input.leadId}</a>` +
			(title ? `\nИмя: ${title}` : "") +
			sessionPart;

		try {
			await this.botApi("sendMessage", {
				chat_id: groupId,
				message_thread_id: topicId,
				text,
				parse_mode: "HTML",
				disable_web_page_preview: true,
				disable_notification: true,
			});
			this.state.cardsPosted[leadKey] = true;
			await this.persistMap();
			this.logger.info(`tg-mirror: posted client card for lead ${leadKey} → group ${groupId} topic ${topicId}`);
		} catch (e: any) {
			this.logger.error(`tg-mirror: failed to post card for lead ${leadKey}: ${e.message}`);
		}
	}

	private escapeHtml(s: string): string {
		return s
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	// Массовое переименование всех IG-тем — обновляет название по текущему
	// формату 'IG Direct @<account> · <ФИО из B24>'. Используется когда формат
	// изменился (например, добавили префикс @account_name) и нужно ретроактивно
	// применить ко всем существующим темам.
	// channel: 'instdir' / 'instcom' / undefined (= оба сразу).
	async refreshAllTopics(input: { channel?: string; accountName?: string } = {}): Promise<{
		total: number; renamed: number; skipped_same: number; no_b24: number; errors: number;
	}> {
		if (!this.enabled) {
			return { total: 0, renamed: 0, skipped_same: 0, no_b24: 0, errors: 0 };
		}
		await this.loadMap();
		const channelFilter = input.channel || "";
		// Если не передали account_name (raw payload отсутствует) — попробуем
		// из env I2CRM_INSTAGRAM_ACCOUNT_NAME, fallback на "1begovoy.ru".
		const accountName = input.accountName
			|| this.configService.get<string>("I2CRM_INSTAGRAM_ACCOUNT_NAME")
			|| "1begovoy.ru";

		let total = 0;
		let renamed = 0;
		let skipped_same = 0;
		let no_b24 = 0;
		let errors = 0;

		const port = this.configService.get<string>("PORT") || "3000";
		const secret = this.configService.get<string>("BRIDGE_HINT_SECRET") || "";

		for (const [key, topicId] of Object.entries(this.state.topics)) {
			// Ключи бывают:
			//   <groupId>:<clientId> — current формат (после разделения групп)
			//   <clientId>           — legacy (один топик на клиента, оба канала)
			let groupId: string | undefined;
			let clientId: string;
			if (key.includes(":")) {
				const parts = key.split(":", 2);
				groupId = parts[0];
				clientId = parts[1];
			} else {
				groupId = this.groupIdComment; // legacy keys лежали в Comments
				clientId = key;
			}

			// Определяем channel по groupId
			let channel: string;
			if (groupId === this.groupIdComment) channel = "instcom";
			else if (groupId === this.groupIdDirect) channel = "instdir";
			else continue; // топик в неизвестной группе

			if (channelFilter && channelFilter !== channel) continue;
			total++;

			try {
				// ФИО из B24 через self-call (избегаем circular dep). Timeout
				// большой (30с), т.к. при параллельной нагрузке (backfill #22)
				// B24-квота OPERATION_TIME_LIMIT может задерживать crm.contact.list
				// и crm.lead.list до 5-15 секунд.
				let b24Name: string | null = null;
				try {
					const resp = await axios.post(
						`http://127.0.0.1:${port}/webhooks/internal/contact-name`,
						{ igClientId: String(clientId) },
						{
							headers: secret ? { "X-Hint-Secret": secret } : undefined,
							timeout: 30000,
							validateStatus: () => true,
						},
					);
					if (resp.status === 200) b24Name = (resp.data?.name as string) || null;
				} catch (e: any) {
					this.logger.debug(`refresh-ig: B24 lookup failed for ${clientId}: ${e.message}`);
				}
				if (!b24Name) {
					no_b24++;
					continue;
				}

				const prefix = (channel === "instcom" ? "IG Comment" : "IG Direct") + ` @${accountName}`;
				const newName = `${prefix} · ${b24Name}`.slice(0, 128);

				try {
					await this.botApi("editForumTopic", {
						chat_id: groupId,
						message_thread_id: topicId,
						name: newName,
					});
					renamed++;
				} catch (e: any) {
					if (String(e.message).includes("TOPIC_NOT_MODIFIED")) {
						skipped_same++;
					} else {
						this.logger.warn(`refresh-ig: editForumTopic failed for ${topicId}: ${e.message}`);
						errors++;
					}
				}
				// Rate-limit 1 req/sec (Telegram Bot API лимит).
				await new Promise((r) => setTimeout(r, 1000));
			} catch (e: any) {
				this.logger.warn(`refresh-ig: iteration failed for ${key}: ${e.message}`);
				errors++;
			}
		}

		return { total, renamed, skipped_same, no_b24, errors };
	}
}
