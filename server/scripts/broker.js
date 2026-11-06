// Mosquitto user/ACL management via the running compose container.
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const infra = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../infra');
export const passwdPath = path.join(infra, 'mosquitto/passwd');
export const aclPath = path.join(infra, 'mosquitto/acl');

const compose = (...args) =>
  execFileSync('docker', ['compose', '-f', path.join(infra, 'docker-compose.yml'), '--env-file', path.join(infra, '../.env'), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });

export function ensureBrokerFiles() {
  if (!existsSync(passwdPath)) writeFileSync(passwdPath, '');
  if (!existsSync(aclPath)) writeFileSync(aclPath, '');
}

export function setBrokerPassword(user, pass) {
  if (!/^[A-Za-z0-9_-]+$/.test(user)) throw new Error(`bad broker username: ${user}`);
  compose('exec', '-T', 'mosquitto', 'mosquitto_passwd', '-b', '/mosquitto/config/passwd', user, pass);
}

export function writeAcl(entries) {
  const text = entries.map(({ user, lines }) => [`user ${user}`, ...lines].join('\n')).join('\n\n') + '\n';
  writeFileSync(aclPath, text);
}

export function reloadBroker() {
  compose('kill', '-s', 'HUP', 'mosquitto');
}
