import { Controller, Get, Param, Res, HttpStatus } from "@nestjs/common";
import { Response } from "express";
import { MediaCacheService } from "./media-cache.service";

/**
 * Отдаёт B24 проксированное медиа. Adapter скачивает входящий файл из
 * Green API (Telegram/MAX-шарды, чьи download-URL B24 скачать не может) и
 * кладёт в MediaCacheService; B24 забирает файл отсюда — social.9wb.ru
 * B24 тянет без проблем. Публичный (без авторизации) — B24 ходит без
 * токена; id случайный 128-битный, медиа живёт 30 минут.
 */
@Controller("media")
export class MediaController {
	constructor(private readonly mediaCache: MediaCacheService) {}

	@Get(":file")
	serve(@Param("file") file: string, @Res() res: Response): void {
		const id = file.replace(/\.[^.]+$/, "");
		const item = this.mediaCache.get(id);
		if (!item) {
			res.status(HttpStatus.NOT_FOUND).send("media not found or expired");
			return;
		}
		res.set("Content-Type", item.contentType);
		res.set("Cache-Control", "public, max-age=3600");
		res.send(item.buffer);
	}
}
