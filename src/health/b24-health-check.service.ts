import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { GreenApiLogger } from "@green-api/greenapi-integration";
import { PrismaService } from "../prisma/prisma.service";
import { Bitrix24Service } from "../bitrix24/bitrix24.service";
import { AlertsService } from "./alerts.service";

// 18.05 в wa-tg-bridge коннектор внезапно пропал из imconnector.list после
// OAuth-refresh — incoming молча перестали доходить в B24. Этот сервис ловит
// такие сбои здесь и для каждого User в БД проверяет:
//   1) social_connector присутствует в imconnector.list;
//   2) на каждой Instance.bitrixLine коннектор CONFIGURED+STATUS = true;
//   3) у каждого User есть хотя бы один Instance в БД (иначе outgoing мёртв).
//
// Алерт — edge-triggered: один раз при появлении проблемы и один раз при
// восстановлении. Ключи в `_alerted` совместимы с wa-tg-bridge моделью:
//   - "register:<portal>" — коннектор пропал из портала
//   - "line:<portal>:<line>" — линия не CONFIGURED/STATUS
//   - "instances:<portal>" — пусто Instance'ов в БД для портала
const CONNECTOR_ID = "social_connector";
const HEALTH_INTERVAL_MS = 60 * 60 * 1000; // раз в час
const FIRST_CHECK_DELAY_MS = 20 * 1000;     // 20с после startup

@Injectable()
export class B24HealthCheckService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = GreenApiLogger.getInstance(B24HealthCheckService.name);
	private readonly _alerted = new Set<string>();
	private _timer: NodeJS.Timeout | null = null;
	private _stopped = false;

	constructor(
		private readonly prisma: PrismaService,
		private readonly bitrix24: Bitrix24Service,
		private readonly alerts: AlertsService,
	) {}

	onModuleInit(): void {
		// Первая проверка через FIRST_CHECK_DELAY_MS — дать времени Bitrix24Service
		// и Prisma подключиться. Дальше — раз в час.
		setTimeout(() => this._scheduleNext(), FIRST_CHECK_DELAY_MS);
	}

	onModuleDestroy(): void {
		this._stopped = true;
		if (this._timer) clearTimeout(this._timer);
	}

	private _scheduleNext(): void {
		if (this._stopped) return;
		void this._runOnce().finally(() => {
			if (this._stopped) return;
			this._timer = setTimeout(() => this._scheduleNext(), HEALTH_INTERVAL_MS);
		});
	}

	private async _runOnce(): Promise<void> {
		try {
			const users = await this.prisma.user.findMany();
			let allRegistered = true;
			let totalInstances = 0;
			for (const user of users) {
				const instances = await this._checkOnePortal(user);
				totalInstances += instances;
				if (this._alerted.has(this._regKey(user.portalDomain))) {
					allRegistered = false;
				}
			}
			this.logger.info(
				`health-check: connector=${allRegistered}, ${users.length} portals with ${totalInstances} instances total`,
			);
		} catch (e: any) {
			this.logger.error(`health-check iteration failed: ${e?.message || e}`);
		}
	}

	private _regKey(portal: string): string {
		return `register:${portal}`;
	}

	private _lineKey(portal: string, line: number): string {
		return `line:${portal}:${line}`;
	}

	private _instancesKey(portal: string): string {
		return `instances:${portal}`;
	}

	/** Возвращает количество Instance'ов у портала (для итогового лога). */
	private async _checkOnePortal(user: { id: string; portalDomain: string }): Promise<number> {
		const portal = user.portalDomain;

		// 1) Проверка наличия Instance'ов в БД (задача 2).
		const instCount = await this.prisma.instance.count({ where: { userId: user.id } });
		const instKey = this._instancesKey(portal);
		if (instCount === 0 && !this._alerted.has(instKey)) {
			this._alerted.add(instKey);
			await this.alerts.send(
				`🚨 GREEN-API instances пусты для portal ${portal} — outgoing работать не будет. ` +
				`Runbook: проверить ONIMCONNECTORMESSAGEADD логи или переустановить приложение.`,
			);
		} else if (instCount > 0 && this._alerted.has(instKey)) {
			this._alerted.delete(instKey);
			await this.alerts.send(`✅ portal ${portal}: появились Instance'ы (${instCount} шт) — outgoing восстановлен`);
		}

		// 2) Проверка регистрации коннектора (задача 1, часть 1).
		let connectors: string[];
		try {
			connectors = await this.bitrix24.listConnectors(portal);
		} catch (e: any) {
			this.logger.error(`health-check: listConnectors failed for ${portal}: ${e?.message || e}`);
			return instCount;
		}
		const registered = connectors.includes(CONNECTOR_ID);
		const regKey = this._regKey(portal);
		if (!registered && !this._alerted.has(regKey)) {
			this._alerted.add(regKey);
			await this.alerts.send(
				`🚨 коннектор «${CONNECTOR_ID}» не зарегистрирован в B24 (portal ${portal}, ` +
				`imconnector.list его не содержит). WA/MAX/TG incoming НЕ доходят в B24. ` +
				`Runbook: imconnector.register + imconnector.activate.`,
			);
			// При отсутствии регистрации проверять status бессмысленно — Б24 вернёт ошибку.
			return instCount;
		} else if (registered && this._alerted.has(regKey)) {
			this._alerted.delete(regKey);
			await this.alerts.send(
				`✅ коннектор «${CONNECTOR_ID}» (portal ${portal}) снова в imconnector.list — incoming в B24 восстановлены`,
			);
		}

		// 3) Проверка status на каждой Instance.bitrixLine (задача 1, часть 2).
		const lined = await this.prisma.instance.findMany({
			where: { userId: user.id, NOT: { bitrixLine: null } },
			select: { idInstance: true, bitrixLine: true, settings: true },
		});
		for (const inst of lined) {
			if (inst.bitrixLine == null) continue;
			const line = inst.bitrixLine;
			const lineKey = this._lineKey(portal, line);
			let status: { CONFIGURED?: boolean; STATUS?: boolean };
			try {
				status = await this.bitrix24.getConnectorStatus(portal, line, CONNECTOR_ID);
			} catch (e: any) {
				this.logger.error(`health-check: status failed for ${portal} line=${line}: ${e?.message || e}`);
				continue;
			}
			const configured = !!status.CONFIGURED;
			const connected = !!status.STATUS;
			const healthy = configured && connected;
			const label = ((inst.settings as any)?.label as string) || `Instance ${inst.idInstance}`;

			if (!healthy && !this._alerted.has(lineKey)) {
				this._alerted.add(lineKey);
				await this.alerts.send(
					`🚨 линия B24 #${line} (${label}, portal ${portal}): CONFIGURED=${configured}, STATUS=${connected}. ` +
					`Сообщения из ${label} не попадают в B24. ` +
					`Восстановить: imconnector.activate CONNECTOR=${CONNECTOR_ID} LINE=${line} ACTIVE=1`,
				);
			} else if (healthy && this._alerted.has(lineKey)) {
				this._alerted.delete(lineKey);
				await this.alerts.send(`✅ линия B24 #${line} (${label}, portal ${portal}) снова активна`);
			}
		}

		return instCount;
	}
}
