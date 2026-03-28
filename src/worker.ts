import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Bindings = {
  ALLOWED_ORIGINS?: string;
  BASE_PATH?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// --- Helpers ---

function resolveUrl(url: string, base: string): string {
  if (!url || url.trim() === '') return url;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) {
    try {
      const baseUrl = new URL(base);
      return `${baseUrl.protocol}//${baseUrl.host}${url}`;
    } catch {
      return base + url;
    }
  }
  return base + '/' + url;
}

function proxyM3u8Url(url: string, base: string, headers: string, basePath: string): string {
  const fullUrl = resolveUrl(url, base);
  return `${basePath}/m3u8-proxy.m3u8?url=${encodeURIComponent(encodeURIComponent(fullUrl))}&headers=${headers}`;
}

function proxySegmentUrl(url: string, base: string, headers: string, basePath: string): string {
  const fullUrl = resolveUrl(url, base);
  return `${basePath}/ts-proxy.ts?url=${encodeURIComponent(encodeURIComponent(fullUrl))}&headers=${headers}`;
}

function replaceUriAttribute(line: string, proxyFn: (uri: string) => string): string {
  const match = line.match(/URI="([^"]+)"/);
  if (match) {
    const originalUri = match[1];
    const proxiedUri = proxyFn(originalUri);
    return line.replace(`URI="${originalUri}"`, `URI="${proxiedUri}"`);
  }
  return line;
}

function processLine(
  line: string,
  base: string,
  headers: string,
  basePath: string
): string {
  const trimmed = line.trim();
  if (trimmed === '' || (trimmed.startsWith('#') && !trimmed.startsWith('#EXT'))) return line;
  if (trimmed.startsWith('#EXT-X-STREAM-INF')) return line;
  if (trimmed.startsWith('#EXT-X-I-FRAME-STREAM-INF')) return replaceUriAttribute(line, (uri) => proxyM3u8Url(uri, base, headers, basePath));
  if (trimmed.startsWith('#EXT-X-KEY')) {
    if (trimmed.includes('METHOD=NONE')) return line;
    return replaceUriAttribute(line, (uri) => proxySegmentUrl(uri, base, headers, basePath));
  }
  if (trimmed.startsWith('#EXT-X-SESSION-KEY')) {
    if (trimmed.includes('METHOD=NONE')) return line;
    return replaceUriAttribute(line, (uri) => proxySegmentUrl(uri, base, headers, basePath));
  }
  if (trimmed.startsWith('#EXT-X-MAP')) return replaceUriAttribute(line, (uri) => proxySegmentUrl(uri, base, headers, basePath));
  if (trimmed.startsWith('#EXT-X-MEDIA')) {
    if (trimmed.includes('URI="')) return replaceUriAttribute(line, (uri) => proxyM3u8Url(uri, base, headers, basePath));
    return line;
  }
  if (trimmed.startsWith('#EXT-X-SESSION-DATA')) {
    if (trimmed.includes('URI="')) return replaceUriAttribute(line, (uri) => proxySegmentUrl(uri, base, headers, basePath));
    return line;
  }
  if (trimmed.startsWith('#EXT-X-PART:')) return replaceUriAttribute(line, (uri) => proxySegmentUrl(uri, base, headers, basePath));
  if (trimmed.startsWith('#EXT-X-PRELOAD-HINT')) return replaceUriAttribute(line, (uri) => proxySegmentUrl(uri, base, headers, basePath));
  if (trimmed.startsWith('#EXT-X-RENDITION-REPORT')) return replaceUriAttribute(line, (uri) => proxyM3u8Url(uri, base, headers, basePath));
  if (trimmed.startsWith('#EXT-X-DATERANGE')) {
    if (trimmed.includes('X-ASSET-URI="')) {
      const match = line.match(/X-ASSET-URI="([^"]+)"/);
      if (match) {
        const originalUri = match[1];
        const proxiedUri = proxySegmentUrl(originalUri, base, headers, basePath);
        return line.replace(`X-ASSET-URI="${originalUri}"`, `X-ASSET-URI="${proxiedUri}"`);
      }
    }
  }
  if (trimmed.startsWith('#EXT-X-IMAGE-STREAM-INF')) return replaceUriAttribute(line, (uri) => proxyM3u8Url(uri, base, headers, basePath));
  if (trimmed.startsWith('#EXT-X-TILES')) return replaceUriAttribute(line, (uri) => proxySegmentUrl(uri, base, headers, basePath));
  return line;
}

// --- App ---

app.use('*', async (c, next) => {
  const origins = c.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean) || [];
  const allowAll = origins.length === 0 || origins.includes('*');

  return cors({
    origin: (origin) => {
      if (allowAll || origins.includes(origin)) return origin;
      return null;
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'Range'],
    exposeHeaders: ['Content-Length', 'Content-Range'],
    maxAge: 86400,
  })(c, next);
});

app.get('/m3u8-proxy.m3u8', async (c) => {
  const url = decodeURIComponent(c.req.query('url') || '');
  const headersStr = decodeURIComponent(c.req.query('headers') || '{}');
  const basePath = c.env.BASE_PATH || new URL(c.req.url).origin;

  // ✅ Fixed: Use { status: ... } object format
  if (!url) return c.json({ error: 'Invalid URL parameter' }, { status: 400 });

  let headersJson = {};
  try {
    headersJson = JSON.parse(headersStr);
  } catch (e) { }

  const hString = encodeURIComponent(JSON.stringify(headersJson));

  try {
    const response = await fetch(url, { headers: headersJson });
    if (!response.ok) return c.json({ error: `Upstream returned ${response.status}` }, response.status);

    const data = await response.text();
    const lines = data.split('\n');
    const result: string[] = [];

    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/');
    pathParts.pop();
    const base = `${urlObj.protocol}//${urlObj.host}${pathParts.join('/')}`;

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed.startsWith('#EXT-X-STREAM-INF') || trimmed.includes('BANDWIDTH')) {
        result.push(line);
        i++;
        if (i < lines.length) {
          const urlLine = lines[i].trim();
          if (urlLine && !urlLine.startsWith('#')) result.push(proxyM3u8Url(urlLine, base, hString, basePath));
          else result.push(lines[i]);
        }
        i++;
        continue;
      }

      if (trimmed.startsWith('#EXTINF')) {
        result.push(line);
        i++;
        if (i < lines.length) {
          const urlLine = lines[i].trim();
          if (urlLine && !urlLine.startsWith('#')) result.push(proxySegmentUrl(urlLine, base, hString, basePath));
          else result.push(lines[i]);
        }
        i++;
        continue;
      }

      if (trimmed.startsWith('#EXT-X-BYTERANGE') && !trimmed.includes('@')) {
        result.push(line);
        i++;
        if (i < lines.length) {
          const nextLine = lines[i].trim();
          if (nextLine && !nextLine.startsWith('#')) {
            result.push(proxySegmentUrl(nextLine, base, hString, basePath));
            i++;
          }
        }
        continue;
      }

      result.push(processLine(line, base, hString, basePath));
      i++;
    }

    return c.text(result.join('\n'), 200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=86400'
    });
  } catch (error) {
    console.error("M3U8 error:", error);
    // ✅ Fixed: Use { status: ... } object format
    return c.json({ error: 'Failed to fetch the m3u8 URL' }, { status: 500 });
  }
});

app.get('/ts-proxy.ts', async (c) => {
  const url = decodeURIComponent(c.req.query('url') || '');
  const headersStr = c.req.query('headers');
  const headers = headersStr ? JSON.parse(headersStr) : {};

  // ✅ Fixed: Use { status: ... } object format
  if (!url) return c.json({ error: 'URL parameter is required' }, { status: 400 });

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return c.json({ error: `Upstream returned ${response.status}` }, response.status);

    const newHeaders = new Headers(response.headers);
    newHeaders.set('Access-Control-Allow-Origin', '*');
    newHeaders.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=86400');

    return new Response(response.body, {
      status: response.status,
      headers: newHeaders
    });
  } catch (error) {
    console.error("TS error:", error);
    // ✅ Fixed: Use { status: ... } object format
    return c.json({ error: 'Proxy error' }, { status: 500 });
  }
});

export default app;
