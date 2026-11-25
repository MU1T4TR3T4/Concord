// Mostra todas as contas cadastradas no servidor publicado.
// Uso: cd server && node scripts/list-users.mjs
// A chave fica em server/.dev.vars (ADMIN_KEY=...), que não vai para o GitHub,
// e tem de ser a mesma do segredo ADMIN_KEY do servidor (npx wrangler secret put ADMIN_KEY).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = (file, name) => new RegExp(`^${name}=(.*)$`, 'm').exec(readFileSync(file, 'utf8'))?.[1].trim();
const key = read(join(root, '.dev.vars'), 'ADMIN_KEY');
const server = process.argv[2] ?? read(join(root, '../app/.env.production'), 'VITE_SERVER_URL');
if (!key) throw new Error('ADMIN_KEY não encontrado em server/.dev.vars');

const res = await fetch(`${server}/api/admin/users`, { headers: { Authorization: `Bearer ${key}` } });
if (!res.ok) throw new Error(`Servidor respondeu ${res.status}: ${await res.text()}`);
const users = await res.json();
console.log(`${users.length} contas em ${server}\n`);
for (const u of users) {
  const when = new Date(u.createdAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  console.log(`${u.username.padEnd(22)} ${u.displayName.padEnd(26)} ${when}`);
}
