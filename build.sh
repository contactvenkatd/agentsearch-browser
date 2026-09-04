#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

config_file="config.local.json"
args_file="out/Default/args.gn"

if [[ ! -f "$config_file" ]]; then
  echo "Missing $config_file; copy config.example.json and add local credentials." >&2
  exit 1
fi

mkdir -p "$(dirname "$args_file")"
touch "$args_file"

node - "$config_file" "$args_file" <<'NODE'
const fs = require('node:fs');

const [configFile, argsFile] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const clientId = config.google_oauth_client_id?.trim();
const clientSecret = config.google_oauth_client_secret?.trim();

if (!clientId || !clientSecret) {
  throw new Error(
    'config.local.json must define google_oauth_client_id and ' +
    'google_oauth_client_secret');
}

let args = fs.readFileSync(argsFile, 'utf8');
for (const name of [
  'google_api_key',
  'google_default_client_id',
  'google_default_client_secret',
]) {
  const assignment = new RegExp(
    `^${name}\\s*=\\s*(?:\\n\\s*)?"(?:[^"\\\\]|\\\\.)*"\\s*\\n?`, 'gm');
  args = args.replace(assignment, '');
}

args = args.replace(/\s*$/, '\n');
args += `google_default_client_id = ${JSON.stringify(clientId)}\n`;
args += `google_default_client_secret = ${JSON.stringify(clientSecret)}\n`;
fs.writeFileSync(argsFile, args, {encoding: 'utf8', mode: 0o600});
NODE

gn gen out/Default
autoninja -C out/Default chrome
