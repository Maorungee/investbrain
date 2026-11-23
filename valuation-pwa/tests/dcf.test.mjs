import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buyPrice, calcWacc, forecast, reverse, sensitivity, spreadFromCoverage, suggestAssumptions, validate } from '../public/dcf.js';

const base = {
    revenue: 1000, ebit: 200, shares: 100, cash: 50, debt: 150, minority: 0,
    taxRate: 0.2, marginalTax: 0.2, growth1: 0.1, growth2to5: 0.08, terminalGrowth: 0.02,
    targetMargin: 0.2, convergenceYear: 5, salesToCapital: 2, wacc: 0.09, terminalWacc: 0.08, terminalRoic: 0.1,
};
const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}`);

test('forecast follows the growth, margin and reinvestment rules', () => {
    const result = forecast(base);
    assert.equal(result.ok, true);
    assert.equal(result.years.length, 10);
    near(result.years[0].revenue, 1100);
    near(result.years[0].fcff, 1100 * 0.2 * 0.8 - 100 / 2);
    near(result.years[4].growth, 0.08);
    near(result.years[9].growth, 0.02);
    near(result.years[9].wacc, 0.08);
    near(result.years[7].growth, 0.08 + (0.02 - 0.08) * 0.6);
});

test('a no-growth firm is worth its perpetuity', () => {
    const flat = { ...base, growth1: 0, growth2to5: 0, terminalGrowth: 0, wacc: 0.1, terminalWacc: 0.1, cash: 0, debt: 0 };
    const result = forecast(flat);
    near(result.enterpriseValue, (200 * 0.8) / 0.1, 1e-6);
    near(result.valuePerShare, 16, 1e-8);
});

test('the equity bridge adds cash and subtracts debt and minority interests', () => {
    const result = forecast({ ...base, minority: 20 });
    near(result.equityValue, result.enterpriseValue + 50 - 150 - 20);
    near(result.valuePerShare, result.equityValue / 100);
});

test('terminal value reinvests growth divided by return on capital', () => {
    const result = forecast(base);
    const terminalNopat = result.years[9].revenue * 1.02 * 0.2 * 0.8;
    near(result.terminalValue, (terminalNopat * (1 - 0.02 / 0.1)) / (0.08 - 0.02), 1e-6);
});

test('losses are not taxed and margins converge to the target', () => {
    const result = forecast({ ...base, ebit: -100, targetMargin: 0.1, convergenceYear: 4 });
    assert.ok(result.years[0].ebit < 0);
    near(result.years[0].nopat, result.years[0].ebit);
    near(result.years[3].margin, 0.1);
    near(result.years[9].margin, 0.1);
});

test('invalid inputs are reported instead of producing a number', () => {
    assert.deepEqual(validate({ ...base, revenue: 0 }), ['revenue']);
    assert.deepEqual(validate({ ...base, terminalWacc: 0.02 }), ['terminalWacc']);
    assert.deepEqual(validate({ ...base, shares: undefined }), ['shares']);
    assert.equal(forecast({ ...base, salesToCapital: 0 }).ok, false);
});

test('reverse finds the growth the price implies', () => {
    const target = forecast({ ...base, growth2to5: 0.15 }).valuePerShare;
    near(reverse(base, target), 0.15, 1e-6);
    assert.equal(reverse(base, 1e9), null);
    assert.equal(reverse(base, 0), null);
});

test('reverse can solve for the target margin', () => {
    const target = forecast({ ...base, targetMargin: 0.3 }).valuePerShare;
    near(reverse(base, target, 'targetMargin', 0, 0.9), 0.3, 1e-6);
});

test('sensitivity is centred on the base case and falls as the discount rate rises', () => {
    const grid = sensitivity(base);
    near(grid[2].cells[2].value, forecast(base).valuePerShare);
    assert.ok(grid[0].cells[2].value > grid[4].cells[2].value);
    assert.ok(grid[2].cells[4].value > grid[2].cells[0].value);
});

test('wacc weights equity and after-tax debt by market value', () => {
    const result = calcWacc({ riskFree: 0.04, erp: 0.05, beta: 1.2, marketCap: 800, debt: 200, spread: 0.01, taxRate: 0.2 });
    near(result.costOfEquity, 0.1);
    near(result.wacc, 0.8 * 0.1 + 0.2 * 0.05 * 0.8);
    assert.equal(calcWacc({ riskFree: 0.04, erp: 0.05, beta: 1, marketCap: 0, debt: 0, spread: 0.01, taxRate: 0.2 }).ok, false);
});

test('credit spread widens as interest coverage falls', () => {
    assert.equal(spreadFromCoverage(100, 0), 0.006);
    assert.ok(spreadFromCoverage(100, 10) < spreadFromCoverage(100, 60));
    assert.equal(spreadFromCoverage(-5, 10), 0.15);
});

test('buy price applies the margin of safety and never goes negative', () => {
    near(buyPrice(100, 0.25), 75);
    assert.equal(buyPrice(-10, 0.25), 0);
});

test('suggested assumptions come from reported history and market defaults', () => {
    const company = {
        revenue: 1210, ebit: 242, equity: 500, debt: 200, cash: 100, taxRate: 0.18, beta: 1.1, interestExpense: 10,
        history: [{ revenue: 1000, ebit: 150 }, { revenue: 1100, ebit: 200 }, { revenue: 1210, ebit: 242 }],
    };
    const thai = suggestAssumptions(company, 'TH');
    near(thai.growth1, 0.1, 1e-9);
    near(thai.growth2to5, 0.075, 1e-9);
    near(thai.salesToCapital, 1210 / 600);
    assert.equal(thai.marginalTax, 0.2);
    assert.equal(thai.riskFree, 0.026);
    near(thai.beta, 0.67 * 1.1 + 0.33);
    const result = forecast({ ...company, shares: 10, ...thai, wacc: 0.09 });
    assert.equal(result.ok, true);
    const fallback = suggestAssumptions({ revenue: 100, history: [] }, 'US');
    assert.equal(fallback.growth1, 0.05);
    assert.equal(fallback.beta, 1);
});
