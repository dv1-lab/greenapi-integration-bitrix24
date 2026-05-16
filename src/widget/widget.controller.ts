import { All, Body, Controller, Get, HttpException, HttpStatus, Post, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request, Response } from "express";
import axios from "axios";
import { PrismaService } from "../prisma/prisma.service";

// Карта префикса idInstance → API URL Green API. У свежих instance shard в host'е,
// у старых (вроде 1101948511) — общий api.green-api.com.
function greenApiUrl(idInstance: string): string {
	const known: Record<string, string> = {
		"1103487233": "https://1103.api.green-api.com",
		"1101948511": "https://api.green-api.com",
		"3100621187": "https://3100.api.green-api.com",
		"4100621194": "https://4100.api.green-api.com",
	};
	return known[idInstance] || "https://api.green-api.com";
}

@Controller("widget")
export class WidgetController {
	constructor(
		private readonly config: ConfigService,
		private readonly prisma: PrismaService,
	) {}

	@Get("instances")
	async listInstances() {
		// Используется фронтендом виджета — список доступных инстансов для выбора.
		const insts = await this.prisma.instance.findMany({
			select: { idInstance: true, bitrixLine: true, stateInstance: true, settings: true },
		});
		return insts.map(i => ({
			idInstance: i.idInstance.toString(),
			bitrixLine: i.bitrixLine,
			stateInstance: i.stateInstance,
			label: (i.settings as any)?.label || `Instance ${i.idInstance}`,
			provider: ((i.settings as any)?.provider || "wa"),
		}));
	}

	@Get("entity-phone")
	async getEntityPhone(
		@Req() req: Request,
	): Promise<{ phone: string | null }> {
		const portal = String(req.query.portal || "");
		const type = String(req.query.type || "");
		const id = String(req.query.id || "");
		if (!portal || !type || !id) return { phone: null };
		const phone = await this.prisma.getEntityPhonePref(portal, type, id);
		return { phone };
	}

	@Post("entity-phone")
	async setEntityPhone(
		@Body() body: { portal?: string; type?: string; id?: string; phone?: string },
	): Promise<{ ok: boolean }> {
		if (!body?.portal || !body?.type || !body?.id || !body?.phone) {
			throw new HttpException("portal, type, id, phone required", HttpStatus.BAD_REQUEST);
		}
		await this.prisma.setEntityPhonePref(body.portal, body.type, body.id, body.phone);
		return { ok: true };
	}

	// B24 placement шлёт POST с form-data, прямой переход из браузера — GET.
	// Принимаем оба через @All, кроме POST /widget/send (см. ниже).
	@All("send-first")
	render(@Req() req: Request, @Body() body: any, @Res() res: Response) {
		res.setHeader("X-Frame-Options", "ALLOWALL");
		res.setHeader("Content-Security-Policy", "frame-ancestors *");
		// B24 при открытии placement шлёт в body AUTH_ID/REFRESH_ID/DOMAIN — это
		// свежий OAuth-токен Social Connector app, валиден ~1 час. Передаём в JS,
		// чтобы виджет мог отправить mirror через application context.
		const authId = (body && body.AUTH_ID) || "";
		const domain = (body && body.DOMAIN) || ((req.query.DOMAIN as string) || "");
		res.type("html").send(this.renderHtml(authId, domain));
	}

	@Post("send")
	async send(@Body() body: { phone?: string; text?: string; authId?: string; domain?: string; idInstance?: string; chatIdOverride?: string; usernameOverride?: string }) {
		const phone = (body.phone || "").replace(/[^\d]/g, "");
		const text = (body.text || "").trim();
		const chatIdOverride = (body.chatIdOverride || "").trim();
		// Telegram-only: @username, который оператор ввёл вручную. Не путать с
		// chatIdOverride (числовой user_id из B24-привязки). Сами @ срезаем —
		// добавим позже в нужном формате под Green API.
		const usernameOverride = (body.usernameOverride || "").trim().replace(/^@/, "");
		// phone обязателен только если нет chatIdOverride/usernameOverride
		// (для MAX/Telegram валидно отправлять без phone, по известному chatId/username).
		if (!chatIdOverride && !usernameOverride && (phone.length < 10 || phone.length > 15)) {
			throw new HttpException(`Неверный номер: "${body.phone}"`, HttpStatus.BAD_REQUEST);
		}
		if (!text) {
			throw new HttpException("Текст пуст", HttpStatus.BAD_REQUEST);
		}

		// Поиск Instance по выбору фронта; если не указан — берём первый authorized.
		let inst;
		if (body.idInstance) {
			inst = await this.prisma.instance.findUnique({
				where: { idInstance: BigInt(body.idInstance) },
			});
		}
		if (!inst) {
			inst = await this.prisma.instance.findFirst({
				where: { stateInstance: "authorized" },
				orderBy: { idInstance: "asc" },
			});
		}
		if (!inst) {
			throw new HttpException("Нет авторизованных Green API инстансов в БД adapter", HttpStatus.INTERNAL_SERVER_ERROR);
		}

		const idInstance = inst.idInstance.toString();
		const apiToken = inst.apiTokenInstance;
		const apiUrl = greenApiUrl(idInstance);

		// Определяем провайдера. WhatsApp использует chatId=phone@c.us, MAX —
		// внутренний chatId (CheckAccount). Telegram аналогично — внутренний
		// user_id, причём резолв phone→user_id требует чтобы номер был в адресной
		// книге нашего Telegram-аккаунта (Telegram privacy).
		const provider = ((inst.settings as any)?.provider || "wa").toLowerCase();
		let chatId: string;
		if (provider === "max" || provider === "telegram") {
			// Приоритет 1: явный chatId от фронта (виджет нашёл его в B24 open-line
			// привязке контакта).
			if (chatIdOverride) {
				chatId = chatIdOverride;
				if (phone.length >= 10) {
					await this.prisma.maxContact.upsert({
						where: { idInstance_phone: { idInstance: BigInt(idInstance), phone } },
						create: { idInstance: BigInt(idInstance), phone, chatId },
						update: { chatId },
					});
				}
			} else if (usernameOverride && (provider === "telegram" || provider === "max")) {
				// Приоритет 2: @username от оператора. И Telegram, и MAX
				// поддерживают идентификацию по username (нику) в обход
				// privacy-настроек поиска по phone. Green API принимает
				// chatId в формате `<username>@c.us`.
				chatId = `${usernameOverride}@c.us`;
			} else {
				// Приоритет 3: локальный кеш phone → chatId (заполнялся при
				// прошлой успешной отправке).
				let cached = await this.prisma.maxContact.findUnique({
					where: { idInstance_phone: { idInstance: BigInt(idInstance), phone } },
				});
				if (!cached) {
					// Приоритет 4: CheckAccount у Green API. Для MAX — резолвит
					// если номер в контактах MAX-аккаунта. Для Telegram — если
					// номер в адресной книге Telegram-аккаунта И клиент в
					// privacy "находить по номеру" не запретил.
					const providerLabel = provider === "max" ? "MAX" : "Telegram";
					try {
						// Telegram-shard валидирует phoneNumber как integer (выкидывает
						// "Validation failed" на string). MAX-shard принимает string.
						// Приводим к int если это валидное число — иначе ошибка пользователю.
						const phoneNumeric = Number(phone);
						const phoneForApi = provider === "telegram"
							? (Number.isFinite(phoneNumeric) ? phoneNumeric : phone)
							: phone;
						const r = await axios.post(
							`${apiUrl}/waInstance${idInstance}/CheckAccount/${apiToken}`,
							{ phoneNumber: phoneForApi },
							{ timeout: 15000 },
						);
						if (!r.data?.exist || !r.data?.chatId) {
							const hint = provider === "telegram"
								? `Telegram: номер +${phone} не найден. Telegram отдаёт user_id по номеру только если: (а) номер в адресной книге Telegram-аккаунта 79584983354, ИЛИ (б) у клиента в Telegram-privacy "Кто может найти меня по номеру" = Все. Если уже была переписка — открой виджет в карточке клиента где привязан Telegram-чат. Альтернатива — введи @username клиента в поле ниже.`
								: `MAX: номер +${phone} не найден. Возможно у клиента нет MAX, либо его нет в контактах MAX-аккаунта 79584983354. Если уже была переписка — попробуйте из карточки клиента где привязан MAX-чат.`;
							throw new HttpException(hint, HttpStatus.NOT_FOUND);
						}
						cached = await this.prisma.maxContact.create({
							data: { idInstance: BigInt(idInstance), phone, chatId: String(r.data.chatId) },
						});
					} catch (err: any) {
						if (err instanceof HttpException) throw err;
						const msg = err.response?.data || err.message;
						throw new HttpException(`${providerLabel} CheckAccount: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`, HttpStatus.BAD_GATEWAY);
					}
				}
				chatId = cached.chatId;
			}
		} else {
			chatId = `${phone}@c.us`;
		}

		let idMessage: string | undefined;
		try {
			const r = await axios.post(
				`${apiUrl}/waInstance${idInstance}/sendMessage/${apiToken}`,
				{ chatId, message: text },
				{ timeout: 15000 },
			);
			idMessage = r.data?.idMessage;
		} catch (err: any) {
			const msg = err.response?.data || err.message;
			throw new HttpException(`Green API: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`, HttpStatus.BAD_GATEWAY);
		}

		// Зеркалим в ту B24 open line, к которой привязан выбранный инстанс.
		// Для MAX/Telegram используем chatId (внутренний) как ключ user/chat — тот же,
		// что adapter ставит для входящих, иначе будет два разных диалога.
		const lineForMirror = inst.bitrixLine || undefined;
		const mirrorKey = (provider === "max" || provider === "telegram") ? chatId : phone;
		const mirrored = await this.mirrorToBitrix(mirrorKey, text, idMessage, body.authId, body.domain, lineForMirror, provider);
		return { ok: true, idMessage, chatId, idInstance, line: lineForMirror, mirrored };
	}

	private async mirrorToBitrix(
		idKey: string, text: string, idMessage?: string,
		authId?: string, domain?: string, lineOverride?: number,
		provider: string = "wa",
	): Promise<boolean | string> {
		const line = lineOverride ?? Number(this.config.get<string>("BITRIX_LINE_ID"));
		if (!line) return false; // нет линии — пропускаем

		// Для WA idKey = phone (10-15 цифр) → можно сформировать E.164 + user.phone.
		// Для MAX/Telegram idKey = chatId (внутренний user_id), телефона нет.
		const isPhoneLike = provider === "wa" && /^\d{10,15}$/.test(idKey);
		const phoneE164 = isPhoneLike ? `+${idKey}` : null;
		// Префикс должен совпадать с тем что adapter ставит при входящих:
		//   WA + Telegram → wa_ (legacy compat — Telegram сессии создавались с wa_
		//   до того как мы добавили sc_ для не-WA). Меняем — будут дубли в B24.
		//   MAX → sc_
		const useWaPrefix = isPhoneLike || provider === "telegram";
		const userKey = useWaPrefix ? `wa_${idKey}` : `sc_${idKey}`;
		// ВАЖНО: name без пробелов. B24 при создании лида/контакта разбивает
		// name по пробелу и кладёт хвост в LAST_NAME. «WhatsApp 79228124797»
		// → NAME=«WhatsApp», LAST_NAME=«79228124797» — мусор в карточке.
		// Используем сам идентификатор как display-имя (B24 потом подменит на
		// настоящее имя клиента когда он впервые сам что-то напишет).
		const displayName = isPhoneLike ? (phoneE164 as string) : idKey;
		const userBlock: any = { id: userKey, name: displayName };
		if (phoneE164) userBlock.phone = phoneE164;
		const payload = {
			CONNECTOR: "social_connector",
			LINE: Number(line),
			MESSAGES: [{
				user: userBlock,
				message: { id: idMessage || String(Date.now()), date: Math.floor(Date.now() / 1000), text },
				chat: { id: userKey, name: displayName, url: null },
				extra: { is_self_message: true },
			}],
		};

		// Приоритет: OAuth-токен Social Connector app (из placement-запроса B24).
		// Fallback: Inbound Webhook URL (если когда-нибудь B24 разрешит для этого метода).
		if (authId && domain) {
			try {
				const url = `https://${domain}/rest/imconnector.send.messages?auth=${encodeURIComponent(authId)}`;
				const r = await axios.post(url, payload, { timeout: 10000 });
				if (r.data?.error) return `b24:${r.data.error}`;
				return true;
			} catch (err: any) {
				return `b24 mirror via OAuth failed: ${err.response?.data?.error_description || err.message}`;
			}
		}

		const webhookUrl = this.config.get<string>("BITRIX_WEBHOOK_URL");
		if (!webhookUrl) return false;
		try {
			const r = await axios.post(
				`${webhookUrl.replace(/\/$/, "")}/imconnector.send.messages`,
				payload,
				{ timeout: 10000 },
			);
			if (r.data?.error) return `b24:${r.data.error}`;
			return true;
		} catch (err: any) {
			return `b24 mirror via webhook failed: ${err.response?.data?.error_description || err.message}`;
		}
	}

	private renderHtml(authId: string = "", domain: string = ""): string {
		const safe = (s: string) => s.replace(/[<>'"&]/g, "");
		const authJs = JSON.stringify({ authId: safe(authId), domain: safe(domain) });
		return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Social Connector — отправить сообщение</title>
<script src="//api.bitrix24.com/api/v1/"></script>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 24px 24px 160px; background: #f5f7fa; color: #1a1a1a; min-height: 100vh; }
  .card { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  h1 { margin: 0 0 4px; font-size: 18px; color: #2d8f4e; }
  .subtitle { margin: 0 0 20px; font-size: 13px; color: #6b7280; }
  label { display: block; font-size: 13px; font-weight: 500; margin: 12px 0 6px; }
  input, textarea, select { width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font: inherit; font-size: 14px; background: #fff; }
  textarea { min-height: 110px; resize: vertical; }
  input:focus, textarea:focus, select:focus { outline: none; border-color: #2d8f4e; box-shadow: 0 0 0 3px rgba(45,143,78,0.15); }
  button { margin-top: 16px; padding: 11px 20px; background: #84cc16; color: #fff; border: 0; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; width: 100%; }
  button:hover { background: #65a30d; }
  button:disabled { background: #9ca3af; cursor: not-allowed; }
  .status { margin-top: 14px; padding: 10px 12px; border-radius: 8px; font-size: 13px; display: none; }
  .status.ok { display: block; background: #d1fae5; color: #065f46; }
  .status.err { display: block; background: #fee2e2; color: #991b1b; }
  .hint { font-size: 12px; color: #6b7280; margin-top: 4px; }
  .chips { display: flex !important; flex-wrap: wrap !important; gap: 6px !important; margin-bottom: 8px !important; }
  .chip { display: inline-flex !important; align-items: center !important; gap: 6px !important; padding: 6px 10px !important; border: 1px solid #d1d5db !important; border-radius: 999px !important; background: #fff !important; cursor: pointer !important; font-size: 13px !important; user-select: none !important; transition: all .15s !important; }
  .chip:hover { border-color: #2d8f4e !important; background: #f0fdf4 !important; }
  .chip.active { border-color: #2d8f4e !important; background: #2d8f4e !important; color: #fff !important; }
  .chip .chip-meta { font-size: 11px !important; opacity: 0.75 !important; }
  .chips-empty { font-size: 12px !important; color: #9ca3af !important; padding: 4px 0 !important; }
</style>
</head>
<body>
<div class="card">
  <h1>📤 Social Connector</h1>
  <p class="subtitle" id="subtitle">Первое сообщение клиенту</p>

  <label for="instance">Отправить с номера</label>
  <select id="instance">
    <option value="">загрузка…</option>
  </select>

  <label>Номер телефона клиента</label>
  <div id="phoneChips" class="chips"></div>
  <input id="phone" placeholder="+79261234567 или 79261234567" autocomplete="off" inputmode="tel">
  <div class="hint">Кликни нужный номер из списка выше или введи свой (с кодом страны, можно с + или без)</div>

  <div id="tgUsernameBlock" style="display:none; margin-top:8px;">
    <label for="tgUsername">@username <span id="tgUsernameChannel">Telegram</span> <span style="color:#9ca3af; font-weight: 400;">(если знаешь — попробуем по username, минуя privacy-ограничения phone)</span></label>
    <input id="tgUsername" placeholder="@alexandra_run или alexandra_run" autocomplete="off">
    <div class="hint">Можно с символом @ в начале или без. Используется только для Telegram и MAX (в обоих есть никнеймы).</div>
  </div>

  <label for="text">Сообщение</label>
  <textarea id="text" placeholder="Здравствуйте! Это менеджер «Первый Беговой»…"></textarea>

  <button id="send">Отправить</button>
  <div id="status" class="status"></div>
  <details style="margin-top:14px; font-size:11px; color:#6b7280;">
    <summary style="cursor:pointer;">debug</summary>
    <pre id="debug" style="white-space:pre-wrap; word-break:break-all; margin:6px 0 0;"></pre>
  </details>
</div>

<script>
const B24_AUTH = ${authJs};
(function() {
  const $ = id => document.getElementById(id);
  const status = $("status");
  const debug = $("debug");
  const showStatus = (msg, ok) => {
    status.textContent = msg;
    status.className = "status " + (ok ? "ok" : "err");
  };
  const dbg = (label, data) => {
    if (!debug) return;
    debug.textContent += label + ": " + (typeof data === "string" ? data : JSON.stringify(data, null, 2)) + "\\n";
  };

  function setPhone(raw) {
    if (!raw) return;
    const digits = String(raw).replace(/[^\\d]/g, "");
    if (digits.length >= 10) $("phone").value = digits;
  }

  // Список телефонов из карточки CRM: рендерим чипами (pills).
  // Клик по чипу — подставляет в input #phone. Поле input всегда видимое,
  // если оператору нужен другой номер — просто очищает чип и пишет руками.
  let entityCtx = null;
  let phoneOptions = []; // [{digits, label}]
  function normalize(raw) { return String(raw || "").replace(/[^\\d]/g, ""); }
  function renderChips(preselectDigits) {
    const wrap = $("phoneChips");
    wrap.innerHTML = "";
    const selected = preselectDigits || (phoneOptions[0] && phoneOptions[0].digits) || "";
    if (!phoneOptions.length) {
      const empty = document.createElement("div");
      empty.className = "chips-empty";
      empty.textContent = "У клиента в CRM нет сохранённых номеров — введите ниже";
      wrap.appendChild(empty);
    }
    phoneOptions.forEach(p => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip" + (p.digits === selected ? " active" : "");
      btn.innerHTML = '<span>+' + p.digits + '</span>'
        + (p.label ? '<span class="chip-meta">· ' + p.label + '</span>' : '');
      btn.addEventListener("click", () => {
        $("phone").value = p.digits;
        [...wrap.querySelectorAll(".chip")].forEach(c => c.classList.remove("active"));
        btn.classList.add("active");
      });
      wrap.appendChild(btn);
    });
    if (selected) {
      $("phone").value = selected;
    }
  }
  // При ручном вводе в #phone снимаем active с чипов (если введён другой номер)
  // или подсвечиваем совпадающий чип
  $("phone").addEventListener("input", () => {
    const d = normalize($("phone").value);
    const chips = [...$("phoneChips").querySelectorAll(".chip")];
    chips.forEach(c => {
      const num = c.querySelector("span").textContent.replace("+", "");
      if (num === d) c.classList.add("active"); else c.classList.remove("active");
    });
  });
  function collectPhonesFromCrmRow(data, sourceLabel) {
    if (!data || !Array.isArray(data.PHONE)) return;
    data.PHONE.forEach(p => {
      const digits = normalize(p.VALUE);
      if (digits.length < 10) return;
      if (phoneOptions.find(x => x.digits === digits)) return; // де-дубликация
      const typeMap = { MOBILE: "моб", WORK: "раб", HOME: "дом", FAX: "факс", OTHER: "доп" };
      const meta = [sourceLabel, typeMap[p.VALUE_TYPE]].filter(Boolean).join(" · ");
      phoneOptions.push({ digits, label: meta });
    });
  }
  async function loadPrefAndRender() {
    let saved = null;
    if (entityCtx && B24_AUTH.domain) {
      try {
        const r = await fetch("/widget/entity-phone?portal=" + encodeURIComponent(B24_AUTH.domain)
          + "&type=" + encodeURIComponent(entityCtx.type)
          + "&id=" + encodeURIComponent(entityCtx.id));
        const j = await r.json();
        saved = j.phone ? normalize(j.phone) : null;
        dbg("pref", saved);
      } catch (e) { dbg("pref err", e.message); }
    }
    // Если сохранённый номер не в списке — добавляем как «ранее использован»
    if (saved && !phoneOptions.find(x => x.digits === saved)) {
      phoneOptions.unshift({ digits: saved, label: "ранее" });
    }
    renderChips(saved || (phoneOptions[0] && phoneOptions[0].digits));
  }

  // Подгружаем список инстансов (с какого номера слать) из adapter.
  // Hardcoded labels — fallback для старых WA-номеров (БД у них без label).
  const INSTANCE_LABELS = {
    "1103487233": "WhatsApp +7 958 498-33-54 (1Begovoy)",
    "1101948511": "WhatsApp +7 924 077-85-66",
  };
  // Карты для multi-channel UX:
  //   PROVIDER_MAP — idInstance → provider (wa/max/telegram) для subtitle
  //   INSTANCE_BY_ID — idInstance → весь Instance объект из API
  //   MAX_CHATS_BY_LINE — line_id → известный chatId из B24 user_code'ов
  const PROVIDER_MAP = {};
  const INSTANCE_BY_ID = {};
  const MAX_CHATS_BY_LINE = {};
  function detectChannelLabel(idInst) {
    const p = (PROVIDER_MAP[idInst] || "wa").toLowerCase();
    if (p === "max") return "MAX";
    if (p === "telegram") return "Telegram";
    return "WhatsApp";
  }
  // B24 placement iframe имеет фиксированную высоту. У разных типов placement
  // разные методы изменения:
  //   - DETAIL_TAB / CONTACT_TAB / DEAL_TAB → BX24.fitWindow() (растягивает
  //     iframe до доступной высоты карточки, со скроллом внутри)
  //   - все остальные (TOOLBAR попапы, page-app) → BX24.resizeWindow(0, h)
  // Дёргаем оба, в нужном контексте сработает один — это безопасно.
  function resizeB24() {
    if (typeof BX24 === "undefined") return;
    try {
      const h = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        700
      );
      if (BX24.resizeWindow) BX24.resizeWindow(0, h + 200);
      if (BX24.fitWindow) BX24.fitWindow();
    } catch (e) {
      dbg("resize err", String(e));
    }
  }
  // Значения UF-полей из карточки клиента — подставим в @username input
  // в зависимости от выбранного провайдера (Telegram → UF_CRM_IM_TELEGRAM,
  // MAX → UF_CRM_MAX). Заполняется при загрузке crm.{lead,deal,contact}.get.
  const entityUsernames = { telegram: "", max: "" };
  function collectUsernames(data) {
    const tg = (data && data.UF_CRM_IM_TELEGRAM) ? String(data.UF_CRM_IM_TELEGRAM).replace(/^@/, "") : "";
    const mx = (data && data.UF_CRM_MAX) ? String(data.UF_CRM_MAX).replace(/^@/, "") : "";
    if (tg && !entityUsernames.telegram) entityUsernames.telegram = tg;
    if (mx && !entityUsernames.max) entityUsernames.max = mx;
  }
  function applyUsernameFromUf() {
    const idInst = $("instance").value;
    const p = (PROVIDER_MAP[idInst] || "").toLowerCase();
    const input = $("tgUsername");
    if (!input || input.value.trim()) return; // оператор уже ввёл — не перетираем
    if (p === "telegram" && entityUsernames.telegram) input.value = entityUsernames.telegram;
    else if (p === "max" && entityUsernames.max) input.value = entityUsernames.max;
  }

  function updateSubtitle() {
    const idInst = $("instance").value;
    const channel = detectChannelLabel(idInst);
    $("subtitle").textContent = "Первое сообщение клиенту через " + channel;
    // Telegram и MAX поддерживают @username, у WhatsApp — нет.
    const p = (PROVIDER_MAP[idInst] || "").toLowerCase();
    const hasUsername = p === "telegram" || p === "max";
    $("tgUsernameBlock").style.display = hasUsername ? "block" : "none";
    const ch = $("tgUsernameChannel");
    if (ch) ch.textContent = p === "max" ? "MAX" : "Telegram";
    // При смене инстанса — подставим значение из соответствующего UF-поля,
    // если есть и оператор ещё не вводил руками.
    applyUsernameFromUf();
    resizeB24();
  }
  fetch("/widget/instances").then(r => r.json()).then(list => {
    const sel = $("instance");
    sel.innerHTML = "";
    if (!list.length) {
      sel.innerHTML = '<option value="">(нет инстансов в БД)</option>';
      return;
    }
    list.forEach(it => {
      PROVIDER_MAP[it.idInstance] = (it.provider || "wa");
      INSTANCE_BY_ID[it.idInstance] = it;
      const opt = document.createElement("option");
      opt.value = it.idInstance;
      // Приоритет: hardcoded label (для WA) → label из БД (для MAX и др.) → ID
      opt.textContent = INSTANCE_LABELS[it.idInstance] || it.label || it.idInstance;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", updateSubtitle);
    updateSubtitle();
  }).catch(e => dbg("instances fetch error", e.message));

  // У B24 для CRM_*_DETAIL_* тип сущности определяется placement-именем,
  // а entity ID лежит в options.ID / options.ENTITY_ID / options.entityId.
  // В LIST_MENU entity id может приходить как options.ID или options.element_id
  // (открыли меню на конкретной строке списка).
  const PLACEMENT_TO_METHOD = {
    // DETAIL_TOOLBAR — кнопка в шапке карточки
    CRM_LEAD_DETAIL_TOOLBAR: "crm.lead.get",
    CRM_DEAL_DETAIL_TOOLBAR: "crm.deal.get",
    CRM_CONTACT_DETAIL_TOOLBAR: "crm.contact.get",
    CRM_COMPANY_DETAIL_TOOLBAR: "crm.company.get",
    // DETAIL_TAB — отдельная вкладка в карточке
    CRM_LEAD_DETAIL_TAB: "crm.lead.get",
    CRM_DEAL_DETAIL_TAB: "crm.deal.get",
    CRM_CONTACT_DETAIL_TAB: "crm.contact.get",
    CRM_COMPANY_DETAIL_TAB: "crm.company.get",
    // DETAIL_ACTIVITY — в панели «Что нужно сделать»
    CRM_LEAD_DETAIL_ACTIVITY: "crm.lead.get",
    CRM_DEAL_DETAIL_ACTIVITY: "crm.deal.get",
    CRM_CONTACT_DETAIL_ACTIVITY: "crm.contact.get",
    CRM_COMPANY_DETAIL_ACTIVITY: "crm.company.get",
    // ACTIVITY_TIMELINE_MENU — три точки на записи timeline
    CRM_LEAD_ACTIVITY_TIMELINE_MENU: "crm.lead.get",
    CRM_DEAL_ACTIVITY_TIMELINE_MENU: "crm.deal.get",
    // LIST_MENU — три точки у строки в списке лидов/сделок/контактов
    CRM_LEAD_LIST_MENU: "crm.lead.get",
    CRM_DEAL_LIST_MENU: "crm.deal.get",
    CRM_CONTACT_LIST_MENU: "crm.contact.get",
  };

  if (typeof BX24 === "undefined") {
    dbg("BX24", "SDK не загружен — окно открыто вне B24 iframe");
    return;
  }

  BX24.init(function() {
    // Растягиваем iframe сразу после init и повторяем через несколько
    // таймаутов — когда отрендерятся инстансы, чипы, селект развернётся.
    // Плюс ResizeObserver на body, чтобы реагировать на любые изменения
    // (показ блока @username для TG, resize textarea вручную, и т.п.).
    resizeB24();
    [120, 350, 800, 1500].forEach(ms => setTimeout(resizeB24, ms));
    if (typeof ResizeObserver !== "undefined") {
      try { new ResizeObserver(() => resizeB24()).observe(document.body); }
      catch (e) { dbg("ResizeObserver err", String(e)); }
    }
    window.addEventListener("resize", resizeB24);
    const info = BX24.placement.info() || {};
    dbg("placement.info", info);

    const placement = info.placement;
    const opts = info.options || {};
    const entityId = opts.OWNER_ID || opts.ID || opts.ENTITY_ID || opts.id || opts.element_id;
    const method = PLACEMENT_TO_METHOD[placement];

    if (!method) { dbg("method", "unknown placement"); renderChips(""); return; }
    if (!entityId) { dbg("entityId", "не нашли в options"); renderChips(""); return; }

    // Определяем тип сущности для pref-ключа
    const ENTITY_TYPE = method === "crm.lead.get" ? "LEAD"
      : method === "crm.deal.get" ? "DEAL"
      : method === "crm.contact.get" ? "CONTACT"
      : method === "crm.company.get" ? "COMPANY" : "OTHER";
    entityCtx = { type: ENTITY_TYPE, id: String(entityId) };

    // Подтянем известные MAX chatId из IMOPENLINES_SESSION-активностей этой
    // CRM-сущности. PROVIDER_PARAMS.USER_CODE содержит формат
    // "social_connector|<line>|sc_<chatId>|<user_id>", откуда и берём chatId.
    // (imopenlines.crm.chat.get пустой возвращает для лидов — баг B24 API.)
    function loadExistingMaxChats(crmEntityType, crmEntityId) {
      const ownerTypeId = crmEntityType === "LEAD" ? 1
        : crmEntityType === "DEAL" ? 2
        : crmEntityType === "CONTACT" ? 3
        : crmEntityType === "COMPANY" ? 4 : null;
      if (!ownerTypeId) return;
      try {
        BX24.callMethod("crm.activity.list", {
          filter: {
            OWNER_TYPE_ID: ownerTypeId,
            OWNER_ID: crmEntityId,
            PROVIDER_ID: "IMOPENLINES_SESSION",
          },
          select: ["ID", "PROVIDER_TYPE_ID", "PROVIDER_PARAMS"],
        }, function(rr) {
          if (rr.error()) { dbg("activity.list err", rr.error_description()); return; }
          const arr = rr.data() || [];
          (Array.isArray(arr) ? arr : Object.values(arr)).forEach(rec => {
            const code = (rec && rec.PROVIDER_PARAMS && rec.PROVIDER_PARAMS.USER_CODE) || "";
            // sc_ — современный префикс (для всех не-WA), wa_ — legacy от
            // ранних версий adapter где Telegram chatId 10 цифр считались phone.
            const m = code.match(/social_connector\\|(\\d+)\\|(?:sc_|wa_)([^|]+)/);
            if (m) {
              const line = m[1], chatId = m[2];
              MAX_CHATS_BY_LINE[line] = chatId;
              dbg("existing MAX chat", { line, chatId });
            }
          });
        });
      } catch (e) { dbg("loadExistingMaxChats err", e.message); }
    }

    BX24.callMethod(method, { id: entityId }, function(res) {
      if (res.error()) { dbg(method + " error", res.error_description()); loadPrefAndRender(); return; }
      const data = res.data() || {};
      dbg(method + ".PHONE", data.PHONE);
      collectPhonesFromCrmRow(data, ENTITY_TYPE === "LEAD" ? "лид" : ENTITY_TYPE === "DEAL" ? "сделка" : "контакт");
      collectUsernames(data);
      dbg("UF usernames", entityUsernames);

      // Сделка — подтянем телефоны и MAX-чаты из связанного контакта
      if (method === "crm.deal.get" && data.CONTACT_ID) {
        loadExistingMaxChats("CONTACT", data.CONTACT_ID);
        BX24.callMethod("crm.contact.get", { id: data.CONTACT_ID }, function(r2) {
          if (r2.error()) { dbg("contact error", r2.error_description()); loadPrefAndRender(); applyUsernameFromUf(); return; }
          const d2 = r2.data() || {};
          dbg("contact.PHONE", d2.PHONE);
          collectPhonesFromCrmRow(d2, "контакт");
          collectUsernames(d2);
          loadPrefAndRender();
          applyUsernameFromUf();
        });
      } else {
        // Для CONTACT/LEAD/COMPANY — ищем MAX-чаты в самой сущности
        loadExistingMaxChats(ENTITY_TYPE, entityId);
        loadPrefAndRender();
        applyUsernameFromUf();
      }
    });
  });


  $("send").addEventListener("click", async function() {
    const phone = $("phone").value.trim();
    const text = $("text").value.trim();
    const idInstance = $("instance").value || undefined;
    const usernameOverride = $("tgUsername").value.trim().replace(/^@/, "");
    // Если виджет знает chatId этого клиента из его B24-карточки — используем его.
    // Тогда phone оператору вводить не обязательно (для MAX/Telegram phone бесполезен,
    // там общение по chatId, а phone Green API не отдаёт privacy).
    let chatIdOverride;
    const inst = INSTANCE_BY_ID[idInstance];
    const instProvider = inst ? (inst.provider || "wa").toLowerCase() : "wa";
    if (inst && instProvider !== "wa" && inst.bitrixLine != null) {
      const known = MAX_CHATS_BY_LINE[String(inst.bitrixLine)];
      if (known) {
        chatIdOverride = known;
        dbg("using existing chatId for " + instProvider, known);
      }
    }
    if (!text) {
      showStatus("Введите текст сообщения", false);
      return;
    }
    if (!phone && !chatIdOverride && !usernameOverride) {
      const hint = instProvider === "wa"
        ? "Введите номер телефона клиента"
        : instProvider === "telegram"
          ? "Введите номер или @username клиента, либо открой виджет в карточке где привязан Telegram-чат"
          : "Введите номер или открой виджет в карточке клиента — оттуда подтянется chatId";
      showStatus(hint, false);
      return;
    }
    this.disabled = true;
    showStatus("Отправляю…", true);
    try {
      const r = await fetch("/widget/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, text, idInstance, chatIdOverride, usernameOverride, authId: B24_AUTH.authId, domain: B24_AUTH.domain }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        const mirrorMsg = j.mirrored === true ? "mirror в B24: ✓"
                        : j.mirrored === false ? "mirror отключён"
                        : "mirror: " + j.mirrored;
        showStatus("✓ Отправлено (" + (j.idMessage || "—") + ") · " + mirrorMsg, true);
        dbg("response", j);
        $("text").value = "";
        // Запоминаем выбранный телефон для этой CRM-сущности
        if (entityCtx && B24_AUTH.domain && phone) {
          fetch("/widget/entity-phone", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ portal: B24_AUTH.domain, type: entityCtx.type, id: entityCtx.id, phone }),
          }).catch(e => dbg("pref save err", e.message));
        }
      } else {
        showStatus("✗ " + (j.message || r.statusText), false);
      }
    } catch (e) {
      showStatus("✗ Сетевая ошибка: " + e.message, false);
    } finally {
      this.disabled = false;
    }
  });
})();
</script>
</body>
</html>`;
	}
}
