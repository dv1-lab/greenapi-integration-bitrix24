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
		}));
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
	async send(@Body() body: { phone?: string; text?: string; authId?: string; domain?: string; idInstance?: string }) {
		const phone = (body.phone || "").replace(/[^\d]/g, "");
		const text = (body.text || "").trim();
		if (phone.length < 10 || phone.length > 15) {
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

		const chatId = `${phone}@c.us`;
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
		const lineForMirror = inst.bitrixLine || undefined;
		const mirrored = await this.mirrorToBitrix(phone, text, idMessage, body.authId, body.domain, lineForMirror);
		return { ok: true, idMessage, chatId, idInstance, line: lineForMirror, mirrored };
	}

	private async mirrorToBitrix(
		phone: string, text: string, idMessage?: string,
		authId?: string, domain?: string, lineOverride?: number,
	): Promise<boolean | string> {
		const line = lineOverride ?? Number(this.config.get<string>("BITRIX_LINE_ID"));
		if (!line) return false; // нет линии — пропускаем

		// B24 матчит CRM-контакт по user.phone строго в E.164 (с ведущим `+`).
		const phoneE164 = phone.startsWith("+") ? phone : `+${phone}`;
		// Префикс `wa_` — см. комментарий в bitrix24.service.ts (обход legacy-кеша
		// imopenlines.user). Ключи user/chat должны совпадать с теми что шлёт adapter
		// при входящих, иначе исходящий mirror создаст отдельную сессию.
		const userKey = `wa_${phone}`;
		const payload = {
			CONNECTOR: "social_connector",
			LINE: Number(line),
			MESSAGES: [{
				user: { id: userKey, name: `WhatsApp ${phone}`, phone: phoneE164 },
				message: { id: idMessage || String(Date.now()), date: Math.floor(Date.now() / 1000), text },
				chat: { id: userKey, name: `WhatsApp ${phone}`, url: null },
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
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 24px; background: #f5f7fa; color: #1a1a1a; }
  .card { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  h1 { margin: 0 0 4px; font-size: 18px; color: #2d8f4e; }
  .subtitle { margin: 0 0 20px; font-size: 13px; color: #6b7280; }
  label { display: block; font-size: 13px; font-weight: 500; margin: 12px 0 6px; }
  input, textarea, select { width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font: inherit; font-size: 14px; background: #fff; }
  textarea { min-height: 110px; resize: vertical; }
  input:focus, textarea:focus, select:focus { outline: none; border-color: #2d8f4e; box-shadow: 0 0 0 3px rgba(45,143,78,0.15); }
  button { margin-top: 16px; padding: 11px 20px; background: #2d8f4e; color: #fff; border: 0; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; width: 100%; }
  button:hover { background: #257038; }
  button:disabled { background: #9ca3af; cursor: not-allowed; }
  .status { margin-top: 14px; padding: 10px 12px; border-radius: 8px; font-size: 13px; display: none; }
  .status.ok { display: block; background: #d1fae5; color: #065f46; }
  .status.err { display: block; background: #fee2e2; color: #991b1b; }
  .hint { font-size: 12px; color: #6b7280; margin-top: 4px; }
</style>
</head>
<body>
<div class="card">
  <h1>📤 Social Connector</h1>
  <p class="subtitle">Первое сообщение клиенту через WhatsApp</p>

  <label for="instance">Отправить с номера</label>
  <select id="instance">
    <option value="">загрузка…</option>
  </select>

  <label for="phone">Номер телефона клиента</label>
  <input id="phone" placeholder="79261234567" autocomplete="off">
  <div class="hint">Только цифры, с кодом страны (без +)</div>

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

  // Подгружаем список инстансов (с какого номера слать) из adapter
  const INSTANCE_LABELS = {
    "1103487233": "+7 958 498-33-54 (1Begovoy-3354)",
    "1101948511": "+7 924 077-85-66",
  };
  fetch("/widget/instances").then(r => r.json()).then(list => {
    const sel = $("instance");
    sel.innerHTML = "";
    if (!list.length) {
      sel.innerHTML = '<option value="">(нет инстансов в БД)</option>';
      return;
    }
    list.forEach(it => {
      const opt = document.createElement("option");
      opt.value = it.idInstance;
      opt.textContent = INSTANCE_LABELS[it.idInstance] || it.idInstance;
      sel.appendChild(opt);
    });
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
    const info = BX24.placement.info() || {};
    dbg("placement.info", info);

    const placement = info.placement;
    const opts = info.options || {};
    // Разные placement-slot'ы B24 кладут entity ID в разные ключи.
    // TOOLBAR/TAB/ACTIVITY: options.ID
    // ACTIVITY_TIMELINE_MENU: options.OWNER_ID (тут options.ID = ID активности, не лида)
    // LIST_MENU: options.ID или options.element_id
    const entityId = opts.OWNER_ID || opts.ID || opts.ENTITY_ID || opts.id || opts.element_id;
    const method = PLACEMENT_TO_METHOD[placement];

    if (!method) { dbg("method", "unknown placement"); return; }
    if (!entityId) { dbg("entityId", "не нашли в options"); return; }

    BX24.callMethod(method, { id: entityId }, function(res) {
      if (res.error()) { dbg(method + " error", res.error_description()); return; }
      const data = res.data() || {};
      dbg(method + ".PHONE", data.PHONE);
      if (Array.isArray(data.PHONE) && data.PHONE[0]) {
        setPhone(data.PHONE[0].VALUE);
        return;
      }
      // Сделка — подтянем телефон из связанного контакта
      if (method === "crm.deal.get" && data.CONTACT_ID) {
        BX24.callMethod("crm.contact.get", { id: data.CONTACT_ID }, function(r2) {
          if (r2.error()) { dbg("contact error", r2.error_description()); return; }
          const d2 = r2.data() || {};
          dbg("contact.PHONE", d2.PHONE);
          if (Array.isArray(d2.PHONE) && d2.PHONE[0]) setPhone(d2.PHONE[0].VALUE);
        });
      }
    });
  });

  $("send").addEventListener("click", async function() {
    const phone = $("phone").value.trim();
    const text = $("text").value.trim();
    if (!phone || !text) {
      showStatus("Введите номер и текст", false);
      return;
    }
    this.disabled = true;
    showStatus("Отправляю…", true);
    try {
      const idInstance = $("instance").value || undefined;
      const r = await fetch("/widget/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, text, idInstance, authId: B24_AUTH.authId, domain: B24_AUTH.domain }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        const mirrorMsg = j.mirrored === true ? "mirror в B24: ✓"
                        : j.mirrored === false ? "mirror отключён"
                        : "mirror: " + j.mirrored;
        showStatus("✓ Отправлено (" + (j.idMessage || "—") + ") · " + mirrorMsg, true);
        dbg("response", j);
        $("text").value = "";
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
