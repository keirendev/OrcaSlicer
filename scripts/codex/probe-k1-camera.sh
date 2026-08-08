#!/usr/bin/env bash
set -euo pipefail

host=${1:-${ORCA_PRINTER_HOST:-}}
host=${host#http://}
host=${host#https://}
host=${host%%/*}
host=${host%%:*}

if [[ -z "${host}" ]]; then
    echo "Usage: $0 <private-printer-host>" >&2
    exit 2
fi
if [[ ! "${host}" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|[A-Za-z0-9.-]+\.local$) ]]; then
    echo "Refusing to probe a non-LAN host: ${host}" >&2
    exit 2
fi

for port in 80 8000 8080 9999; do
    if timeout 3 bash -c "</dev/tcp/${host}/${port}" 2>/dev/null; then
        printf 'port=%s state=open\n' "${port}"
    else
        printf 'port=%s state=closed\n' "${port}"
    fi
done

curl --silent --show-error --max-time 5 --write-out '\nhttp_status=%{http_code}\n' "http://${host}/info" || true
