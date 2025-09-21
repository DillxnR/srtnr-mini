// this is the worker, it handles the requests and responses.
// it's written in typescript and uses cloudflare kv and secrets store to manage links on the edge.
// 
// author: dillon ring, iam@dillonri.ng, github.com/dillxnr/srtnr-mini

type KVGetOptions = { type?: 'text' | 'json' | 'arrayBuffer' };
interface KVNamespaceCompat {
  get(key: string, options?: KVGetOptions): Promise<any | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list?(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}


interface StoredLink {
  originalUrl: string;
  slug: string;
  created: string; // ISO date
}

// generate slugs: 6 characters, but you can change this by changing the `6` in the for loop to the number of characters you want.
// alphanumeric - a-z, A-Z, 0-9
function generateSlug(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let slug = '';
  for (let i = 0; i < 6; i++) {
    slug += chars[Math.floor(Math.random() * chars.length)];
  }
  return slug;
}

// this function checks if the slug exists, and if it does, it generates a new one.
// it retries up to 5 times to generate a unique slug.
async function getUniqueSlug(kv: KVNamespaceCompat, customSlug?: string, retries = 5): Promise<string> {
  let slug = customSlug || generateSlug();
  for (let i = 0; i < retries; i++) {
    const existing = await kv.get(slug);
    if (!existing) return slug;
    if (customSlug) throw new Error('Custom slug already exists');
    slug = generateSlug(); // Retry only for auto-gen
  }
  throw new Error('Failed to generate unique slug after retries');
}

export interface Env {
  URL_KV: KVNamespaceCompat;
  API_KEYS: { get: () => Promise<string | null> } | string;
  LINK_CLICKS_KV: KVNamespaceCompat;
}

// this function validates the api key.
// it extracts the api key from the request headers and validates it.
// it also checks if the api key is in the secrets store.
// if the api key is not in the secrets store, it returns null.
// if the api key is in the secrets store, it returns the api key.
// if the api key is not in the secrets store, it returns null.
async function validateApiKey(request: Request, env: Env): Promise<string[] | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const providedKey = authHeader.substring(7);

  try {
    let secretValue: string | null = null;
    if (typeof env.API_KEYS === 'string') {
      secretValue = env.API_KEYS;
    } else if (env.API_KEYS && typeof (env.API_KEYS as any).get === 'function') {
      secretValue = await (env.API_KEYS as { get: () => Promise<string | null> }).get();
    }
    if (!secretValue) {
      console.error('Secrets Store: No secret value found' );
      return null; // Config error
    }
    const allowedKeys = JSON.parse(secretValue) as string[];
    if (!allowedKeys.includes(providedKey)) {
      return null; // Unauthorized
    }
    return allowedKeys; // Valid, but we don't need the array—just for validation
  } catch (error) {
    console.error('Auth error:', error);
    return null; // Any binding error → server issue
  }
}

// Main fetch handler
export default {
  async fetch(request: Request, env: Env, ctx?: { waitUntil: (p: Promise<any>) => void; passThroughOnException?: () => void }): Promise<Response> {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;

      const json = (data: unknown, init?: ResponseInit) =>
        new Response(JSON.stringify(data), {
          ...(init || {}),
          headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
        });

      const getClickCount = async (slug: string): Promise<number> => {
        try {
          const raw = await env.LINK_CLICKS_KV.get(slug);
          const n = parseInt(raw == null ? '0' : String(raw), 10);
          return Number.isFinite(n) ? n : 0;
        } catch {
          return 0;
        }
      };

      const incrementClickCount = async (slug: string): Promise<void> => {
        try {
          const raw = await env.LINK_CLICKS_KV.get(slug);
          const current = parseInt(raw == null ? '0' : String(raw), 10);
          const next = (Number.isFinite(current) ? current : 0) + 1;
          await env.LINK_CLICKS_KV.put(slug, String(next));
        } catch (e) {
          console.error('clicks increment error:', e);
        }
      };

      const getLinkInfo = async (slug: string): Promise<{ slug: string; destination: string; created: string; clicks: number } | null> => {
        const stored = (await env.URL_KV.get(slug, { type: 'json' })) as StoredLink | null;
        if (!stored) return null;
        const clicks = await getClickCount(slug);
        return { slug: stored.slug, destination: stored.originalUrl, created: stored.created, clicks };
      };
      // root route, you can change this, but right now it's just a health check.
      if (request.method === 'GET' && pathname === '/') {
        return json({ ok: true, service: 'srtnr-mini' });
      }

      // API: shorten a link (POST /api/shorten) [auth required]
      if (request.method === 'POST' && pathname === '/api/shorten') {
        const allowedKeys = await validateApiKey(request, env);
        if (allowedKeys === null) {
          return json({ error: 'missing or invalid API key' }, { status: 401 });
        }

        try {
          const body = (await request.json()) as { url: string; slug?: string };
          if (!body.url || typeof body.url !== 'string' || !body.url.startsWith('http')) {
            return json({ error: 'Invalid URL' }, { status: 400 });
          }

          const slug = await getUniqueSlug(env.URL_KV, body.slug);
          const linkData: StoredLink = {
            originalUrl: body.url,
            slug,
            created: new Date().toISOString(),
          };
          await env.URL_KV.put(slug, JSON.stringify(linkData));

          return json({ shortUrl: `${url.origin}/${slug}`, slug });
        } catch (error) {
          console.error('Shorten error:', error);
          return json({ error: 'Server Error' }, { status: 500 });
        }
      }

      // API: Delete a link (DELETE /api/delete)
      if (request.method === 'DELETE' && pathname === '/api/delete') {
        const allowedKeys = await validateApiKey(request, env);
        if (allowedKeys === null) {
          return json({ error: 'missing or invalid API key' }, { status: 401 });
        }

        try {
          const body = (await request.json()) as { slug: string };
          if (!body.slug) {
            return json({ error: 'missing slug' }, { status: 400 });
          }

          const existing = await env.URL_KV.get(body.slug);
          if (!existing) {
            return json({ error: 'slug not found' }, { status: 404 });
          }
          await env.URL_KV.delete(body.slug);
          return json({ message: 'link deleted' });
        } catch (error) {
          console.error('Delete error:', error);
          return json({ error: 'server error' }, { status: 500 });
        }
      }

      // API: Get info for a slug (GET /api/links/:slug) and alias (GET /links/:slug) [auth required]
      if (
        request.method === 'GET' &&
        ((pathname.startsWith('/api/links/') && pathname.length > '/api/links/'.length) ||
         (pathname.startsWith('/links/') && pathname.length > '/links/'.length))
      ) {
        const base = pathname.startsWith('/api/links/') ? '/api/links/' : '/links/';
        const slug = decodeURIComponent(pathname.slice(base.length));
        const allowedKeys = await validateApiKey(request, env);
        if (allowedKeys === null) {
          return json({ error: 'missing or invalid API key' }, { status: 401 });
        }
        try {
          const info = await getLinkInfo(slug);
          if (!info) return json({ error: 'slug not found' }, { status: 404 });
          return json(info);
        } catch (error) {
          console.error('get link info error:', error);
          return json({ error: 'server error' }, { status: 500 });
        }
      }

      // API: list all links (GET /api/links) and alias (GET /links) [auth required]
      if (
        request.method === 'GET' &&
        (pathname === '/api/links' || pathname === '/api/links/' || pathname === '/links' || pathname === '/links/')
      ) {
        const allowedKeys = await validateApiKey(request, env);
        if (allowedKeys === null) {
          return json({ error: 'missing or invalid API key' }, { status: 401 });
        }

        try {
          const keys: string[] = [];
          if (typeof env.URL_KV.list === 'function') {
            let cursor: string | undefined = undefined;
            do {
              const res = await env.URL_KV.list({ cursor, limit: 1000 });
              for (const k of res.keys) keys.push(k.name);
              cursor = res.cursor;
              if (res.list_complete) break;
            } while (cursor);
          } else {
            // if list is unavailable, we cannot enumerate keys
            return json({ error: 'KV list not supported in this environment' }, { status: 501 });
          }

          const uniqueKeys = Array.from(new Set(keys));
          const batches: Array<Promise<{ slug: string; destination: string; created: string; clicks: number } | null>> = [];
          for (const slug of uniqueKeys) {
            batches.push(getLinkInfo(slug));
          }
          const results = (await Promise.all(batches)).filter((x): x is { slug: string; destination: string; created: string; clicks: number } => x !== null);
          return json({ links: results });
        } catch (error) {
          console.error('list links error:', error);
          return json({ error: 'server error' }, { status: 500 });
        }
      }

      // redirect for shortened slugs (non-API paths)
      if (request.method === 'GET' && !pathname.startsWith('/api/')) {
        const slug = pathname.startsWith('/') ? pathname.slice(1) : pathname;
        if (!slug) return new Response('not found', { status: 404 });
        try {
          const stored = (await env.URL_KV.get(slug, { type: 'json' })) as StoredLink | null;
          if (!stored) {
            return new Response('not found', { status: 404 });
          }
          if (ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(incrementClickCount(slug));
          } else {
            // fallback (dev environments without ctx)
            incrementClickCount(slug);
          }
          return Response.redirect(stored.originalUrl, 301);
        } catch (error) {
          console.error('KV get error:', error);
          return new Response('server error', { status: 500 });
        }
      }

      return new Response('not found', { status: 404 });
    } catch (error) {
      console.error('unhandled error in fetch:', error);
      return new Response('server error', { status: 500 });
    }
  },
};