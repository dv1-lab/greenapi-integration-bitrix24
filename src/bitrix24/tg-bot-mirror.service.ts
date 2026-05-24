import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import { GreenApiLogger } from "@green-api/greenapi-integration";

// Зеркало сообщений Telegram-ботов (@begovoy_bot, @begovoy1support_bot, …) в
// TG-супергруппы — каждый клиент в отдельный топик. Один сервис обслуживает
// несколько бот-инстансов: каждый со своей группой зеркала. State хранит
// (groupId,chatId)→topicId и (groupId,chatId)→cardsPosted в одном JSON-файле,
// чтобы топики разных инстансов не пересекались. Бот зеркала один общий —
// @begovoyconnect_bot (TG_MIRROR_BOT_TOKEN).
//
// botByGroupId: маппинг groupId → botName для refresh — у топика в JSON-state
// есть groupId, по нему можно достать botName из env TG_BOT_MIRROR_GROUPS
// (формат: "<botName>:<groupId>,..."). Используется при backfill заголовков
// — иначе мы не знаем под каким botName тема создавалась.
interface MirrorState {
	topics: Record<string, number>;      // "<groupId>:<chatId>" → topic_id
	cardsPosted: Record<string, true>;   // "<groupId>:<chatId>" → карточка постилась
}

@Injectable()
export class TgBotMirrorService {
	private readonly logger = GreenApiLogger.getInstance(TgBotMirrorService.name);
	private readonly botToken: string | undefined;
	private readonly defaultGroupId: string | undefined;
	private readonly mapPath: string;
	private state: MirrorState = { topics: {}, cardsPosted: {} };
	private mapLoaded = false;
	private writeLock: Promise<void> = Promise.resolve();

	constructor(private readonly configService: ConfigService) {
		this.botToken = this.configService.get<string>("TG_MIRROR_BOT_TOKEN");
		// Default group — для legacy @begovoy_bot, чтобы вызовы без override
		// продолжали работать как раньше.
		this.defaultGroupId = this.configService.get<string>("TG_BOT_MIRROR_GROUP_ID");
		this.mapPath = this.configService.get<string>("TG_BOT_MIRROR_TOPIC_MAP")
			|| "/app/data/tg-bot-topics.json";
	}

	get enabled(): boolean {
		return !!this.botToken;
	}

	private key(groupId: string, chatId: string): string {
		return `${groupId}:${chatId}`;
	}

	private async loadMap(): Promise<void> {
		if (this.mapLoaded) return;
		try {
			if (fs.existsSync(this.mapPath)) {
				const raw = fs.readFileSync(this.mapPath, "utf-8");
				const parsed = JSON.parse(raw || "{}");
				const topics = parsed.topics || {};
				const cardsPosted = parsed.cardsPosted || {};
				// Миграция: ключи без `:` — legacy формат (chatId без groupId),
				// они относятся к default-группе (@begovoy_bot). Дописываем
				// префикс defaultGroupId, чтобы перейти на новый composite-формат.
				let migrated = 0;
				const migratedTopics: Record<string, number> = {};
				for (const [k, v] of Object.entries(topics)) {
					if (k.includes(":")) {
						migratedTopics[k] = v as number;
					} else if (this.defaultGroupId) {
						migratedTopics[this.key(this.defaultGroupId, k)] = v as number;
						migrated++;
					}
				}
				const migratedCards: Record<string, true> = {};
				for (const [k, v] of Object.entries(cardsPosted)) {
					if (k.includes(":")) {
						migratedCards[k] = v as true;
					} else if (this.defaultGroupId) {
						migratedCards[this.key(this.defaultGroupId, k)] = v as true;
						migrated++;
					}
				}
				this.state = { topics: migratedTopics, cardsPosted: migratedCards };
				if (migrated > 0) {
					this.logger.info(`tg-bot-mirror: migrated ${migrated} legacy keys to composite format`);
					// Сохранение мигрированной карты — асинхронно после mapLoaded=true.
				}
			} else {
				const dir = path.dirname(this.mapPath);
				if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(this.mapPath, JSON.stringify(this.state));
			}
		} catch (e: any) {
			this.logger.warn(`tg-bot-mirror: failed to load state: ${e.message}`);
			this.state = { topics: {}, cardsPosted: {} };
		}
		this.mapLoaded = true;
	}

	private async persistMap(): Promise<void> {
		const job = this.writeLock.then(async () => {
			try {
				fs.writeFileSync(this.mapPath, JSON.stringify(this.state, null, 2));
			} catch (e: any) {
				this.logger.error(`tg-bot-mirror: failed to persist state: ${e.message}`);
			}
		});
		this.writeLock = job;
		await job;
	}

	private async botApi(method: string, body: any): Promise<any> {
		const url = `https://api.telegram.org/bot${this.botToken}/${method}`;
		const r = await axios.post(url, body, { timeout: 15000 });
		if (r.data?.ok === false) {
			throw new Error(`Telegram API ${method} failed: ${r.data?.description || "unknown"}`);
		}
		return r.data?.result;
	}

	private escapeHtml(s: string): string {
		return s
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	private async findOrCreateTopic(
		groupId: string, chatId: string, name: string,
	): Promise<{ topicId: number; created: boolean }> {
		await this.loadMap();
		const k = this.key(groupId, chatId);
		if (this.state.topics[k]) {
			return { topicId: this.state.topics[k], created: false };
		}
		const result = await this.botApi("createForumTopic", {
			chat_id: groupId,
			name: name.slice(0, 128),
		});
		const topicId = result.message_thread_id;
		this.state.topics[k] = topicId;
		await this.persistMap();
		this.logger.info(`tg-bot-mirror: created topic ${topicId} in group ${groupId} for client ${chatId} (${name})`);
		return { topicId, created: true };
	}

	// Резолв ФИО клиента из B24 через HTTP self-call (прямая инжекция
	// Bitrix24Service дала бы circular dep). По tgChatId ищется контакт/лид
	// с UF_CRM_TG_CHAT_ID.
	private async resolveB24Name(chatId: string): Promise<string | null> {
		try {
			const secret = this.configService.get<string>("BRIDGE_HINT_SECRET") || "";
			const port = this.configService.get<string>("PORT") || "3000";
			const resp = await axios.post(
				`http://127.0.0.1:${port}/webhooks/internal/contact-name`,
				{ tgChatId: chatId },
				{
					headers: secret ? { "X-Hint-Secret": secret } : undefined,
					timeout: 15000,
					validateStatus: () => true,
				},
			);
			if (resp.status === 200) return (resp.data?.name as string) || null;
		} catch (e: any) {
			this.logger.debug(`tg-bot-mirror: B24 name lookup failed: ${e.message}`);
		}
		return null;
	}

	// Резолв lead/contact для клиента — для ссылок в карточке. По tgChatId
	// проходит через /webhooks/internal/b24-entities (тот же кеш B24 что и
	// в contact-name).
	private async resolveB24Entities(chatId: string): Promise<{ leadId: number | null; contactId: number | null }> {
		const empty = { leadId: null, contactId: null };
		try {
			const secret = this.configService.get<string>("BRIDGE_HINT_SECRET") || "";
			const port = this.configService.get<string>("PORT") || "3000";
			const resp = await axios.post(
				`http://127.0.0.1:${port}/webhooks/internal/b24-entities`,
				{ tgChatId: chatId },
				{
					headers: secret ? { "X-Hint-Secret": secret } : undefined,
					timeout: 5000,
					validateStatus: () => true,
				},
			);
			if (resp.status === 200) {
				return {
					leadId: resp.data?.leadId || null,
					contactId: resp.data?.contactId || null,
				};
			}
		} catch (e: any) {
			this.logger.debug(`tg-bot-mirror: b24-entities lookup failed: ${e.message}`);
		}
		return empty;
	}

	// Резолв customer-360 UUID (создание новой записи если ещё не было).
	// Возвращает UUID либо null при недоступности customer-service. Используется
	// в карточке клиента (поле «Customer-360»).
	private async resolveCustomerUuid(chatId: string): Promise<string | null> {
		const url = this.configService.get<string>("CUSTOMER_SERVICE_URL") || "";
		const secret = this.configService.get<string>("CUSTOMER_SERVICE_SECRET") || "";
		if (!url || !secret) return null;
		try {
			const resp = await axios.post(
				`${url.replace(/\/$/, "")}/customers/find-or-create`,
				{ aliasType: "tg_user", aliasValue: String(chatId), addedBy: "tg-bot-mirror" },
				{
					headers: { "X-Service-Secret": secret },
					timeout: 5000,
					validateStatus: () => true,
				},
			);
			if (resp.status === 200 || resp.status === 201) {
				const c = resp.data?.customer;
				if (c && c.uuid) return String(c.uuid);
			}
		} catch (e: any) {
			this.logger.debug(`tg-bot-mirror: customer-360 resolve failed: ${e.message}`);
		}
		return null;
	}

	// Человеческое название TG-линии. Источники:
	//  1. env TG_BOT_LINE_NAMES — формат "begovoy:Telegram begovoy_main,support:Telegram 1Б Поддержка"
	//  2. fallback по lineId через env LINE_NAMES (общий формат "<lineId>:<name>")
	//  3. ультимативный fallback: "Telegram (@<botName>)"
	private resolveLineName(botName: string | undefined, lineId: number | undefined): string {
		const raw = this.configService.get<string>("TG_BOT_LINE_NAMES") || "";
		if (raw && botName) {
			for (const pair of raw.split(",")) {
				const idx = pair.indexOf(":");
				if (idx < 0) continue;
				const k = pair.slice(0, idx).trim();
				const v = pair.slice(idx + 1).trim();
				if (k === botName && v) return v;
			}
		}
		const lineRaw = this.configService.get<string>("LINE_NAMES") || "";
		if (lineRaw && lineId) {
			for (const pair of lineRaw.split(",")) {
				const idx = pair.indexOf(":");
				if (idx < 0) continue;
				const k = pair.slice(0, idx).trim();
				const v = pair.slice(idx + 1).trim();
				if (k === String(lineId) && v) return v;
			}
		}
		return botName ? `Telegram (@${botName})` : "Telegram";
	}

	private b24Portal(): string {
		const cfg = this.configService.get<string>("BITRIX_PORTAL")
			|| this.configService.get<string>("BITRIX_PORTAL_DOMAIN")
			|| "";
		return cfg.trim() || "1begovoy.bitrix24.ru";
	}

	// Достаёт photoFileId клиента через клиентский бот-инстанс (НЕ зеркало!).
	// У зеркального бота (TG_MIRROR_BOT_TOKEN) аватарок клиентов нет — клиент
	// никогда с ним не общался. Нужен токен того бота, через которого клиент
	// писал в нашу систему (@begovoy_bot / @begovoy1support_bot).
	// botName опционален; если не передан — попробуем дефолтный TG_BOT_TOKEN.
	private async fetchClientAvatarFileId(
		chatId: string, botName?: string,
	): Promise<string | null> {
		// Резолв токена клиентского бота по имени.
		let clientToken: string | undefined;
		if (botName === "support") {
			clientToken = this.configService.get<string>("TG_BOT_SUPPORT_TOKEN");
		} else if (botName) {
			// Шаблон: TG_BOT_<BOTNAME_UPPER>_TOKEN, для legacy «begovoy» —
			// TG_BOT_TOKEN.
			const upper = botName.toUpperCase();
			clientToken = this.configService.get<string>(`TG_BOT_${upper}_TOKEN`)
				|| this.configService.get<string>("TG_BOT_TOKEN");
		} else {
			clientToken = this.configService.get<string>("TG_BOT_TOKEN");
		}
		if (!clientToken) return null;
		try {
			const r = await axios.get(
				`https://api.telegram.org/bot${clientToken}/getUserProfilePhotos`,
				{
					params: { user_id: chatId, limit: 1 },
					timeout: 10000,
					validateStatus: () => true,
				},
			);
			if (r.data?.ok !== true) return null;
			const photos = r.data?.result?.photos as any[] | undefined;
			if (!photos || photos.length === 0) return null;
			const sizes = photos[0] as any[];
			if (!sizes || sizes.length === 0) return null;
			// Берём самую крупную (последнюю в массиве).
			const biggest = sizes[sizes.length - 1];
			const fileId = biggest?.file_id as string | undefined;
			if (!fileId) return null;
			// Скачиваем через getFile + file_path в Buffer (file_id клиентского
			// бота не работает у бота-зеркала — нужно перезагрузить как фото).
			const info: any = await axios.get(
				`https://api.telegram.org/bot${clientToken}/getFile`,
				{ params: { file_id: fileId }, timeout: 10000, validateStatus: () => true },
			);
			if (info.data?.ok !== true) return null;
			const filePath = info.data?.result?.file_path as string | undefined;
			if (!filePath) return null;
			return `https://api.telegram.org/file/bot${clientToken}/${filePath}`;
		} catch (e: any) {
			this.logger.debug(`tg-bot-mirror: fetchClientAvatar failed: ${e.message}`);
			return null;
		}
	}

	// Постит карточку клиента в топик (идемпотентно по (groupId,chatId)) + закрепляет.
	// Унифицированный формат — см. docs/ARCHITECTURE.md § Карточка клиента.
	// Если у клиента есть аватар в Telegram (getUserProfilePhotos через клиентский
	// бот) — карточка идёт sendPhoto с caption; иначе текстом.
	private async postClientCard(
		groupId: string, topicId: number, chatId: string, clientName: string, username: string,
		botName?: string, lineId?: number,
	): Promise<void> {
		const ck = this.key(groupId, chatId);
		if (this.state.cardsPosted[ck]) return;

		// Все обогащающие lookup'ы — best-effort параллельно. Если что-то
		// не ответило за timeout, просто пропускаем соответствующую строку.
		const [entities, uuid, avatarUrl] = await Promise.all([
			this.resolveB24Entities(chatId),
			this.resolveCustomerUuid(chatId),
			this.fetchClientAvatarFileId(chatId, botName),
		]);
		const lineName = this.resolveLineName(botName, lineId);
		const portal = this.b24Portal();

		const lines: string[] = ["📋 Карточка клиента (Telegram)"];
		if (clientName && clientName.trim()) {
			lines.push(`Имя: ${this.escapeHtml(clientName)}`);
		}
		if (username) {
			lines.push(
				`Telegram: <a href="https://t.me/${this.escapeHtml(username)}">@${this.escapeHtml(username)}</a> (chat_id ${this.escapeHtml(chatId)})`,
			);
		} else {
			lines.push(`Telegram chat_id: ${this.escapeHtml(chatId)}`);
		}
		lines.push(`Линия: ${this.escapeHtml(lineName)}`);
		if (entities.leadId) {
			lines.push(`B24 лид: https://${this.escapeHtml(portal)}/crm/lead/details/${entities.leadId}/`);
		}
		if (entities.contactId) {
			lines.push(`B24 контакт: https://${this.escapeHtml(portal)}/crm/contact/details/${entities.contactId}/`);
		}
		if (uuid) {
			lines.push(`Customer-360: ${this.escapeHtml(uuid)}`);
		}
		lines.push("Команды: /nnn &lt;текст&gt; — внутренняя заметка");
		const text = lines.join("\n");
		try {
			let messageId: number | undefined;
			if (avatarUrl) {
				try {
					const res = await this.botApi("sendPhoto", {
						chat_id: groupId,
						message_thread_id: topicId,
						photo: avatarUrl,
						caption: text,
						parse_mode: "HTML",
						disable_notification: true,
					});
					messageId = res?.message_id;
				} catch (e: any) {
					this.logger.debug(`tg-bot-mirror: sendPhoto failed (${e.message}), falling back to text`);
				}
			}
			if (!messageId) {
				const res = await this.botApi("sendMessage", {
					chat_id: groupId,
					message_thread_id: topicId,
					text,
					parse_mode: "HTML",
					disable_web_page_preview: true,
					disable_notification: true,
				});
				messageId = res?.message_id;
			}
			if (messageId) {
				try {
					await this.botApi("pinChatMessage", {
						chat_id: groupId,
						message_id: messageId,
						disable_notification: true,
					});
				} catch (e: any) {
					this.logger.debug(`tg-bot-mirror: pin failed: ${e.message}`);
				}
			}
			this.state.cardsPosted[ck] = true;
			await this.persistMap();
		} catch (e: any) {
			this.logger.warn(`tg-bot-mirror: postClientCard failed: ${e.message}`);
		}
	}

	// Массовое переименование тем под единый стандарт «TG · <botName> · <ФИО>».
	// Идёт по state.topics, для каждой темы:
	//  1. Определяет channel-source (botName) по groupId — резолв через env
	//     TG_BOT_MIRROR_GROUPS (формат: "begovoy:-1003988471578,support:-1003772436222").
	//  2. Дёргает adapter self-call /webhooks/internal/contact-name за актуальным
	//     ФИО (если в B24 оператор переименовал клиента — подтягиваем).
	//  3. editForumTopic — rate-limit 1 op/sec (TG лимит для group-level edits).
	//
	// Возвращает {total, renamed, skipped_same, no_b24, errors}. botName и
	// channel определяются по groupId, поэтому опционально можно отфильтровать
	// конкретный бот через input.botName.
	async refreshAllTopics(input: { botName?: string } = {}): Promise<{
		total: number; renamed: number; skipped_same: number; no_b24: number; errors: number;
	}> {
		if (!this.enabled) {
			return { total: 0, renamed: 0, skipped_same: 0, no_b24: 0, errors: 0 };
		}
		await this.loadMap();

		// Маппинг groupId → botName. Источники в порядке приоритета:
		//  1. env TG_BOT_MIRROR_GROUPS_MAP — явный список:
		//     "begovoy:-1003988471578,support:-1003772436222"
		//  2. fallback: дефолтные env TG_BOT_MIRROR_GROUP_ID → "begovoy",
		//     TG_BOT_SUPPORT_MIRROR_GROUP_ID → "support".
		// Темы в неизвестной группе пропускаются.
		const raw = this.configService.get<string>("TG_BOT_MIRROR_GROUPS_MAP") || "";
		const groupToBot: Record<string, string> = {};
		for (const pair of raw.split(",")) {
			const idx = pair.indexOf(":");
			if (idx < 0) continue;
			const bot = pair.slice(0, idx).trim();
			const gid = pair.slice(idx + 1).trim();
			if (bot && gid) groupToBot[gid] = bot;
		}
		// Fallback: дефолтные имена env-переменных по бот-инстансу.
		const begGid = this.configService.get<string>("TG_BOT_MIRROR_GROUP_ID");
		if (begGid && !groupToBot[begGid]) groupToBot[begGid] = "begovoy";
		const supGid = this.configService.get<string>("TG_BOT_SUPPORT_MIRROR_GROUP_ID");
		if (supGid && !groupToBot[supGid]) groupToBot[supGid] = "support";

		const port = this.configService.get<string>("PORT") || "3000";
		const secret = this.configService.get<string>("BRIDGE_HINT_SECRET") || "";

		let total = 0;
		let renamed = 0;
		let skipped_same = 0;
		let no_b24 = 0;
		let errors = 0;

		const allEntries = Object.entries(this.state.topics);
		this.logger.info(`refresh-tg-bot: starting, ${allEntries.length} тем (групп ${Object.keys(groupToBot).length})`);
		for (const [key, topicId] of allEntries) {
			if (!key.includes(":")) continue; // composite-only
			const idx = key.indexOf(":");
			const groupId = key.slice(0, idx);
			const chatId = key.slice(idx + 1);
			const botName = groupToBot[groupId];
			if (!botName) continue; // тема в неизвестной группе — skip
			if (input.botName && input.botName !== botName) continue;
			total++;

			let b24Name: string | null = null;
			try {
				const resp = await axios.post(
					`http://127.0.0.1:${port}/webhooks/internal/contact-name`,
					{ tgChatId: chatId },
					{
						headers: secret ? { "X-Hint-Secret": secret } : undefined,
						timeout: 20000,
						validateStatus: () => true,
					},
				);
				if (resp.status === 200) b24Name = (resp.data?.name as string) || null;
			} catch (e: any) {
				this.logger.debug(`refresh-tg-bot: B24 lookup failed for ${chatId}: ${e.message}`);
			}
			if (!b24Name) {
				no_b24++;
				continue;
			}

			const newName = `TG · ${botName} · ${b24Name}`.slice(0, 128);
			try {
				await this.botApi("editForumTopic", {
					chat_id: groupId,
					message_thread_id: topicId,
					name: newName,
				});
				renamed++;
			} catch (e: any) {
				const msg = String(e.message || "");
				if (msg.includes("TOPIC_NOT_MODIFIED")) {
					skipped_same++;
				} else {
					this.logger.warn(`refresh-tg-bot: editForumTopic failed for ${topicId}: ${msg}`);
					errors++;
				}
			}
			// Rate-limit 1 req/sec (TG group edits).
			await new Promise((r) => setTimeout(r, 1000));
		}
		this.logger.info(
			`refresh-tg-bot: finished total=${total} renamed=${renamed} ` +
			`skipped_same=${skipped_same} no_b24=${no_b24} errors=${errors}`,
		);

		return { total, renamed, skipped_same, no_b24, errors };
	}

	// Обратный поиск: по (groupId, topicId) → chatId клиента. Используется
	// для пути «оператор пишет в топике зеркала → отправить через бот
	// клиенту». Возвращает chatId или null если связь не найдена.
	async findChatIdByTopic(groupId: string, topicId: number): Promise<string | null> {
		await this.loadMap();
		const prefix = `${groupId}:`;
		for (const [k, tid] of Object.entries(this.state.topics)) {
			if (tid === topicId && k.startsWith(prefix)) {
				return k.slice(prefix.length);
			}
		}
		return null;
	}

	// Зеркалит входящее сообщение клиента в его топик. Медиа передаётся
	// проксированным URL (social.9wb.ru/media/…) — бот-зеркало скачивает
	// файл оттуда сам. mirrorGroupId — override группы для multi-bot:
	// для @begovoy_bot пусто (default из env), для @begovoy1support_bot
	// — отдельная группа «1Б Поддержка».
	async mirrorIncoming(input: {
		chatId: string; clientName: string; username: string;
		text: string; hasMedia: boolean;
		mediaUrl?: string; mediaName?: string; mediaIsImage?: boolean;
		mirrorGroupId?: string;
		botName?: string;
		lineId?: number;
	}): Promise<void> {
		if (!this.enabled) return;
		const groupId = input.mirrorGroupId || this.defaultGroupId;
		if (!groupId) return;
		const { chatId, username, hasMedia } = input;
		if (!chatId) return;
		try {
			const b24Name = await this.resolveB24Name(chatId);
			const displayName = b24Name || input.clientName;
			// Единый формат заголовка темы во всех каналах:
			// «<CHANNEL> · <SOURCE> · <CLIENT_NAME>». Для TG-бота:
			//   CHANNEL = TG; SOURCE = botName (`begovoy_bot` / `support_bot` без `1`).
			// Если botName неизвестен — fallback на голый «TG · <name>».
			const sourceTag = input.botName ? `${input.botName} · ` : "";
			const topicTitle = `TG · ${sourceTag}${displayName}`.slice(0, 128);
			const { topicId, created } = await this.findOrCreateTopic(
				groupId, chatId, topicTitle,
			);
			if (created) {
				void this.postClientCard(
					groupId, topicId, chatId, displayName, username,
					input.botName, input.lineId,
				);
			}
			const header = `👤 ${this.escapeHtml(displayName)}`;

			// Медиа — отдельным sendPhoto/sendDocument с подписью.
			if (input.mediaUrl) {
				const caption = `${header}${input.text ? "\n\n" + this.escapeHtml(input.text) : ""}`.slice(0, 1024);
				const method = input.mediaIsImage ? "sendPhoto" : "sendDocument";
				const field = input.mediaIsImage ? "photo" : "document";
				try {
					await this.botApi(method, {
						chat_id: groupId,
						message_thread_id: topicId,
						[field]: input.mediaUrl,
						caption,
						parse_mode: "HTML",
					});
					return;
				} catch (e: any) {
					this.logger.debug(`tg-bot-mirror: media post failed (${e.message}), fallback to text`);
				}
			}

			const body = input.text
				? this.escapeHtml(input.text)
				: (hasMedia ? "<i>[вложение]</i>" : "");
			const TEXT_MAX = 4096;
			let text = `${header}\n\n${body}`;
			if (text.length > TEXT_MAX) text = text.slice(0, TEXT_MAX - 1) + "…";
			await this.botApi("sendMessage", {
				chat_id: groupId,
				message_thread_id: topicId,
				text,
				parse_mode: "HTML",
				disable_web_page_preview: true,
			});
		} catch (e: any) {
			this.logger.error(`tg-bot-mirror: mirrorIncoming failed for ${chatId} in group ${groupId}: ${e.message}`);
		}
	}

	// Зеркалит исходящий ответ оператора в топик клиента. Топик создаётся
	// первым входящим; если оператор написал раньше клиента — топика ещё
	// нет, зеркало пропускаем (не критично, появится с первым входящим).
	async mirrorOutgoing(input: {
		chatId: string; text: string; operatorName?: string;
		mirrorGroupId?: string;
	}): Promise<void> {
		if (!this.enabled) return;
		const groupId = input.mirrorGroupId || this.defaultGroupId;
		if (!groupId) return;
		const { chatId } = input;
		if (!chatId) return;
		await this.loadMap();
		const topicId = this.state.topics[this.key(groupId, chatId)];
		if (!topicId) {
			this.logger.debug(`tg-bot-mirror: no topic for ${chatId} in group ${groupId}, skip outgoing mirror`);
			return;
		}
		try {
			const who = input.operatorName ? this.escapeHtml(input.operatorName) : "оператор";
			const TEXT_MAX = 4096;
			let text = `🧑‍💼 ${who} (B24)\n\n${this.escapeHtml(input.text)}`;
			if (text.length > TEXT_MAX) text = text.slice(0, TEXT_MAX - 1) + "…";
			await this.botApi("sendMessage", {
				chat_id: groupId,
				message_thread_id: topicId,
				text,
				parse_mode: "HTML",
				disable_web_page_preview: true,
			});
		} catch (e: any) {
			this.logger.error(`tg-bot-mirror: mirrorOutgoing failed for ${chatId} in group ${groupId}: ${e.message}`);
		}
	}
}
