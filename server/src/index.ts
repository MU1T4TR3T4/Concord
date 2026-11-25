import { Hub } from './hub';

export { Hub };

export interface Env {
  HUB: DurableObjectNamespace;
  /** Se definido, o cadastro exige este código (mantém estranhos fora). */
  REGISTRATION_CODE?: string;
  /** Se definido, libera a lista de contas em /api/admin/users para quem tiver esta chave. */
  ADMIN_KEY?: string;
  /** Nome de usuário do admin geral (dá selos, remove e adiciona pessoas). */
  ADMIN_USER?: string;
  /** Cloudflare Realtime SFU (voz e tela). */
  SFU_APP_ID?: string;
  SFU_APP_SECRET?: string;
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(req.url);
    if (url.pathname === '/') {
      return new Response(JSON.stringify({ name: 'concord', ok: true }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/ws' || url.pathname.startsWith('/api/')) {
      // Um único Hub guarda tudo: é um app privado para um grupo pequeno de amigos.
      const stub = env.HUB.get(env.HUB.idFromName('hub'));
      const res = await stub.fetch(req);
      if (res.status === 101) return res;
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
      return out;
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },
};
