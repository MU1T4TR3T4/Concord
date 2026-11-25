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

## App Android

Fica em `android/`. É uma janela (WebView) com a versão web, mais captura de tela nativa e
serviço em segundo plano. Precisa do Java 17 e do Android SDK (plataforma 35).

```bash
cd android && ./build-apk.sh
```

O APK sai em `android/app/build/outputs/apk/release/` e é publicado junto com o servidor
(`cd server && npm run deploy`), em `https://<servidor>/concord.apk`.
