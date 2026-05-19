#!/usr/bin/env bash
# Идемпотентно создаёт UF поле UF_CRM_PB_CUSTOMER_UUID на сущностях
# lead + contact + deal в Bitrix24. Поле — string, max 36 chars (UUID).
#
# Использует BITRIX_WEBHOOK_URL из /home/dv/greenapi-b24/.env.
# Токен не разворачивается в shell-аргументы — только в URL внутри curl.
#
# Usage (на my-server):
#   bash scripts/init_uf_customer_uuid.sh

set -euo pipefail

ENV_FILE="${ENV_FILE:-/home/dv/greenapi-b24/.env}"
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found" >&2
    exit 1
fi

# shellcheck disable=SC1090
WH=$(grep '^BITRIX_WEBHOOK_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | sed 's:/*$::')
if [ -z "$WH" ]; then
    echo "ERROR: BITRIX_WEBHOOK_URL not set" >&2
    exit 1
fi

FIELD_NAME="UF_CRM_PB_CUSTOMER_UUID"

ensure_field() {
    local entity="$1"   # lead | contact | deal

    # 1. Проверяем существование
    local list_resp count
    list_resp=$(curl -sf -G "${WH}/crm.${entity}.userfield.list" \
        --data-urlencode 'order[ID]=ASC' 2>&1) || {
        echo "ERROR: list failed for $entity" >&2
        return 1
    }
    count=$(echo "$list_resp" | python3 -c "
import sys, json
d = json.load(sys.stdin)
res = d.get('result', [])
match = [x for x in res if x.get('FIELD_NAME') == '$FIELD_NAME']
print(len(match))
")
    if [ "$count" -gt 0 ]; then
        echo "  [$entity] $FIELD_NAME уже есть — skip"
        return 0
    fi

    # 2. Создаём
    local payload
    payload=$(cat <<JSON
{
  "fields": {
    "FIELD_NAME": "$FIELD_NAME",
    "USER_TYPE_ID": "string",
    "XML_ID": "PB_CUSTOMER_UUID",
    "EDIT_FORM_LABEL": {"ru": "Customer UUID", "en": "Customer UUID"},
    "LIST_COLUMN_LABEL": {"ru": "Customer UUID", "en": "Customer UUID"},
    "LIST_FILTER_LABEL": {"ru": "Customer UUID", "en": "Customer UUID"},
    "SETTINGS": {
      "DEFAULT_VALUE": "",
      "SIZE": 40,
      "ROWS": 1,
      "REGEXP": "",
      "MIN_LENGTH": 0,
      "MAX_LENGTH": 36
    },
    "MANDATORY": "N",
    "MULTIPLE": "N",
    "SHOW_FILTER": "Y",
    "SHOW_IN_LIST": "N",
    "EDIT_IN_LIST": "N",
    "IS_SEARCHABLE": "Y"
  }
}
JSON
)
    local add_resp
    add_resp=$(curl -sf -X POST "${WH}/crm.${entity}.userfield.add" \
        -H 'Content-Type: application/json' \
        --data "$payload" 2>&1) || {
        echo "ERROR: add failed for $entity: $(echo "$add_resp" | head -c 300)" >&2
        return 1
    }
    local new_id
    new_id=$(echo "$add_resp" | python3 -c "
import sys, json
d = json.load(sys.stdin)
r = d.get('result')
if isinstance(r, int):
    print(r)
else:
    print('FAIL:' + str(d))
    sys.exit(1)
")
    echo "  [$entity] $FIELD_NAME создан, ID=$new_id"
}

echo "=== Init $FIELD_NAME on Bitrix24 ==="
ensure_field lead
ensure_field contact
ensure_field deal
echo "=== DONE ==="
