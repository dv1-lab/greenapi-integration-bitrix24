import { All, Body, Controller, HttpException, HttpStatus, Post, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request, Response } from "express";
import axios from "axios";

@Controller("widget")
export class WidgetController {
	constructor(private readonly config: ConfigService) {}

	// B24 placement шлёт POST с form-data, прямой переход из браузера — GET.
	// Принимаем оба через @All, кроме POST /widget/send (см. ниже).
	@All("send-first")
	render(@Req() req: Request, @Res() res: Response) {
		res.setHeader("X-Frame-Options", "ALLOWALL");
		res.setHeader("Content-Security-Policy", "frame-ancestors *");
		res.type("html").send(this.renderHtml());
	}

	@Post("send")
	async send(@Body() body: { phone?: string; text?: string }) {
		const phone = (body.phone || "").replace(/[^\d]/g, "");
		const text = (body.text || "").trim();
		if (phone.length < 10 || phone.length > 15) {
			throw new HttpException(`Неверный номер: "${body.phone}"`, HttpStatus.BAD_REQUEST);
		}
		if (!text) {
			throw new HttpException("Текст пуст", HttpStatus.BAD_REQUEST);
		}

		const apiUrl = this.config.get<string>("GREENAPI_API_URL");
		const idInstance = this.config.get<string>("GREENAPI_ID_INSTANCE");
		const apiToken = this.config.get<string>("GREENAPI_TOKEN_INSTANCE");
		if (!apiUrl || !idInstance || !apiToken) {
			throw new HttpException("Green API credentials не настроены на сервере", HttpStatus.INTERNAL_SERVER_ERROR);
		}

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

		// Зеркалим в открытую линию B24 как self-message, чтобы менеджер видел свою
		// переписку в карточке клиента. Если не настроен — пропускаем без ошибки.
		const mirrored = await this.mirrorToBitrix(phone, text, idMessage);
		return { ok: true, idMessage, chatId, mirrored };
	}

	private async mirrorToBitrix(phone: string, text: string, idMessage?: string): Promise<boolean | string> {
		const webhookUrl = this.config.get<string>("BITRIX_WEBHOOK_URL");
		const line = this.config.get<string>("BITRIX_LINE_ID");
		if (!webhookUrl || !line) return false; // mirror отключён до настройки webhook+LINE
		try {
			const r = await axios.post(
				`${webhookUrl.replace(/\/$/, "")}/imconnector.send.messages`,
				{
					CONNECTOR: "social_connector",
					LINE: Number(line),
					MESSAGES: [{
						user: { id: phone, name: `WhatsApp ${phone}`, phone },
						message: { id: idMessage || String(Date.now()), date: Math.floor(Date.now() / 1000), text },
						chat: { id: phone, name: `WhatsApp ${phone}`, url: null },
						extra: { is_self_message: true },
					}],
				},
				{ timeout: 10000 },
			);
			if (r.data?.error) return `b24:${r.data.error}`;
			return true;
		} catch (err: any) {
			return `b24 mirror failed: ${err.response?.data?.error_description || err.message}`;
		}
	}

	private renderHtml(): string {
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
  input, textarea { width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font: inherit; font-size: 14px; }
  textarea { min-height: 110px; resize: vertical; }
  input:focus, textarea:focus { outline: none; border-color: #2d8f4e; box-shadow: 0 0 0 3px rgba(45,143,78,0.15); }
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

  // У B24 для CRM_*_DETAIL_TOOLBAR тип сущности определяется placement-именем,
  // а entity ID лежит в options.ID.
  const PLACEMENT_TO_METHOD = {
    CRM_LEAD_DETAIL_TOOLBAR: "crm.lead.get",
    CRM_DEAL_DETAIL_TOOLBAR: "crm.deal.get",
    CRM_CONTACT_DETAIL_TOOLBAR: "crm.contact.get",
    CRM_COMPANY_DETAIL_TOOLBAR: "crm.company.get",
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
    const entityId = opts.ID || opts.ENTITY_ID || opts.id;
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
      const r = await fetch("/widget/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, text }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        showStatus("✓ Отправлено. idMessage: " + (j.idMessage || "—"), true);
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
