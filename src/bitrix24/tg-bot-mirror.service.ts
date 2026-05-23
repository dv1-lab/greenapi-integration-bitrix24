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

	// Постит карточку клиента в топик (идемпотентно по (groupId,chatId)) + закрепляет.
	private async postClientCard(
		groupId: string, topicId: number, chatId: string, clientName: string, username: string,
	): Promise<void> {
		const ck = this.key(groupId, chatId);
		if (this.state.cardsPosted[ck]) return;
		const profileLink = username
			? `\nTelegram: <a href="https://t.me/${this.escapeHtml(username)}">@${this.escapeHtml(username)}</a>`
			: "";
		const text = `📋 Карточка клиента (Telegram)\n`
			+ `Имя: ${this.escapeHtml(clientName)}` + profileLink;
		try {
			const res = await this.botApi("sendMessage", {
				chat_id: groupId,
				message_thread_id: topicId,
				text,
				parse_mode: "HTML",
				disable_web_page_preview: true,
				disable_notification: true,
			});
			if (res?.message_id) {
				try {
					await this.botApi("pinChatMessage", {
						chat_id: groupId,
						message_id: res.message_id,
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
	}): Promise<void> {
		if (!this.enabled) return;
		const groupId = input.mirrorGroupId || this.defaultGroupId;
		if (!groupId) return;
		const { chatId, username, hasMedia } = input;
		if (!chatId) return;
		try {
			const b24Name = await this.resolveB24Name(chatId);
			const displayName = b24Name || input.clientName;
			const { topicId, created } = await this.findOrCreateTopic(
				groupId, chatId, `TG · ${displayName}`,
			);
			if (created) {
				void this.postClientCard(groupId, topicId, chatId, displayName, username);
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
