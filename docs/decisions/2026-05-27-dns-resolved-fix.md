# ADR 2026-05-27: Fix recurring DNS-glitches on my-server

## Контекст

За 26-27.05.2026 зафиксировано минимум 3 случая `Temporary failure in name
resolution` / `i/o timeout` на my-server. Это не разовое — это **recurring
pattern**:

- **26.05** (DDoS hip.hosting + после): Docker Hub, Prisma CDN, GitHub
- **27.05 04:35 UTC**: api.moysklad.ru → cron moy-sklad/scripts/sync.py
  упал на каждом из 30+ endpoints
- **27.05 17:25**: Green API getStateInstance ETIMEDOUT 51.250.8.4:443

## Диагностика

```
sudo resolvectl statistics:
  Total Transactions: 768301
  Total Timeouts:      14185   # 1.85% — норма <0.1%
  Cache Hits/Misses:   371422 / 606014   # cache не помогает

sudo journalctl -u systemd-resolved:
  ... Using degraded feature set UDP instead of UDP+EDNS0 for DNS
      server 100.100.100.100 (Tailscale MagicDNS)
  ... Grace period over, resuming full feature set
  (2 цикла за 48 часов)

/etc/systemd/resolved.conf:    компилируемые дефолты, никакой кастомизации
/etc/systemd/resolved.conf.d/: не существует
/run/systemd/resolve/resolv.conf:
  nameserver 8.8.8.8
  nameserver 8.8.4.4
  nameserver 1.1.1.1
  # Too many DNS servers configured, the following entries may be ignored.
  nameserver 1.0.0.1
```

## Root cause (2 фактора, сложились в symptom)

1. **cloud-init DHCP залил 4 DNS-сервера** на ens3. Они попали как
   per-link servers, имеют DefaultRoute=+, перекрывают Global DNS.
   resolved их крутил rotation, при timeout 8.8.8.8 переходил на
   8.8.4.4/1.1.1.1, последний `1.0.0.1` игнорировался («too many»).
   Если 2 из 3 первых не отвечали — timeout.
2. **Tailscale MagicDNS** (100.100.100.100) для Link 3 (tailscale0)
   периодически рвёт UDP+EDNS0 и падает в degraded mode. На время
   degraded mode часть запросов timeout'ит.

При этом `Cache=no-negative` (дефолт) — кеш не сохраняет неудачные
ответы, и при следующем запросе всё повторяется.

## Решение

### A. Per-resolved drop-in `/etc/systemd/resolved.conf.d/10-claude-dns-fix.conf`

```ini
[Resolve]
DNS=1.1.1.1 8.8.8.8 9.9.9.9
FallbackDNS=1.0.0.1 8.8.4.4 149.112.112.112
Cache=yes
CacheFromLocalhost=no
DNSStubListener=yes
ReadEtcHosts=yes
```

3 провайдера + 3 fallback (Cloudflare, Google, Quad9) — устойчиво
к падению любого одного. `Cache=yes` — кешируем всё.

### B. Netplan override `/etc/netplan/99-claude-dns-override.yaml`

```yaml
network:
    version: 2
    ethernets:
        ens3:
            dhcp4-overrides:
                use-dns: false
                use-domains: false
```

DHCP всё ещё даёт IP (`dhcp4: true` в 50-cloud-init.yaml), но **DNS
не подсовывает**. ens3 Link 2 теперь `Current Scopes: none` — все
запросы идут через Global DNS из (A).

## Результат

Сразу после `netplan apply` + `systemctl restart systemd-resolved`:

```
Global
  Current DNS Server: 1.1.1.1
  DNS Servers: 1.1.1.1 8.8.8.8 9.9.9.9
  Fallback DNS Servers: 1.0.0.1 8.8.4.4 149.112.112.112

Link 2 (ens3)
  Current Scopes: none   # DHCP DNS отключены

Link 3 (tailscale0)
  DNS Servers: 100.100.100.100 …   # для tail6ea676.ts.net остался
```

Тест 4 проблемных доменов:
```
getent hosts api.moysklad.ru     # 185.71.64.179
getent hosts registry-1.docker.io # AAAA (IPv6 ok)
getent hosts github.com          # 140.82.121.3
getent hosts binaries.prisma.sh  # AAAA
```

Все <50ms. `Total Timeouts: 0` на 67 транзакций после рестарта.

## Snapshot конфигов

Файлы скопированы в `dv1-lab/server-ubuntu-setup` (sha `194bec2`):
- `dotfiles-server/etc/systemd/resolved.conf.d/10-claude-dns-fix.conf`
- `dotfiles-server/etc/netplan/99-claude-dns-override.yaml`

Установка на новом сервере (после bootstrap.sh):
```bash
sudo cp dotfiles-server/etc/systemd/resolved.conf.d/* \
    /etc/systemd/resolved.conf.d/
sudo cp dotfiles-server/etc/netplan/99-*.yaml /etc/netplan/
sudo chmod 600 /etc/netplan/99-claude-dns-override.yaml
sudo netplan apply
sudo systemctl restart systemd-resolved
```

## Что мониторить (следующие 48ч)

Если фикс работает — `Total Timeouts / Total Transactions` должно
остаться <0.1% после восстановления статистики (она была сброшена
рестартом). Проверять командой:
```bash
sudo resolvectl statistics | grep -E '(Transactions|Timeouts)'
```

Если timeouts опять появятся — копать в Tailscale (можно отключить
MagicDNS resolution через `sudo tailscale set --accept-dns=false`),
либо ставить локальный `unbound` как кеширующий resolver.

## Связано

- task #78 done (этот ADR)
- task #46 (DR-test) — после фикса стало менее срочным, но полезно
  проверить что новый VPS из bootstrap.sh применяет snapshot
- task #74 (переезд VPS) — частично снимает приоритет, фикс работает
  и на текущем hip.hosting
- memory `[[feedback-dns-glitches-my-server]]` — обновить статусом ✅
- REGRESSIONS 26-27.05 — добавить «Root cause найден и исправлен»
