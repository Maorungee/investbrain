/**
 * FCFF discounted-cash-flow engine. Pure functions, no DOM, shared by the app and its tests.
 * Money amounts share one unit (the caller's choice); rates are decimals; years run 1..10.
 */

export const HORIZON = 10;

const lerp = (from, to, share) => from + (to - from) * share;
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** Default spread over the risk-free rate by interest coverage (EBIT / interest expense). */
const SPREAD_BY_COVERAGE = [
    [8.5, 0.006], [6.5, 0.008], [5.5, 0.01], [4.25, 0.012], [3, 0.015], [2.5, 0.02],
    [2, 0.026], [1.5, 0.04], [1.25, 0.055], [0.8, 0.08], [0.5, 0.11],
];

export function spreadFromCoverage(ebit, interestExpense) {
    if (!isNumber(interestExpense) || interestExpense <= 0) {
        return SPREAD_BY_COVERAGE[0][1];
    }
    const coverage = ebit / interestExpense;
    const row = SPREAD_BY_COVERAGE.find(([floor]) => coverage >= floor);

    return row ? row[1] : 0.15;
}

/**
 * Cost of capital from CAPM and market-value weights.
 * @param {{riskFree:number, erp:number, beta:number, marketCap:number, debt:number, spread:number, taxRate:number}} input
 */
export function calcWacc(input) {
    const { riskFree, erp, beta, marketCap, debt, spread, taxRate } = input;
    const missing = ['riskFree', 'erp', 'beta', 'marketCap', 'spread', 'taxRate'].filter((key) => !isNumber(input[key]));
    if (missing.length || marketCap <= 0) {
        return { ok: false, errors: missing.length ? missing : ['marketCap'] };
    }
    const debtValue = isNumber(debt) && debt > 0 ? debt : 0;
    const costOfEquity = riskFree + beta * erp;
    const costOfDebt = riskFree + spread;
    const equityWeight = marketCap / (marketCap + debtValue);
    const wacc = equityWeight * costOfEquity + (1 - equityWeight) * costOfDebt * (1 - taxRate);

    return { ok: true, wacc, costOfEquity, costOfDebt, equityWeight, debtWeight: 1 - equityWeight };
}

const REQUIRED = [
    'revenue', 'ebit', 'shares', 'taxRate', 'marginalTax', 'growth1', 'growth2to5', 'terminalGrowth',
    'targetMargin', 'convergenceYear', 'salesToCapital', 'wacc', 'terminalWacc', 'terminalRoic',
];

export function validate(input) {
    const errors = REQUIRED.filter((key) => !isNumber(input[key]));
    if (errors.length) {
        return errors;
    }
    if (input.revenue <= 0) { errors.push('revenue'); }
    if (input.shares <= 0) { errors.push('shares'); }
    if (input.salesToCapital <= 0) { errors.push('salesToCapital'); }
    if (input.convergenceYear < 1) { errors.push('convergenceYear'); }
    if (input.terminalWacc <= input.terminalGrowth) { errors.push('terminalWacc'); }
    if (input.wacc <= -1) { errors.push('wacc'); }
    if (input.terminalRoic <= 0) { errors.push('terminalRoic'); }

    return errors;
}

/**
 * Ten-year FCFF forecast plus terminal value and the bridge to value per share.
 * Growth: year 1, then years 2-5, then a straight fade to terminal growth by year 10.
 * Margin: straight line from today's EBIT margin to the target by `convergenceYear`.
 * Reinvestment: revenue change divided by sales-to-capital. Losses are not taxed.
 */
export function forecast(input) {
    const errors = validate(input);
    if (errors.length) {
        return { ok: false, errors };
    }
    const cash = isNumber(input.cash) ? input.cash : 0;
    const debt = isNumber(input.debt) ? input.debt : 0;
    const minority = isNumber(input.minority) ? input.minority : 0;
    const baseMargin = input.ebit / input.revenue;
    const years = [];
    let revenue = input.revenue;
    let discount = 1;
    let pvForecast = 0;

    for (let year = 1; year <= HORIZON; year++) {
        const fade = Math.max(0, year - 5) / 5;
        const growth = year === 1 ? input.growth1 : lerp(input.growth2to5, input.terminalGrowth, fade);
        const margin = lerp(baseMargin, input.targetMargin, Math.min(year / input.convergenceYear, 1));
        const tax = lerp(input.taxRate, input.marginalTax, fade);
        const wacc = lerp(input.wacc, input.terminalWacc, fade);
        const previous = revenue;
        revenue = previous * (1 + growth);
        const ebit = revenue * margin;
        const nopat = ebit > 0 ? ebit * (1 - tax) : ebit;
        const reinvestment = (revenue - previous) / input.salesToCapital;
        const fcff = nopat - reinvestment;
        discount /= 1 + wacc;
        pvForecast += fcff * discount;
        years.push({ year, growth, margin, tax, wacc, revenue, ebit, nopat, reinvestment, fcff, pv: fcff * discount });
    }

    const terminalRevenue = revenue * (1 + input.terminalGrowth);
    const terminalNopat = terminalRevenue * input.targetMargin * (1 - input.marginalTax);
    const reinvestmentRate = input.terminalGrowth > 0 ? input.terminalGrowth / input.terminalRoic : 0;
    const terminalFcff = terminalNopat * (1 - reinvestmentRate);
    const terminalValue = terminalFcff / (input.terminalWacc - input.terminalGrowth);
    const pvTerminal = terminalValue * discount;
    const enterpriseValue = pvForecast + pvTerminal;
    const equityValue = enterpriseValue + cash - debt - minority;

    return {
        ok: true,
        errors: [],
        years,
        baseMargin,
        pvForecast,
        pvTerminal,
        terminalValue,
        terminalShare: enterpriseValue !== 0 ? pvTerminal / enterpriseValue : 0,
        enterpriseValue,
        equityValue,
        valuePerShare: equityValue / input.shares,
        bridge: { cash, debt, minority },
    };
}

/**
 * Solve for the value of one assumption that makes value per share equal the price.
 * Uses bisection; returns null when the price is unreachable inside [min, max].
 */
export function reverse(input, price, key = 'growth2to5', min = -0.3, max = 1) {
    if (!isNumber(price) || price <= 0) {
        return null;
    }
    const gap = (value) => {
        const result = forecast({ ...input, [key]: value });

        return result.ok ? result.valuePerShare - price : NaN;
    };
    let low = min;
    let high = max;
    let gapLow = gap(low);
    const gapHigh = gap(high);
    if (!isNumber(gapLow) || !isNumber(gapHigh) || gapLow * gapHigh > 0) {
        return null;
    }
    for (let step = 0; step < 60; step++) {
        const middle = (low + high) / 2;
        const gapMiddle = gap(middle);
        if (gapLow * gapMiddle <= 0) {
            high = middle;
        } else {
            low = middle;
            gapLow = gapMiddle;
        }
    }

    return (low + high) / 2;
}

/** Value per share across a grid of discount-rate and growth shifts (both shift start and terminal WACC). */
export function sensitivity(input, waccShifts = [-0.02, -0.01, 0, 0.01, 0.02], growthShifts = [-0.04, -0.02, 0, 0.02, 0.04]) {
    return waccShifts.map((waccShift) => ({
        waccShift,
        wacc: input.wacc + waccShift,
        cells: growthShifts.map((growthShift) => {
            const result = forecast({
                ...input,
                wacc: input.wacc + waccShift,
                terminalWacc: input.terminalWacc + waccShift,
                growth1: input.growth1 + growthShift,
                growth2to5: input.growth2to5 + growthShift,
            });

            return { growthShift, value: result.ok ? result.valuePerShare : null };
        }),
    }));
}

/** Price at which the buyer keeps the requested margin of safety against the estimated value. */
export function buyPrice(valuePerShare, marginOfSafety) {
    return valuePerShare > 0 ? valuePerShare * (1 - marginOfSafety) : 0;
}

/** Country-level starting points. All are editable in the app and should be checked against current data. */
export const MARKET_DEFAULTS = {
    US: { currency: 'USD', riskFree: 0.045, erp: 0.045, marginalTax: 0.21, terminalGrowth: 0.03 },
    TH: { currency: 'THB', riskFree: 0.026, erp: 0.063, marginalTax: 0.2, terminalGrowth: 0.02 },
};

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * Starting assumptions derived from reported figures, so the first screen shows a working model.
 * The measured beta is pulled one third of the way toward 1, since extreme betas tend to revert.
 * @param {object} company normalised company payload (see providers)
 */
export function suggestAssumptions(company, market = 'US') {
    const defaults = MARKET_DEFAULTS[market] || MARKET_DEFAULTS.US;
    const history = (company.history || []).filter((row) => isNumber(row.revenue) && row.revenue > 0);
    let pastGrowth = 0.05;
    if (history.length >= 2) {
        const first = history[0];
        const last = history[history.length - 1];
        pastGrowth = Math.pow(last.revenue / first.revenue, 1 / (history.length - 1)) - 1;
    }
    const growth1 = clamp(pastGrowth, -0.05, 0.25);
    const margins = history.filter((row) => isNumber(row.ebit)).map((row) => row.ebit / row.revenue);
    const currentMargin = company.revenue > 0 && isNumber(company.ebit) ? company.ebit / company.revenue : 0.1;
    const averageMargin = margins.length ? margins.reduce((sum, value) => sum + value, 0) / margins.length : currentMargin;
    const investedCapital = (company.equity || 0) + (company.debt || 0) - (company.cash || 0);
    const salesToCapital = investedCapital > 0 ? clamp(company.revenue / investedCapital, 0.5, 4) : 1.5;
    const taxRate = isNumber(company.taxRate) ? clamp(company.taxRate, 0, 0.35) : defaults.marginalTax;
    const beta = isNumber(company.beta) ? clamp(0.67 * company.beta + 0.33, 0.5, 2.5) : 1;
    const spread = spreadFromCoverage(company.ebit, company.interestExpense);
    const terminalWacc = defaults.riskFree + defaults.erp;

    return {
        growth1,
        growth2to5: growth1 > 0 ? growth1 * 0.75 : growth1 / 2,
        terminalGrowth: Math.min(defaults.terminalGrowth, defaults.riskFree),
        targetMargin: (currentMargin + averageMargin) / 2,
        convergenceYear: 5,
        salesToCapital,
        taxRate,
        marginalTax: defaults.marginalTax,
        riskFree: defaults.riskFree,
        erp: defaults.erp,
        beta,
        spread,
        terminalWacc,
        terminalRoic: terminalWacc + 0.03,
        marginOfSafety: 0.25,
    };
}
