# Concord

Aplicativo de voz, salas e transmissão de tela para um grupo de amigos.

- `app/` — aplicativo de computador (Electron + React + TypeScript).
- `server/` — servidor (Cloudflare Workers + Durable Object com SQLite). Voz e tela passam pelo Cloudflare Realtime SFU.

## Desenvolvimento

Servidor local (sem voz, que depende dos segredos da Cloudflare):

```bash
cd server && npm install && npm run dev
```

Aplicativo apontando para o servidor local:

```bash
cd app && npm install && npm run dev
```

## Publicar

Servidor:

```bash
cd server && npx wrangler deploy
```

Segredos do servidor (definidos com `npx wrangler secret put NOME`):

- `REGISTRATION_CODE` — código exigido para criar conta.
- `SFU_APP_ID` e `SFU_APP_SECRET` — app do Cloudflare Realtime SFU.

Instalador para Windows (sai em `app/release/`, usando a URL de `app/.env.production`):

```bash
cd app && npm run dist
```
