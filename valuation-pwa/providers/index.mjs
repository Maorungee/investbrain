import { createTradingViewProvider } from './tradingview.mjs';

/**
 * Pick the data provider from the environment. Set DATA_PROVIDER=none to run with manual entry only.
 * @param {Record<string, string|undefined>} env
 */
export function createProvider(env = {}) {
    const name = (env.DATA_PROVIDER || 'tradingview').toLowerCase();

    return name === 'tradingview' ? createTradingViewProvider() : null;
}
