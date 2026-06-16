/**
 * Smoke-тесты handleI2crmIncoming / handleOutgoingMessageStatus через
 * NestJS DI mock. Цель — early-return защита (валидация payload, ранние
 * ветки) без покрытия orchestrator-логики (та покрыта через pure-helpers
 * в src/common/i2crm-payload.spec.ts и outgoing-status.spec.ts).
 *
 * Связано:
 *  - docs/TESTING.md — стратегия
 *  - docs/PRODUCT_RULES.md — что мы защищаем
 *  - docs/REGRESSIONS.md — список инцидентов
 */

import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { Bitrix24Service } from "./bitrix24.service";
import { Bitrix24Transformer } from "./bitrix24.transformer";
import { PrismaService } from "../prisma/prisma.service";
import { I2crmTgMirrorService } from "./i2crm-tg-mirror.service";
import { TgBotMirrorService } from "./tg-bot-mirror.service";
import { MediaCacheService } from "./media-cache.service";
import { B24MetricsService } from "../common/b24-metrics.service";

// Минимальный mock Prisma — все методы, которые могут вызваться в early-paths
// handleI2crmIncoming / handleOutgoingMessageStatus, возвращают пустоту
// (or undefined). Если тест прорвался дальше — Prisma поднимет throw на
// отсутствующий метод, и тест упадёт. Это намеренно — индикатор «мы не
// должны были тут оказаться».
const mockPrisma = () => ({
	i2crmEventLog: {
		upsert: jest.fn().mockResolvedValue(undefined),
	},
	user: {
		findMany: jest.fn().mockResolvedValue([]),
	},
	outgoingMessage: {
		findUnique: jest.fn().mockResolvedValue(null),
		delete: jest.fn().mockResolvedValue(undefined),
		update: jest.fn().mockResolvedValue(undefined),
		// deleteMany — вдруг сработает фоновый cleanup (защита если NODE_ENV
		// не выставлен в test mode jest'ом).
		deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
	},
	igCommentContext: {
		upsert: jest.fn().mockResolvedValue(undefined),
	},
	offHoursReply: {
		findUnique: jest.fn().mockResolvedValue(null),
		upsert: jest.fn().mockResolvedValue(undefined),
	},
	findUser: jest.fn().mockResolvedValue(null),
});

// Mock ConfigService — возвращает по умолчанию undefined (для I2CRM_LINE_ID_*
// undefined → Number(undefined) = NaN → !lineId → service returns
// success:false reason:"... not configured").
const mockConfig = () => ({
	get: jest.fn().mockReturnValue(undefined),
});

const mockMirror = () => ({
	mirrorIncoming: jest.fn().mockResolvedValue(undefined),
	mirrorOutgoing: jest.fn().mockResolvedValue(undefined),
});

const mockMediaCache = () => ({
	get: jest.fn().mockResolvedValue(null),
	put: jest.fn().mockResolvedValue(undefined),
});

const mockTransformer = () => ({
	// Минимальные методы — BaseAdapter ожидает transformer для входящих,
	// но в early-paths не вызываем. NotebookEdit может вылезти если тест
	// прорвался — это сигнал что mock недостаточный.
	toPlatformMessage: jest.fn(),
	toGreenApiMessage: jest.fn(),
});

async function buildService(overrides?: {
	prisma?: any;
	config?: any;
	i2crmMirror?: any;
	tgBotMirror?: any;
	mediaCache?: any;
}): Promise<Bitrix24Service> {
	const prisma = overrides?.prisma || mockPrisma();
	const config = overrides?.config || mockConfig();
	const i2crmMirror = overrides?.i2crmMirror || mockMirror();
	const tgBotMirror = overrides?.tgBotMirror || mockMirror();
	const mediaCache = overrides?.mediaCache || mockMediaCache();
	const transformer = mockTransformer();

	const moduleRef = await Test.createTestingModule({
		providers: [
			Bitrix24Service,
			{ provide: Bitrix24Transformer, useValue: transformer },
			{ provide: PrismaService, useValue: prisma },
			{ provide: ConfigService, useValue: config },
			{ provide: I2crmTgMirrorService, useValue: i2crmMirror },
			{ provide: TgBotMirrorService, useValue: tgBotMirror },
			{ provide: MediaCacheService, useValue: mediaCache },
			{ provide: B24MetricsService, useValue: { record: jest.fn() } },
		],
	}).compile();

	return moduleRef.get<Bitrix24Service>(Bitrix24Service);
}

// =====================================================================
// handleI2crmIncoming — early-return paths
// =====================================================================
describe("Bitrix24Service.handleI2crmIncoming (early returns)", () => {
	let service: Bitrix24Service;

	beforeEach(async () => {
		service = await buildService();
	});

	afterEach(() => {
		// Останавливаем интервалы из constructor (cleanup + token-refresh),
		// чтобы Jest не задерживал процесс из-за активных timers.
		service.onModuleDestroy();
	});

	it("payload.incoming=false (эхо outgoing) → success:true, reason:outgoing-echo-ignored", async () => {
		const r = await service.handleI2crmIncoming({
			incoming: false,
			channel: "instdir",
			client_id: "1",
			message_id: "m",
		});
		expect(r).toEqual({ success: true, reason: "outgoing-echo-ignored" });
	});

	it("без client_id → success:false", async () => {
		const r = await service.handleI2crmIncoming({
			channel: "instdir",
			message_id: "m",
		});
		expect(r.success).toBe(false);
		expect(r.reason).toMatch(/missing/);
	});

	it("без message_id → success:false", async () => {
		const r = await service.handleI2crmIncoming({
			channel: "instdir",
			client_id: "1",
		});
		expect(r.success).toBe(false);
		expect(r.reason).toMatch(/missing/);
	});

	it("неподдерживаемый channel → success:false", async () => {
		const r = await service.handleI2crmIncoming({
			channel: "telegram",
			client_id: "1",
			message_id: "m",
		});
		expect(r.success).toBe(false);
		expect(r.reason).toMatch(/unsupported channel/);
	});

	it("LINE id не настроен в env → success:false, reason: ... not configured", async () => {
		// ConfigService.get возвращает undefined по умолчанию (default mock).
		const r = await service.handleI2crmIncoming({
			channel: "instdir",
			client_id: "123",
			message_id: "m1",
		});
		expect(r.success).toBe(false);
		expect(r.reason).toMatch(/I2CRM_LINE_ID_IG_DIRECT not configured/);
	});

	it("LINE id настроен, но в БД нет user (нет портала) → success:false, reason:no-user", async () => {
		const prisma = mockPrisma();
		const config = {
			get: jest.fn((key: string) =>
				key === "I2CRM_LINE_ID_IG_DIRECT" ? "42" : undefined,
			),
		};
		const svc = await buildService({ prisma, config });
		try {
			const r = await svc.handleI2crmIncoming({
				channel: "instdir",
				client_id: "123",
				message_id: "m1",
			});
			expect(r.success).toBe(false);
			expect(r.reason).toBe("no-user");
		} finally {
			svc.onModuleDestroy();
		}
	});

	it("instcom (комментарии) — env-key I2CRM_LINE_ID_IG_COMMENT", async () => {
		const config = {
			get: jest.fn().mockReturnValue(undefined),
		};
		const svc = await buildService({ config });
		try {
			const r = await svc.handleI2crmIncoming({
				channel: "instcom",
				client_id: "123",
				message_id: "m1",
				media_id: "post-xyz",
			});
			expect(r.success).toBe(false);
			// Должно ругаться именно на COMMENT env, не DIRECT
			expect(r.reason).toMatch(/I2CRM_LINE_ID_IG_COMMENT not configured/);
		} finally {
			svc.onModuleDestroy();
		}
	});

	it("i2crmEventLog.upsert вызывается ДО проверки LINE/user — событие журналируется даже если потом fail", async () => {
		const prisma = mockPrisma();
		const svc = await buildService({ prisma });
		try {
			await svc.handleI2crmIncoming({
				channel: "instdir",
				client_id: "999",
				message_id: "msg-test-1",
			});
			// Журналирование должно произойти ДО return success:false (см. PRODUCT_RULES:
			// «событие в журнал всегда, replay через /webhooks/internal/i2crm-replay»).
			expect(prisma.i2crmEventLog.upsert).toHaveBeenCalledTimes(1);
			const call = prisma.i2crmEventLog.upsert.mock.calls[0][0];
			expect(call.where.messageId).toBe("msg-test-1");
			expect(call.create.clientId).toBe("999");
			expect(call.create.channel).toBe("instdir");
			expect(call.create.incoming).toBe(true);
			expect(call.create.status).toBe("pending");
		} finally {
			svc.onModuleDestroy();
		}
	});

	it("payload=null → не падает, success:false", async () => {
		const r = await service.handleI2crmIncoming(null);
		expect(r.success).toBe(false);
	});

	it("payload={} → не падает, success:false (отсутствует channel/client_id)", async () => {
		const r = await service.handleI2crmIncoming({});
		expect(r.success).toBe(false);
	});
});

// =====================================================================
// handleOutgoingMessageStatus — early-return paths
// =====================================================================
describe("Bitrix24Service.handleOutgoingMessageStatus (early returns)", () => {
	let service: Bitrix24Service;
	let prisma: ReturnType<typeof mockPrisma>;

	beforeEach(async () => {
		prisma = mockPrisma();
		service = await buildService({ prisma });
	});

	afterEach(() => {
		service.onModuleDestroy();
	});

	it("без idMessage → ранний return, БД не запрашивается", async () => {
		await service.handleOutgoingMessageStatus({ status: "delivered" });
		expect(prisma.outgoingMessage.findUnique).not.toHaveBeenCalled();
	});

	it("status='pending' (не sent/delivered/read) → ранний return", async () => {
		await service.handleOutgoingMessageStatus({
			idMessage: "abc",
			status: "pending",
		});
		expect(prisma.outgoingMessage.findUnique).not.toHaveBeenCalled();
	});

	it("status='noAccount' (не наш статус) → ранний return", async () => {
		await service.handleOutgoingMessageStatus({
			idMessage: "abc",
			status: "noAccount",
		});
		expect(prisma.outgoingMessage.findUnique).not.toHaveBeenCalled();
	});

	it("idMessage не найден в OutgoingMessage → return без crash, B24 не дёргается", async () => {
		prisma.outgoingMessage.findUnique.mockResolvedValueOnce(null);
		await service.handleOutgoingMessageStatus({
			idMessage: "not-in-db",
			status: "delivered",
		});
		expect(prisma.outgoingMessage.findUnique).toHaveBeenCalledWith({
			where: { idMessage: "not-in-db" },
		});
		// Никаких update/delete — записи нет
		expect(prisma.outgoingMessage.delete).not.toHaveBeenCalled();
		expect(prisma.outgoingMessage.update).not.toHaveBeenCalled();
	});

	it("запись истекла → delete + return", async () => {
		const expired = new Date(Date.now() - 25 * 3600 * 1000); // 25ч назад
		prisma.outgoingMessage.findUnique.mockResolvedValueOnce({
			idMessage: "abc",
			expiresAt: expired,
			lastStatusSeen: null,
			connector: "whatsapp",
			line: 1,
			b24ChatId: "1",
			b24MessageId: "1",
			externalChatId: "wa_+79000000000",
		});
		await service.handleOutgoingMessageStatus({
			idMessage: "abc",
			status: "delivered",
		});
		expect(prisma.outgoingMessage.delete).toHaveBeenCalledWith({
			where: { idMessage: "abc" },
		});
	});

	it("dedup: lastStatusSeen=read, incoming=delivered → skip (никаких update/delete)", async () => {
		const future = new Date(Date.now() + 3600 * 1000); // через час
		prisma.outgoingMessage.findUnique.mockResolvedValueOnce({
			idMessage: "abc",
			expiresAt: future,
			lastStatusSeen: "read",
			connector: "whatsapp",
			line: 1,
			b24ChatId: "1",
			b24MessageId: "1",
			externalChatId: "wa_+79000000000",
		});
		await service.handleOutgoingMessageStatus({
			idMessage: "abc",
			status: "delivered",
		});
		// dedup — никаких изменений, никаких B24 вызовов
		expect(prisma.outgoingMessage.update).not.toHaveBeenCalled();
		expect(prisma.outgoingMessage.delete).not.toHaveBeenCalled();
	});

	it("dedup: lastStatusSeen=delivered, incoming=sent → skip (откат не апплаим)", async () => {
		const future = new Date(Date.now() + 3600 * 1000);
		prisma.outgoingMessage.findUnique.mockResolvedValueOnce({
			idMessage: "abc",
			expiresAt: future,
			lastStatusSeen: "delivered",
			connector: "whatsapp",
			line: 1,
			b24ChatId: "1",
			b24MessageId: "1",
			externalChatId: "wa_+79000000000",
		});
		await service.handleOutgoingMessageStatus({
			idMessage: "abc",
			status: "sent",
		});
		expect(prisma.outgoingMessage.update).not.toHaveBeenCalled();
	});

	it("нет user в БД → return (нечего форвардить)", async () => {
		const future = new Date(Date.now() + 3600 * 1000);
		prisma.outgoingMessage.findUnique.mockResolvedValueOnce({
			idMessage: "abc",
			expiresAt: future,
			lastStatusSeen: null,
			connector: "whatsapp",
			line: 1,
			b24ChatId: "1",
			b24MessageId: "1",
			externalChatId: "wa_+79000000000",
		});
		// findMany возвращает [] по дефолту — нет user
		await service.handleOutgoingMessageStatus({
			idMessage: "abc",
			status: "delivered",
		});
		// Не падаем, B24 не дёргаем (callBitrix24Method не должен быть вызван)
		expect(prisma.outgoingMessage.update).not.toHaveBeenCalled();
		expect(prisma.outgoingMessage.delete).not.toHaveBeenCalled();
	});

	it("webhook=null → не падает", async () => {
		await expect(service.handleOutgoingMessageStatus(null)).resolves.toBeUndefined();
		expect(prisma.outgoingMessage.findUnique).not.toHaveBeenCalled();
	});

	it("webhook={} → не падает", async () => {
		await expect(service.handleOutgoingMessageStatus({})).resolves.toBeUndefined();
		expect(prisma.outgoingMessage.findUnique).not.toHaveBeenCalled();
	});
});

// =====================================================================
// Orphan-lead linker: chat_id из активности сессии (fix #362196, 04.06)
// =====================================================================
describe("Bitrix24Service orphan-link chatId resolution", () => {
	let service: Bitrix24Service;

	beforeEach(async () => {
		service = await buildService();
	});
	afterEach(() => service.onModuleDestroy());

	describe("_parseSessionUserCode (pure)", () => {
		const cases: Array<[string, { line: number; chatId: string; prefix: string } | null]> = [
			["social_connector|204|sc_6215338890|153922", { line: 204, chatId: "6215338890", prefix: "sc_" }],
			["social_connector|148|wa_79001234567|999", { line: 148, chatId: "79001234567", prefix: "wa_" }],
			["social_connector|178|123456789|55", { line: 178, chatId: "123456789", prefix: "" }],
			["social_connector|18|i2crm_ig_27986508|3", { line: 18, chatId: "27986508", prefix: "i2crm_ig_" }],
			["", null],
			["garbage-no-pipes", null],
			["i2crm|18|inst-555-777|3", null], // legacy i2crm-код, не наш connector
			["social_connector|204|sc_abc|5", null], // userKey без хвостовых цифр
		];
		it.each(cases)("%s", (code, expected) => {
			expect((service as any)._parseSessionUserCode(code)).toEqual(expected);
		});
	});

	describe("_parseOrphanLeadTitle — корень бага", () => {
		it("кириллическое имя в TITLE НЕ даёт валидный chatId (Telegram senderName)", () => {
			const parsed = (service as any)._parseOrphanLeadTitle("Николай - Telegram Office +7 924 077-85-66");
			const valid = parsed && (service as any)._isValidChatId(parsed.chatId);
			expect(valid).toBeFalsy();
		});
		it("native-формат с chat_id всё ещё парсится (без регрессии)", () => {
			const parsed = (service as any)._parseOrphanLeadTitle("32656502 - MAX 79584983354");
			expect(parsed?.chatId).toBe("32656502");
			expect((service as any)._isValidChatId(parsed.chatId)).toBe(true);
		});
	});

	describe("_resolveOrphanChatFromActivity (fallback)", () => {
		it("Telegram-сессия → chatId без префикса + channelLabel из provider инстанса", async () => {
			const prisma = mockPrisma();
			(prisma as any).instance = {
				findFirst: jest.fn().mockResolvedValue({ bitrixLine: 204, settings: { provider: "telegram" } }),
			};
			service = await buildService({ prisma });
			jest.spyOn(service as any, "callBitrix24Method").mockResolvedValue([
				{ ID: "1310156", PROVIDER_PARAMS: { USER_CODE: "social_connector|204|sc_6215338890|153922" } },
			]);
			const r = await (service as any)._resolveOrphanChatFromActivity("p.bitrix24.ru", 362196);
			expect(r).toEqual({ chatId: "6215338890", channelLabel: "Telegram" });
		});

		it("нет IMOPENLINES_SESSION активности → null", async () => {
			service = await buildService();
			jest.spyOn(service as any, "callBitrix24Method").mockResolvedValue([]);
			const r = await (service as any)._resolveOrphanChatFromActivity("p.bitrix24.ru", 999);
			expect(r).toBeNull();
		});
	});
});

// =====================================================================
// Я.Метрика ClientID органического первого обращения (ADR 2026-06-16)
// Баг: новый клиент пишет в Telegram → контакта в B24 нет →
// ensureOpenLeadForPhone выходит, ClientID теряется. Фикс: стэш по chatId +
// дозапись в созданный лид через _maybeLinkOrphanLead (ONCRMLEADADD).
// =====================================================================
describe("Bitrix24Service pending Я.Метрика ClientID", () => {
	let service: Bitrix24Service;

	beforeEach(async () => {
		const prisma = mockPrisma();
		(prisma as any).instance = { findFirst: jest.fn().mockResolvedValue(null) };
		service = await buildService({ prisma });
	});
	afterEach(() => service.onModuleDestroy());

	describe("stash/take (pure)", () => {
		it("stash → take возвращает значение, повторный take — undefined", () => {
			(service as any).stashPendingYmClientId("553546236", "1781547537199768487");
			expect((service as any).takePendingYmClientId("553546236")).toBe("1781547537199768487");
			expect((service as any).takePendingYmClientId("553546236")).toBeUndefined();
		});
		it("неизвестный chatId → undefined", () => {
			expect((service as any).takePendingYmClientId("nope")).toBeUndefined();
		});
	});

	describe("_maybeLinkOrphanLead дозаписывает YA_CID из стэша", () => {
		const snapBase = {
			ID: "362976",
			TITLE: "553546236 - Telegram 79584983354",
			CONTACT_ID: null,
			UF_CRM_TG_CHAT_ID: "",
		};

		it("новый клиент без контакта: пишет UF_CRM_YA_CID + счётчик в лид", async () => {
			(service as any).stashPendingYmClientId("553546236", "1781547537199768487");
			const calls: any[] = [];
			jest.spyOn(service as any, "callBitrix24Method").mockImplementation(
				async (_d: string, method: string, params: any) => {
					calls.push({ method, params });
					if (method === "crm.contact.list") return []; // контакт не найден
					return {};
				},
			);
			const res = await (service as any)._maybeLinkOrphanLead(
				"p.bitrix24.ru", 362976, { ...snapBase, UF_CRM_YA_CID: "" },
			);
			const yaWrite = calls.find(
				(c) => c.method === "crm.lead.update" && c.params?.fields?.UF_CRM_YA_CID,
			);
			expect(yaWrite).toBeDefined();
			expect(yaWrite.params.id).toBe(362976);
			expect(yaWrite.params.fields.UF_CRM_YA_CID).toBe("1781547537199768487");
			expect(yaWrite.params.fields.UF_CRM_YA_COUNTER_ID).toBe("45469563");
			// контакта нет → линковки нет, но ClientID записан
			expect(res.linked).toBe(false);
		});

		it("UF_CRM_YA_CID уже заполнен → не перетираем", async () => {
			(service as any).stashPendingYmClientId("553546236", "999");
			const calls: any[] = [];
			jest.spyOn(service as any, "callBitrix24Method").mockImplementation(
				async (_d: string, method: string, params: any) => {
					calls.push({ method, params });
					if (method === "crm.contact.list") return [];
					return {};
				},
			);
			await (service as any)._maybeLinkOrphanLead(
				"p.bitrix24.ru", 362976, { ...snapBase, UF_CRM_YA_CID: "1781547537199768487" },
			);
			const yaWrite = calls.find(
				(c) => c.method === "crm.lead.update" && c.params?.fields?.UF_CRM_YA_CID,
			);
			expect(yaWrite).toBeUndefined();
		});

		it("стэш пуст → YA_CID не пишем", async () => {
			const calls: any[] = [];
			jest.spyOn(service as any, "callBitrix24Method").mockImplementation(
				async (_d: string, method: string, params: any) => {
					calls.push({ method, params });
					if (method === "crm.contact.list") return [];
					return {};
				},
			);
			await (service as any)._maybeLinkOrphanLead(
				"p.bitrix24.ru", 362976, { ...snapBase, UF_CRM_YA_CID: "" },
			);
			const yaWrite = calls.find(
				(c) => c.method === "crm.lead.update" && c.params?.fields?.UF_CRM_YA_CID,
			);
			expect(yaWrite).toBeUndefined();
		});
	});
});
