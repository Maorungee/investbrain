/**
 * Serves the app shell and proxies company data, so the browser only ever talks to this server.
 * Configure with the PORT and DATA_PROVIDER environment variables.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProvider } from './providers/index.mjs';

const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};
const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9.\-]{0,14}$/;
const MARKETS = ['US', 'TH'];
const CACHE_MS = 15 * 60 * 1000;

function json(response, status, body) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
}

async function serveStatic(pathname, response) {
    const relative = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
    const file = join(PUBLIC_DIR, relative);
    if (!file.startsWith(PUBLIC_DIR + sep)) {
        return json(response, 403, { message: 'Forbidden' });
    }
    try {
        const content = await readFile(file);
        const type = MIME[extname(file)] || 'application/octet-stream';
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300' });
        response.end(content);
    } catch {
        json(response, 404, { message: 'Not found' });
    }
}

/**
 * @param {{provider?: object|null, now?: () => number}} options provider is injectable for tests
 */
export function createApp({ provider = createProvider(process.env), now = Date.now } = {}) {
    const cache = new Map();
    const cached = async (key, load) => {
        const hit = cache.get(key);
        if (hit && now() - hit.at < CACHE_MS) {
            return hit.value;
        }
        const value = await load();
        cache.set(key, { at: now(), value });

        return value;
    };

    return async function handle(request, response) {
        const url = new URL(request.url, 'http://localhost');
        if (request.method !== 'GET') {
            return json(response, 405, { message: 'Method not allowed' });
        }
        if (!url.pathname.startsWith('/api/')) {
            return serveStatic(url.pathname, response);
        }
        if (url.pathname === '/api/status') {
            return json(response, 200, { provider: provider?.name ?? null });
        }
        if (!provider) {
            return json(response, 501, { message: 'No data provider configured' });
        }
        const market = (url.searchParams.get('market') || 'US').toUpperCase();
        if (!MARKETS.includes(market)) {
            return json(response, 400, { message: 'ตลาดไม่ถูกต้อง' });
        }
        try {
            if (url.pathname === '/api/company') {
                const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
                if (!SYMBOL_PATTERN.test(symbol)) {
                    return json(response, 400, { message: 'ชื่อย่อหุ้นไม่ถูกต้อง' });
                }
                const company = await cached(`company:${market}:${symbol}`, () => provider.company(symbol, market));

                return company ? json(response, 200, company) : json(response, 404, { message: 'ไม่พบหุ้นนี้' });
            }
            if (url.pathname === '/api/search') {
                const query = (url.searchParams.get('q') || '').trim().slice(0, 40);
                if (!query) {
                    return json(response, 400, { message: 'กรอกคำค้น' });
                }
                const results = await cached(`search:${market}:${query.toLowerCase()}`, () => provider.search(query, market));

                return json(response, 200, { results });
            }

            return json(response, 404, { message: 'Not found' });
        } catch (error) {
            console.error(`[${provider.name}] ${url.pathname} failed: ${error.message}`);

            return json(response, 502, { message: 'แหล่งข้อมูลไม่ตอบกลับ ลองใหม่อีกครั้ง หรือกรอกตัวเลขเอง' });
        }
    };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const port = Number(process.env.PORT) || 3000;
    createServer(createApp()).listen(port, () => console.log(`Valuation app listening on http://localhost:${port}`));
}
