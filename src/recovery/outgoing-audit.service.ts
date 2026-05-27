import { Injectable } from "@nestjs/common";
import { GreenApiLogger } from "@green-api/greenapi-integration";
import { PrismaService } from "../prisma/prisma.service";
import { Bitrix24Service } from "../bitrix24/bitrix24.service";

/**
 * Task #72 (Этап 1 / dry-run audit) — поиск операторских сообщений из
 * B24 которых нет в нашей `OutgoingMessage` таблице.
 *
 * Сценарий: my-server лежит (DDoS), оператор пишет из B24 → B24 шлёт
 * `ONIMCONNECTORMESSAGEADD` → adapter не отвечает → B24 retry 3-5 раз
 * → сдаётся. Сообщение «отправлено» в B24-UI, но клиент его не получил
 * (Green API/i2crm sendMessage не дёрнут).
 *
 * Этот сервис в **dry-run** режиме ходит в B24 за сообщениями операторов
 * за период и сравнивает с нашей `OutgoingMessage` (где `b24MessageId`
 * — B24 message id, проставляется только если ONIMCONNECTORMESSAGEADD
 * прошёл и мы отправили в Green API). Если в B24 есть operator-сообщение,
 * а у нас в `OutgoingMessage` нет — это **кандидат на «не доставлено
 * клиенту»**.
 *
 * Сейчас НЕ ретраит ничего, только возвращает отчёт. После аудита боевых
 * данных решаем нужен ли auto-retry (Этап 2).
 *
 * Ограничения MVP:
 *   - Анализируем только чаты, где у нас есть хоть один outgoing в
 *     OutgoingMessage за период (т.е. история переписки была). Чаты
 *     «впервые написали и потеряли всё» — не видим, у нас нет b24ChatId.
 *   - Сравнение по `b24MessageId` (целочисленный id сообщения в B24).
 */
@Injectable()
export class OutgoingAuditService {
	private readonly logger = GreenApiLogger.getInstance(OutgoingAuditService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly bitrix24Service: Bitrix24Service,
	) {}

	/** Главный метод аудита. dry-run по умолчанию, retry не делается. */
	async audit(options: { minutes?: number } = {}): Promise<{
		periodMinutes: number;
		ourB24ChatIds: number;
		dialogsScanned: number;
		dialogsFailed: number;
		operatorMessagesInB24: number;
		ourOutgoingRecords: number;
		potentialLoss: number;
		samples: Array<{ b24ChatId: string; b24MessageId: string; author: string; date: string; text: string }>;
	}> {
		const minutes = options.minutes ?? 1440;
		const cutoff = new Date(Date.now() - minutes * 60_000);
		this.logger.info(`outgoing-audit: starting (period=${minutes} min, cutoff=${cutoff.toISOString()})`);

		// 1. Все b24ChatId где у нас была активность за период.
		const chatRows: Array<{ b24ChatId: string | null }> = await (this.prisma as any).outgoingMessage.findMany({
			where: { createdAt: { gte: cutoff } },
			select: { b24ChatId: true },
			distinct: ["b24ChatId"],
		});
		const b24ChatIds = chatRows
			.map((r) => r.b24ChatId)
			.filter((v): v is string => !!v);

		// Все наши b24MessageId за период (одной выборкой, для быстрого set lookup).
		const ourRows: Array<{ b24MessageId: string | null }> = await (this.prisma as any).outgoingMessage.findMany({
			where: { createdAt: { gte: cutoff }, b24MessageId: { not: null } },
			select: { b24MessageId: true },
		});
		const ourMessageIds = new Set(
			ourRows.map((r) => r.b24MessageId).filter((v): v is string => !!v),
		);

		// 2. Найти portalDomain (один — у нас single-tenant портал 1begovoy).
		const users = await (this.prisma as any).user.findMany({ take: 1 });
		const portalDomain = users[0]?.portalDomain;
		if (!portalDomain) {
			this.logger.warn("outgoing-audit: no authorized portal, skip");
			return {
				periodMinutes: minutes,
				ourB24ChatIds: b24ChatIds.length,
				dialogsScanned: 0,
				dialogsFailed: 0,
				operatorMessagesInB24: 0,
				ourOutgoingRecords: ourMessageIds.size,
				potentialLoss: 0,
				samples: [],
			};
		}

		// 3. Для каждого chat — получить сообщения из B24, отфильтровать
		// operator (author_id != 0 и не сам ботообразный) за период,
		// сравнить с ourMessageIds.
		let dialogsScanned = 0;
		let dialogsFailed = 0;
		let operatorMessagesInB24 = 0;
		let potentialLoss = 0;
		const samples: Array<{ b24ChatId: string; b24MessageId: string; author: string; date: string; text: string }> = [];
		const SAMPLE_CAP = 20;

		for (const chatId of b24ChatIds) {
			try {
				// callBitrix24Method объявлен private в Bitrix24Service. Этот сервис —
				// часть adapter'а, нам нужен сетевой вызов B24 REST. Public-обёртки
				// (sendImconnectorMessage etc.) не подходят — нужен низкоуровневый.
				// `as any` обходит видимость; делаем только здесь.
				const result: any = await (this.bitrix24Service as any).callBitrix24Method(
					portalDomain,
					"im.dialog.messages.get",
					{ DIALOG_ID: `chat${chatId}`, LIMIT: 50 },
					undefined, 0, "social",
				);
				dialogsScanned++;
				const messages: any[] = Array.isArray(result?.messages)
					? result.messages
					: Array.isArray(result)
						? result
						: [];
				for (const m of messages) {
					if (!m || !m.id || m.author_id === 0) continue; // система
					const ts = m.date ? new Date(m.date).getTime() : 0;
					if (ts > 0 && ts < cutoff.getTime()) continue; // за окном
					operatorMessagesInB24++;
					const b24MessageId = String(m.id);
					if (ourMessageIds.has(b24MessageId)) continue; // у нас есть, всё ок
					// Не нашли — кандидат на «не доставлено»
					potentialLoss++;
					if (samples.length < SAMPLE_CAP) {
						samples.push({
							b24ChatId: chatId,
							b24MessageId,
							author: String(m.author_id || ""),
							date: String(m.date || ""),
							text: String(m.text || "").slice(0, 200),
						});
					}
				}
			} catch (e: any) {
				dialogsFailed++;
				this.logger.warn(
					`outgoing-audit: chat${chatId} failed: ${e?.message || e}`,
				);
			}
			// Rate-limit B24 (~0.5 req/sec на массовых)
			await new Promise((res) => setTimeout(res, 250));
		}

		this.logger.info(
			`outgoing-audit: done — chats=${b24ChatIds.length} scanned=${dialogsScanned} failed=${dialogsFailed} opMsgs=${operatorMessagesInB24} ourRecords=${ourMessageIds.size} potentialLoss=${potentialLoss}`,
		);

		return {
			periodMinutes: minutes,
			ourB24ChatIds: b24ChatIds.length,
			dialogsScanned,
			dialogsFailed,
			operatorMessagesInB24,
			ourOutgoingRecords: ourMessageIds.size,
			potentialLoss,
			samples,
		};
	}
}
