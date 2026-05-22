import { Injectable } from "@nestjs/common";
import { randomBytes } from "crypto";
import { GreenApiLogger } from "@green-api/greenapi-integration";

interface CachedMedia {
	buffer: Buffer;
	contentType: string;
	expiresAt: number;
}

/**
 * In-memory кэш медиа для проксирования входящих файлов через social.9wb.ru.
 *
 * Зачем: B24 (imconnector.send.messages с files[]) скачивает файл сам по
 * ссылке. Медиа-URL Telegram/MAX-шардов Green API
 * (`<shard>.api.green-api.com/download/...`) B24 со своих серверов скачать
 * НЕ может — висит ~20 c и отвечает «Переданы не все необходимые данные»
 * (URL для WhatsApp — публичное хранилище yandexcloud — работает).
 * Решение: adapter скачивает файл сам и кладёт сюда, а B24 даём ссылку на
 * себя — social.9wb.ru B24 тянет без проблем.
 *
 * TTL короткий: B24 забирает файл за считанные секунды после send.messages.
 */
@Injectable()
export class MediaCacheService {
	private readonly logger = GreenApiLogger.getInstance(MediaCacheService.name);
	private readonly cache = new Map<string, CachedMedia>();
	private readonly ttlMs = 30 * 60 * 1000; // 30 минут

	store(buffer: Buffer, contentType: string): string {
		this.evictExpired();
		const id = randomBytes(16).toString("hex");
		this.cache.set(id, { buffer, contentType, expiresAt: Date.now() + this.ttlMs });
		return id;
	}

	get(id: string): CachedMedia | null {
		const item = this.cache.get(id);
		if (!item) return null;
		if (Date.now() > item.expiresAt) {
			this.cache.delete(id);
			return null;
		}
		return item;
	}

	private evictExpired(): void {
		const now = Date.now();
		for (const [k, v] of this.cache) {
			if (now > v.expiresAt) this.cache.delete(k);
		}
	}
}
