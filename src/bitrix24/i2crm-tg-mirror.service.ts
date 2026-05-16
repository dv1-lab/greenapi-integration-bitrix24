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
@Injectable()
interface MirrorState {
	topics: Record<string, number>;       // clientId → topic_id
	cardsPosted: Record<string, true>;    // leadId → true (карточка клиента уже постилась)
}

export class I2crmTgMirrorService {
	private readonly logger = GreenApiLogger.getInstance(I2crmTgMirrorService.name);
	private readonly botToken: string | undefined;
	private readonly groupId: string | undefined;
	private readonly mapPath: string;
	private state: MirrorState = { topics: {}, cardsPosted: {} };
	private mapLoaded = false;
	private writeLock: Promise<void> = Promise.resolve();

	constructor(private readonly configService: ConfigService) {
		this.botToken = this.configService.get<string>("TG_MIRROR_BOT_TOKEN");
		this.groupId = this.configService.get<string>("I2CRM_TG_MIRROR_GROUP_ID");
		this.mapPath = this.configService.get<string>("I2CRM_TG_MIRROR_TOPIC_MAP") || "/app/data/i2crm-topics.json";
	}

	get enabled(): boolean {
		return !!(this.botToken && this.groupId);
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
					};
				} else {
					this.state = { topics: parsed || {}, cardsPosted: {} };
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

	private async createTopic(clientId: string, name: string): Promise<number> {
		const result = await this.botApi("createForumTopic", {
			chat_id: this.groupId,
			name: name.slice(0, 128),
		});
		const topicId = result.message_thread_id;
		this.state.topics[clientId] = topicId;
		await this.persistMap();
		this.logger.info(`tg-mirror: created topic ${topicId} for client ${clientId} (${name})`);
		return topicId;
	}

	private async findOrCreateTopic(clientId: string, name: string): Promise<number> {
		await this.loadMap();
		if (this.state.topics[clientId]) return this.state.topics[clientId];
		return this.createTopic(clientId, name);
	}

	private buildCaption(payload: any): string {
		const clientName = payload?.client_name || `IG_${payload?.client_id}`;
		const username = payload?.client_username;
		const channel = String(payload?.channel || "");
		const isComment = channel === "instcom";
		const channelLabel = isComment ? "📷 Instagram коммент" : "💬 Instagram Direct";
		const header = username ? `${clientName} (@${username})` : clientName;
		const postCtx = isComment && payload?.post_url ? `\nК посту: ${payload.post_url}` : "";
		const text = payload?.text ? `\n\n${payload.text}` : "";
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
		const username = payload?.client_username;
		const clientName = payload?.client_name || username || `IG_${clientId}`;
		const topicName = username ? `@${username}` : clientName;

		try {
			const topicId = await this.findOrCreateTopic(clientId, topicName);
			const caption = this.buildCaption(payload);
			const mediaUrl = payload?.media_url || payload?.media?.url;
			const type = String(payload?.type || "text");

			if (mediaUrl && (type === "image" || type === "photo")) {
				await this.botApi("sendPhoto", {
					chat_id: this.groupId,
					message_thread_id: topicId,
					photo: mediaUrl,
					caption,
				});
			} else if (mediaUrl && type === "video") {
				await this.botApi("sendVideo", {
					chat_id: this.groupId,
					message_thread_id: topicId,
					video: mediaUrl,
					caption,
				});
			} else {
				await this.botApi("sendMessage", {
					chat_id: this.groupId,
					message_thread_id: topicId,
					text: caption,
					disable_web_page_preview: false,
				});
			}
			this.logger.info(`tg-mirror: mirrored msg to topic ${topicId} (client=${clientId})`);
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

		const topicId = this.state.topics[input.clientId];
		if (!topicId) {
			this.logger.warn(`tg-mirror: no topic for client ${input.clientId}, cannot post card`);
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
				chat_id: this.groupId,
				message_thread_id: topicId,
				text,
				parse_mode: "HTML",
				disable_web_page_preview: true,
				disable_notification: true,
			});
			this.state.cardsPosted[leadKey] = true;
			await this.persistMap();
			this.logger.info(`tg-mirror: posted client card for lead ${leadKey} → topic ${topicId}`);
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
}
