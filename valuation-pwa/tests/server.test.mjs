import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { createProvider } from '../providers/index.mjs';
import { COLUMNS, createTradingViewProvider, normalizeRow } from '../providers/tradingview.mjs';
import { createApp } from '../server.mjs';

const rowFor = (values) => ({ s: `${values.exchange}:${values.name}`, d: COLUMNS.map((column) => values[column] ?? null) });
const PTT = {
    name: 'PTT', description: 'PTT Public Co., Ltd.', exchange: 'SET', type: 'stock', sector: 'Energy Minerals', close: 37.6,
    currency: 'THB', fundamental_currency_code: 'THB', total_shares_outstanding: 28085639600, total_revenue_ttm: 2971612027234,
    oper_income_ttm: 387697303753, ebit_ttm: 387697303750, total_debt_fq: 1031314112176, cash_n_short_term_invest_fq: 432036912468,
    total_equity_fq: 1795049795703, shrhldrs_equity_fq: 1195049795703, effective_interest_rate_on_debt_ttm: 3.2, after_tax_margin: 4.8, pre_tax_margin_ttm: 10,
    beta_5_year: 0.6, beta_1_year: 0.77, fiscal_period_end_fq: 1790726400, total_revenue_fy_h: [2662e9, 3090e9, 3144e9, 3367e9, 2258e9, 1615e9, 2219e9],
};
const BANK = { ...PTT, name: 'KBANK', description: 'Kasikornbank', sector: 'Finance', ebit_ttm: null, cash_n_short_term_invest_fq: null, effective_interest_rate_on_debt_ttm: 0 };

test('a screener row becomes the company shape the app expects', () => {
    const company = normalizeRow(rowFor(PTT));
    assert.equal(company.symbol, 'PTT');
    assert.equal(company.currency, 'THB');
    assert.equal(company.price, 37.6);
    assert.equal(company.revenue, 2971612027234);
    assert.equal(company.ebit, 387697303750);
    assert.ok(Math.abs(company.interestExpense - 0.032 * 1031314112176) < 1);
    assert.ok(Math.abs(company.taxRate - 0.52) < 1e-9);
    assert.equal(company.beta, 0.6);
    assert.equal(company.period, 'งบ 12 เดือนล่าสุด ถึง 2026-09-30');
    assert.deepEqual(company.history.map((row) => row.revenue), [2258e9, 3367e9, 3144e9, 3090e9, 2662e9]);
    assert.equal(company.minority, 600000000000);
    assert.ok(company.notes[0].includes('ส่วนของผู้ถือหุ้นส่วนน้อย'));
    assert.equal(normalizeRow(rowFor({ ...PTT, shrhldrs_equity_fq: null })).minority, 0);
    assert.deepEqual(normalizeRow(rowFor({ ...PTT, shrhldrs_equity_fq: PTT.total_equity_fq })).notes, []);
});

test('financial companies and missing figures are flagged, not guessed', () => {
    const company = normalizeRow(rowFor(BANK));
    assert.equal(company.ebit, PTT.oper_income_ttm);
    assert.equal(company.cash, 0);
    assert.equal(company.interestExpense, 0);
    assert.ok(company.notes.some((note) => note.includes('FCFF ไม่เหมาะ')));
    const adr = normalizeRow(rowFor({ ...PTT, currency: 'USD', fundamental_currency_code: 'TWD', after_tax_margin: null }));
    assert.equal(adr.taxRate, null);
    assert.ok(adr.notes.some((note) => note.includes('แปลงสกุลเงิน')));
});

test('the provider queries the right market and prefers common stock', async () => {
    const calls = [];
    const fetchStub = async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });

        return { ok: true, json: async () => ({ data: [rowFor({ ...PTT, type: 'dr', name: 'PTT.R' }), rowFor(PTT)] }) };
    };
    const provider = createTradingViewProvider({ fetch: fetchStub });
    const company = await provider.company('PTT', 'TH');
    assert.equal(company.symbol, 'PTT');
    assert.equal(calls[0].url, 'https://scanner.tradingview.com/thailand/scan');
    assert.deepEqual(calls[0].body.filter[0], { left: 'name', operation: 'equal', right: 'PTT' });
    await provider.search('apple', 'US');
    assert.equal(calls[1].url, 'https://scanner.tradingview.com/america/scan');
});

test('the provider returns null for unknown tickers and throws on upstream errors', async () => {
    const empty = createTradingViewProvider({ fetch: async () => ({ ok: true, json: async () => ({ data: [] }) }) });
    assert.equal(await empty.company('NOPE', 'US'), null);
    const failing = createTradingViewProvider({ fetch: async () => ({ ok: false, status: 429 }) });
    await assert.rejects(() => failing.company('AAPL', 'US'), /429/);
});

test('provider selection follows the environment', () => {
    assert.equal(createProvider({}).name, 'tradingview');
    assert.equal(createProvider({ DATA_PROVIDER: 'none' }), null);
});

let server;
let base;
let loads = 0;
const stubProvider = {
    name: 'stub',
    company: async (symbol) => {
        loads++;
        if (symbol === 'BOOM') {
            throw new Error('upstream down');
        }

        return symbol === 'AAPL' ? { symbol: 'AAPL', price: 100 } : null;
    },
    search: async (query) => [{ symbol: 'AAPL', name: `match for ${query}`, exchange: 'NASDAQ' }],
};
const get = async (path, origin = base) => {
    const response = await fetch(origin + path);

    return { status: response.status, type: response.headers.get('content-type'), text: await response.text() };
};

before(async () => {
    server = createServer(createApp({ provider: stubProvider }));
    await new Promise((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('the server serves the app shell and blocks paths outside it', async () => {
    const home = await get('/');
    assert.equal(home.status, 200);
    assert.match(home.type, /text\/html/);
    assert.match(home.text, /ราคาเหมาะสม/);
    assert.match((await get('/manifest.webmanifest')).type, /manifest\+json/);
    assert.equal((await get('/missing.js')).status, 404);
    assert.notEqual((await get('/..%2Fserver.mjs')).status, 200);
    assert.notEqual((await get('/%2e%2e/package.json')).status, 200);
});

test('company lookups are validated, cached and mapped to status codes', async () => {
    const found = await get('/api/company?symbol=aapl&market=US');
    assert.equal(found.status, 200);
    assert.equal(JSON.parse(found.text).symbol, 'AAPL');
    await get('/api/company?symbol=AAPL&market=US');
    assert.equal(loads, 1);
    assert.equal((await get('/api/company?symbol=ZZZZ&market=TH')).status, 404);
    assert.equal((await get('/api/company?symbol=A%20B&market=US')).status, 400);
    assert.equal((await get('/api/company?symbol=AAPL&market=JP')).status, 400);
    assert.equal((await get('/api/company?symbol=BOOM&market=US')).status, 502);
});

test('search, status and unsupported routes respond as documented', async () => {
    const search = await get('/api/search?q=apple&market=US');
    assert.equal(JSON.parse(search.text).results[0].symbol, 'AAPL');
    assert.equal((await get('/api/search?q=&market=US')).status, 400);
    assert.equal(JSON.parse((await get('/api/status')).text).provider, 'stub');
    assert.equal((await get('/api/unknown')).status, 404);
    assert.equal((await fetch(`${base}/api/status`, { method: 'POST' })).status, 405);
});

test('without a provider the api reports that data is not configured', async () => {
    const bare = createServer(createApp({ provider: null }));
    await new Promise((resolve) => bare.listen(0, resolve));
    const origin = `http://127.0.0.1:${bare.address().port}`;
    assert.equal((await get('/api/company?symbol=AAPL&market=US', origin)).status, 501);
    assert.equal(JSON.parse((await get('/api/status', origin)).text).provider, null);
    bare.close();
});
