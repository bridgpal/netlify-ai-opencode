#!/usr/bin/env sh
# Prints a RELAY_KEYS entry. Usage: scripts/gen-key.sh alice
name="${1:-key-1}"
secret="$(openssl rand -hex 32)"
echo "${name}:${secret}"
