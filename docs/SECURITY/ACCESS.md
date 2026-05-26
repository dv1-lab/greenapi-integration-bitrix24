# Access Control Matrix

Кто имеет доступ к чему. Цель — выявить **single point of failure**
(сейчас всё на Дмитрии) и зафиксировать backup-person для каждой
критичной системы. Чтобы платформа выжила если с Дмитрием что-то
случится (отпуск, болезнь, недоступность).

Сейчас все категории помечены `Дмитрий` — это **проблема**. Backup-person
ещё **не назначен** (см. ADR `decisions/2026-05-26-access-matrix-spof-mitigation.md`).

Last reviewed: 2026-05-26 (после ротации секретов task #26).

---

## 🔴 Critical — без доступа платформа умрёт

| Система | Что это | Где master | Primary | Backup-person |
|---|---|---|---|---|
| **Bitwarden Master Password** | хранилище всех остальных секретов | в голове Дмитрия | Дмитрий | **TODO** (см. ADR) |
| **my-server SSH ed25519 key** | главный сервер (adapter, bridge, dashboard, customer-service) | `~/.ssh/my_server_key` (мак) + Bitwarden | Дмитрий | **TODO** |
| **server-spb SSH key** | СПб VPS (1begovoy.ru website + WireGuard) | `~/.ssh/` + Bitwarden | Дмитрий | **TODO** |
| **B24 portal admin** | 1begovoy.bitrix24.ru — все CRM-данные | B24 login: phone+SMS | Дмитрий | **TODO** |
| **B24 OAuth apps** (CLIENT_SECRET) | wa_tg_bridge, social_connector — без них adapter/bridge не работают | Bitwarden | Дмитрий | **TODO** |
| **MoySklad** | склад + заказы 1begovoy.ru | login Дмитрия | Дмитрий | **TODO** |
| **Bitwarden Emergency Access contact** | механизм передачи Master при недоступности Дмитрия | **не настроено** ⚠️ | — | **TODO** |

## 🟡 Important — нарушение работы, но не катастрофа

| Система | Что | Primary | Backup |
|---|---|---|---|
| **GitHub** dv1-lab org (push/admin) | все приватные репо | Дмитрий | **TODO** |
| **Cloudflare** zone 9wb.ru | DNS, Tunnel, basic_auth | Дмитрий | **TODO** |
| **Green API** console (5 instances) | WA/MAX/TG-shard tokens | Дмитрий | **TODO** |
| **i2crm** account | IG Direct + Comments | Дмитрий | **TODO** |
| **Beget** (legacy) | старый shared hosting 1begovoy.ru (V1) | Дмитрий | **TODO** |
| **Yandex Metrika** + Webmaster | счетчики, поисковая выдача | Дмитрий | **TODO** |
| **Yandex.Disk** | restic backups destination | Дмитрий | **TODO** |
| **Google Cloud** project '1begovoy' | reCAPTCHA, mp-analytics service account | Дмитрий | **TODO** |
| **macOS keychain Дмитрия** | сертификаты, SSH-пароли | mac login | Дмитрий | (не передаваемо) |
| **Apple ID iCloud** | Notes, файлы, синхронизация | Apple login | Дмитрий | **TODO** |

## 🟢 Less critical — восстановимо силами самого backup

| Система | Что | Primary | Backup |
|---|---|---|---|
| **Telegram boto tokens** (10+ ботов) | @1begovoyconnectbot, @begovoy_bot, @agent_dv_bot, @clipmind_dv_bot, @pp_dv_bot, @mail_dv_bot, @server_ubuntu_dv_bot, @begovoy1support_bot, и др. | BotFather (TG @Дмитрия) | Дмитрий | (нужен TG account access) |
| **Telegram Premium** (Telethon) | moi-trenirovki, paperclip | TG @Дмитрия | Дмитрий | (то же) |
| **TG-аккаунт Дмитрия** | админ всех ботов, owner групп | phone+2FA | Дмитрий | **TODO** |
| **Healthchecks.io** | мониторинг | login Дмитрия | Дмитрий | **TODO** |
| **Uptime Kuma** (up.9wb.ru + up-spb.9wb.ru) | self-hosted мониторинг | login на UI | Дмитрий | **TODO** |
| **Финансовые системы** (банк, налоговая, бухгалтерия) | вне scope этого репо, но критично для бизнеса | Дмитрий | **TODO** |

---

## SSH-hosts mapping

| Alias (`~/.ssh/config`) | Host / IP | Назначение |
|---|---|---|
| `my-server` | hip.hosting Стокгольм | Главный VPS: adapter, bridge, dashboard, customer-service, CH, MySQL, monitor-bot, и т.д. |
| `server-spb` | 31.128.43.68 (СПб) | website 1begovoy.ru + WireGuard VPN |
| `server-clickhouse-old` | 185.26.120.23 (hostland.pro) | Legacy CH 22.1, read-only |
| `beget-trial2` | shared hosting Beget | Legacy 1begovoy.ru до миграции |
| `pb-vps` | СПб (тот же что server-spb?) | WireGuard сервер |

Все ключи — Bitwarden `server: <alias>_key` entries.

---

## Что произойдёт без backup-person

| Сценарий | Сколько часов простоя |
|---|---|
| Дмитрий вне связи 1 день, ничего критичного не сломалось | 0 (саморегулируется) |
| Дмитрий вне связи 1 день, **сломался** один сервис на my-server | ~24ч (никто не рестартанет/откатит) |
| Дмитрий вне связи 1 неделя, **сдох** my-server | **бесконечно** (никто не восстановит из бэкапа) |
| Дмитрий вне связи 1 месяц | **бизнес встаёт** — operators не могут принять платёж, CRM не отвечает |

**P(unavailability) × Impact** = серьёзный risk. Mitigation — назначить
backup-person для критичной категории (🔴).

---

## Plan

1. **Назначить backup-person** для категории 🔴 — см. ADR.
2. **Bitwarden Emergency Access** — настроить (Bitwarden Premium feature).
3. **Sealed envelope** в банковской ячейке с Master pwd + 2FA recovery codes — backup на случай Bitwarden недоступности.
4. **Документировать** имя/контакт backup-person здесь.
5. **Тест** — раз в полгода симулировать «Дмитрий недоступен» — проверить
   что backup-person реально может восстановить.

---

## Связано

- `decisions/2026-05-26-access-matrix-spof-mitigation.md` — ADR
- `~/claude_code/server-ubuntu-setup/SECRETS.md` — авторитетный список
  секретов (что лежит, где master, какой chmod)
- `RUNBOOKS/secret-leak-recovery.md` — что делать при утечке
- `RUNBOOKS/incident-response.md` — incident response (включает
  эскалацию когда backup-person вступает в роль)
