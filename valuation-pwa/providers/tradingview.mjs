/**
 * Company data from TradingView's screener endpoint. It needs no API key, but it is not a documented
 * public API: field names can change, and quotes may be delayed.
 */
const ENDPOINT = 'https://scanner.tradingview.com';
const SCREENS = { US: 'america', TH: 'thailand' };
const EQUITY_TYPES = ['stock', 'dr'];
const HISTORY_YEARS = 5;

export const COLUMNS = [
    'name', 'description', 'exchange', 'type', 'sector', 'close', 'currency', 'fundamental_currency_code',
    'total_shares_outstanding', 'total_revenue_ttm', 'oper_income_ttm', 'ebit_ttm', 'total_debt_fq',
    'cash_n_short_term_invest_fq', 'total_equity_fq', 'shrhldrs_equity_fq', 'effective_interest_rate_on_debt_ttm', 'after_tax_margin',
    'pre_tax_margin_ttm', 'beta_5_year', 'beta_1_year', 'fiscal_period_end_fq', 'total_revenue_fy_h',
];

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const firstNumber = (...values) => values.find(isNumber) ?? null;
const isoDate = (seconds) => (isNumber(seconds) ? new Date(seconds * 1000).toISOString().slice(0, 10) : null);

/**
 * Convert one screener row into the app's company shape. Money stays in the reporting currency's base unit.
 * @param {{s: string, d: Array}} row
 * @param {string[]} columns column names in the order they were requested
 */
export function normalizeRow(row, columns = COLUMNS) {
    const field = Object.fromEntries(columns.map((name, index) => [name, row.d[index]]));
    const debt = firstNumber(field.total_debt_fq);
    const ebit = firstNumber(field.ebit_ttm, field.oper_income_ttm);
    const interestRate = firstNumber(field.effective_interest_rate_on_debt_ttm);
    const taxRate = isNumber(field.after_tax_margin) && isNumber(field.pre_tax_margin_ttm) && field.pre_tax_margin_ttm > 0
        ? 1 - field.after_tax_margin / field.pre_tax_margin_ttm
        : null;
    const periodEnd = isoDate(field.fiscal_period_end_fq);
    const yearly = Array.isArray(field.total_revenue_fy_h) ? field.total_revenue_fy_h.filter(isNumber).slice(0, HISTORY_YEARS).reverse() : [];
    const minority = isNumber(field.total_equity_fq) && isNumber(field.shrhldrs_equity_fq) ? Math.max(field.total_equity_fq - field.shrhldrs_equity_fq, 0) : 0;
    const notes = [];
    if (minority > 0) {
        notes.push('ส่วนของผู้ถือหุ้นส่วนน้อยใช้มูลค่าตามบัญชี (ส่วนของผู้ถือหุ้นรวม ลบ ส่วนของบริษัทใหญ่) ซึ่งอาจต่ำกว่ามูลค่าจริง');
    }
    if (field.sector === 'Finance' || field.ebit_ttm === null) {
        notes.push('บริษัทนี้อยู่ในกลุ่มการเงินหรือไม่มีตัวเลข EBIT โมเดล FCFF ไม่เหมาะกับธนาคาร ประกัน และกองทุน ผลลัพธ์อาจใช้ไม่ได้');
    }
    if (field.currency && field.fundamental_currency_code && field.currency !== field.fundamental_currency_code) {
        notes.push(`ราคาเป็น ${field.currency} แต่งบเป็น ${field.fundamental_currency_code} ต้องแปลงสกุลเงินให้ตรงกันก่อนใช้ผลลัพธ์`);
    }

    return {
        symbol: field.name,
        fullSymbol: row.s,
        name: field.description,
        exchange: field.exchange,
        sector: field.sector ?? null,
        currency: field.fundamental_currency_code || field.currency,
        price: firstNumber(field.close),
        priceTime: `${new Date().toISOString().slice(0, 10)} (TradingView อาจล่าช้า)`,
        period: periodEnd ? `งบ 12 เดือนล่าสุด ถึง ${periodEnd}` : 'งบ 12 เดือนล่าสุด',
        shares: firstNumber(field.total_shares_outstanding),
        revenue: firstNumber(field.total_revenue_ttm),
        ebit,
        interestExpense: isNumber(interestRate) && isNumber(debt) ? (interestRate / 100) * debt : 0,
        taxRate,
        debt: debt ?? 0,
        cash: firstNumber(field.cash_n_short_term_invest_fq) ?? 0,
        minority,
        equity: firstNumber(field.total_equity_fq),
        beta: firstNumber(field.beta_5_year, field.beta_1_year),
        history: yearly.map((revenue) => ({ revenue })),
        notes,
    };
}

export function createTradingViewProvider({ fetch: fetchImpl = globalThis.fetch } = {}) {
    async function scan(market, body) {
        const response = await fetchImpl(`${ENDPOINT}/${SCREENS[market]}/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
            throw new Error(`TradingView responded ${response.status}`);
        }
        const payload = await response.json();

        return Array.isArray(payload.data) ? payload.data : [];
    }

    return {
        name: 'tradingview',

        /** @returns {Promise<object|null>} null when the ticker is not listed in that market */
        async company(symbol, market) {
            const rows = await scan(market, {
                filter: [
                    { left: 'name', operation: 'equal', right: symbol },
                    { left: 'type', operation: 'in_range', right: EQUITY_TYPES },
                    { left: 'is_primary', operation: 'equal', right: true },
                ],
                columns: COLUMNS,
                range: [0, 5],
            });
            const typeIndex = COLUMNS.indexOf('type');
            const row = rows.find((candidate) => candidate.d[typeIndex] === 'stock') || rows[0];

            return row ? normalizeRow(row) : null;
        },

        async search(query, market) {
            const rows = await scan(market, {
                filter: [
                    { left: 'name,description', operation: 'match', right: query },
                    { left: 'type', operation: 'in_range', right: EQUITY_TYPES },
                    { left: 'is_primary', operation: 'equal', right: true },
                ],
                columns: ['name', 'description', 'exchange'],
                sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
                range: [0, 8],
            });

            return rows.map((row) => ({ symbol: row.d[0], name: row.d[1], exchange: row.d[2] }));
        },
    };
}
