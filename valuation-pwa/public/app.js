import { MARKET_DEFAULTS, buyPrice, calcWacc, forecast, reverse, sensitivity, suggestAssumptions } from './dcf.js';

const MILLION = 1e6;
const DRAFT_KEY = 'valuation.draft';
const SAVED_KEY = 'valuation.saved';
const $ = (selector) => document.querySelector(selector);

const state = { market: 'US', company: null, fin: {}, a: {}, price: null };

const FIN_FIELDS = [
    ['revenue', 'รายได้ 12 เดือนล่าสุด', 'ล้าน'],
    ['ebit', 'กำไรจากการดำเนินงาน (EBIT)', 'ล้าน'],
    ['interestExpense', 'ดอกเบี้ยจ่าย', 'ล้าน'],
    ['debt', 'หนี้ที่มีดอกเบี้ย', 'ล้าน'],
    ['cash', 'เงินสดและเงินลงทุนระยะสั้น', 'ล้าน'],
    ['minority', 'ส่วนของผู้ถือหุ้นส่วนน้อย', 'ล้าน'],
    ['shares', 'จำนวนหุ้น', 'ล้านหุ้น'],
];
const ASSUMPTION_GROUPS = [
    ['การเติบโตของรายได้', [
        ['growth1', 'ปีที่ 1', '%'],
        ['growth2to5', 'ปีที่ 2–5 ต่อปี', '%'],
        ['terminalGrowth', 'ระยะยาวหลังปีที่ 10', '%', 'ไม่ควรสูงกว่าอัตราดอกเบี้ยพันธบัตร'],
    ]],
    ['กำไรและการลงทุน', [
        ['targetMargin', 'EBIT margin เป้าหมาย', '%'],
        ['convergenceYear', 'ถึงเป้าหมายในปีที่', 'ปี'],
        ['salesToCapital', 'รายได้ที่เพิ่มต่อเงินลงทุน 1 หน่วย', 'เท่า', 'ยิ่งต่ำ ยิ่งต้องลงทุนมากเพื่อโต'],
        ['taxRate', 'อัตราภาษีปัจจุบัน', '%'],
        ['marginalTax', 'อัตราภาษีระยะยาว', '%'],
    ]],
    ['ต้นทุนเงินทุน', [
        ['riskFree', 'ผลตอบแทนพันธบัตรรัฐบาล 10 ปี', '%'],
        ['erp', 'ส่วนชดเชยความเสี่ยงตลาดหุ้น', '%'],
        ['beta', 'Beta', 'เท่า', 'ค่าเริ่มต้นปรับเข้าหา 1 แล้ว'],
        ['spread', 'ส่วนต่างดอกเบี้ยเงินกู้', '%'],
        ['terminalWacc', 'ต้นทุนเงินทุนระยะยาว', '%'],
        ['terminalRoic', 'ผลตอบแทนต่อเงินลงทุนระยะยาว', '%'],
    ]],
];
const PERCENT_KEYS = new Set(ASSUMPTION_GROUPS.flatMap(([, fields]) => fields.filter((field) => field[2] === '%').map((field) => field[0])).concat(['marginOfSafety', 'manualWacc']));
const ERROR_LABELS = {
    revenue: 'รายได้ต้องมากกว่าศูนย์', shares: 'จำนวนหุ้นต้องมากกว่าศูนย์', ebit: 'กรอกกำไรจากการดำเนินงาน',
    salesToCapital: 'รายได้ต่อเงินลงทุนต้องมากกว่าศูนย์', convergenceYear: 'ปีที่ถึงเป้าหมายต้องเป็น 1 ขึ้นไป',
    terminalWacc: 'ต้นทุนเงินทุนระยะยาวต้องสูงกว่าการเติบโตระยะยาว', terminalRoic: 'ผลตอบแทนต่อเงินลงทุนระยะยาวต้องมากกว่าศูนย์',
    wacc: 'คำนวณต้นทุนเงินทุนไม่ได้ ตรวจราคา จำนวนหุ้น และ beta',
};

const EXAMPLE = {
    company: { symbol: 'ตัวอย่าง', name: 'บริษัทตัวอย่าง จำกัด (มหาชน)', currency: 'THB', period: 'ตัวเลขสมมติ', example: true },
    market: 'TH',
    price: 58.5,
    fin: { revenue: 52000, ebit: 6240, interestExpense: 420, debt: 9800, cash: 4100, minority: 300, shares: 1200 },
    raw: { revenue: 52000, ebit: 6240, interestExpense: 420, debt: 9800, cash: 4100, equity: 31000, taxRate: 0.19, beta: 0.9, history: [{ revenue: 44000, ebit: 4800 }, { revenue: 47500, ebit: 5500 }, { revenue: 52000, ebit: 6240 }] },
};

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const number = (value, digits = 0) => (Number.isFinite(value) ? value.toLocaleString('th-TH', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '–');
const percent = (value, digits = 1) => (Number.isFinite(value) ? `${number(value * 100, digits)}%` : '–');
const signed = (value) => (Number.isFinite(value) ? `${value > 0 ? '+' : ''}${number(value * 100, 0)}%` : '–');
const currency = () => state.company?.currency || MARKET_DEFAULTS[state.market].currency;
const perShare = (value) => (Number.isFinite(value) ? `${number(value, 2)} ${currency()}` : '–');

function readStore(key, fallback) {
    try {
        return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
        return fallback;
    }
}

function writeStore(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        /* storage may be unavailable; the app still works for this visit */
    }
}

function modelInput() {
    const marketCap = state.price * state.fin.shares;
    const capm = calcWacc({ riskFree: state.a.riskFree, erp: state.a.erp, beta: state.a.beta, marketCap, debt: state.fin.debt, spread: state.a.spread, taxRate: state.a.marginalTax });
    const wacc = state.a.waccMode === 'manual' ? state.a.manualWacc : (capm.ok ? capm.wacc : NaN);

    return { input: { ...state.fin, ...state.a, wacc }, capm };
}

function setCompany({ company, market, price, fin, assumptions }) {
    state.company = company;
    state.market = market;
    state.price = price;
    state.fin = fin;
    state.a = { waccMode: 'capm', manualWacc: 0.09, ...assumptions };
    document.querySelector(`input[name=market][value=${market}]`).checked = true;
    renderWorkspace();
    writeStore(DRAFT_KEY, { company, market, price, fin, assumptions: state.a });
}

function loadExample() {
    setCompany({ company: EXAMPLE.company, market: EXAMPLE.market, price: EXAMPLE.price, fin: { ...EXAMPLE.fin }, assumptions: suggestAssumptions(EXAMPLE.raw, EXAMPLE.market) });
}

function loadFromPayload(payload, market) {
    const toMillions = (value) => (Number.isFinite(value) ? value / MILLION : null);
    const fin = {};
    for (const [key] of FIN_FIELDS) {
        fin[key] = toMillions(payload[key]);
    }
    fin.minority ??= 0;
    fin.interestExpense ??= 0;
    setCompany({
        company: { symbol: payload.symbol, name: payload.name, currency: payload.currency, period: payload.period, priceTime: payload.priceTime, notes: payload.notes || [] },
        market,
        price: payload.price,
        fin,
        assumptions: suggestAssumptions(payload, market),
    });
}

function field(scope, key, label, unit, help, value) {
    const shown = Number.isFinite(value) ? +(PERCENT_KEYS.has(key) ? value * 100 : value).toFixed(2) : '';

    return `<div class="field" data-field="${key}"><label for="${scope}-${key}">${label}</label>
        <div class="input"><input id="${scope}-${key}" type="number" step="any" inputmode="decimal" data-scope="${scope}" data-key="${key}" value="${shown}"><span>${unit}</span></div>
        ${help ? `<small>${help}</small>` : ''}</div>`;
}

function renderWorkspace() {
    const company = state.company;
    const unit = `ล้าน ${currency()}`;
    $('#workspace').innerHTML = `
    <div class="column">
        <section class="card" aria-live="polite">
            <div class="company">
                <div><h2>${escapeHtml(company.name || 'หุ้นของคุณ')}</h2>
                    <div class="ticker">${escapeHtml(company.symbol || '')} · ${escapeHtml(company.period || 'กรอกเอง')}</div></div>
                <div class="row">${company.example ? '<span class="pill warn">ตัวอย่าง ไม่ใช่ข้อมูลจริง</span>' : ''}<button id="saveButton" class="button small" type="button">บันทึก</button></div>
            </div>
            ${(company.notes || []).map((note) => `<p class="note alert">${escapeHtml(note)}</p>`).join('')}
            <div id="results"></div>
        </section>
        <section class="card"><h2>กระแสเงินสดที่คาดการณ์</h2><div id="chart"></div></section>
        <section class="card"><h2>ถ้าสมมติฐานเปลี่ยน มูลค่าต่อหุ้นเป็นเท่าไร</h2><div id="grid"></div></section>
        <section class="card"><h2>ที่มาของมูลค่า</h2><div id="bridge"></div></section>
    </div>
    <div class="column">
        <section class="card">
            <h2>ราคาและส่วนเผื่อ</h2>
            <div class="fields">
                ${field('price', 'price', 'ราคาหุ้นปัจจุบัน', currency(), company.priceTime ? `ณ ${escapeHtml(company.priceTime)}` : '', state.price)}
                ${field('a', 'marginOfSafety', 'ส่วนเผื่อความปลอดภัยที่ต้องการ', '%', 'ราคาซื้อ = มูลค่า × (1 − ส่วนเผื่อ)', state.a.marginOfSafety)}
            </div>
        </section>
        <section class="card">
            <h2>สมมติฐาน</h2>
            ${ASSUMPTION_GROUPS.map(([title, fields]) => `<div class="group"><h3>${title}</h3><div class="fields">${fields.map(([key, label, fieldUnit, help]) => field('a', key, label, fieldUnit, help, state.a[key])).join('')}</div></div>`).join('')}
            <div class="group"><h3>ต้นทุนเงินทุนปีที่ 1–5</h3>
                <div class="segmented" role="radiogroup" aria-label="วิธีกำหนดต้นทุนเงินทุน">
                    <label><input type="radio" name="waccMode" value="capm" ${state.a.waccMode === 'capm' ? 'checked' : ''}><span>คำนวณให้</span></label>
                    <label><input type="radio" name="waccMode" value="manual" ${state.a.waccMode === 'manual' ? 'checked' : ''}><span>กำหนดเอง</span></label>
                </div>
                <div id="waccBox"></div>
            </div>
            <p class="note">ค่าเริ่มต้นคำนวณจากงบย้อนหลังและค่ากลางของตลาด${state.market === 'TH' ? 'ไทย' : 'อเมริกา'} ควรปรับให้ตรงกับมุมมองของคุณ</p>
        </section>
        <section class="card">
            <h2>ตัวเลขจากงบการเงิน</h2>
            <div class="fields">${FIN_FIELDS.map(([key, label, fieldUnit]) => field('fin', key, label, fieldUnit === 'ล้าน' ? unit : fieldUnit, '', state.fin[key])).join('')}</div>
        </section>
    </div>`;
    renderResults();
}

function statusOf(value, price, safety) {
    if (!(value > 0) || !(price > 0)) {
        return ['bad', 'มูลค่าตามสมมติฐานนี้ไม่เป็นบวก'];
    }
    if (price <= buyPrice(value, safety)) {
        return ['good', 'ราคาต่ำกว่าราคาซื้อที่ตั้งไว้'];
    }

    return price <= value ? ['warn', 'ต่ำกว่ามูลค่า แต่ส่วนเผื่อยังไม่พอ'] : ['bad', 'ราคาสูงกว่ามูลค่า'];
}

function renderChart(years) {
    const width = 640;
    const height = 220;
    const left = 8;
    const bottom = 24;
    const top = 10;
    const values = years.flatMap((row) => [row.revenue, row.fcff]);
    const max = Math.max(...values, 0);
    const min = Math.min(...values, 0);
    const y = (value) => top + ((max - value) / (max - min || 1)) * (height - top - bottom);
    const slot = (width - left * 2) / years.length;
    const bar = (index, offset, value, className, label) => {
        const yTop = y(Math.max(value, 0));
        const barHeight = Math.max(Math.abs(y(value) - y(0)), 1);

        return `<rect class="${className}" x="${(left + index * slot + offset).toFixed(1)}" y="${yTop.toFixed(1)}" width="${(slot * 0.36).toFixed(1)}" height="${barHeight.toFixed(1)}" rx="2"><title>ปีที่ ${index + 1} ${label} ${number(value)} ล้าน</title></rect>`;
    };
    const bars = years.map((row, index) => bar(index, slot * 0.1, row.revenue, 'revenue', 'รายได้') + bar(index, slot * 0.52, row.fcff, row.fcff < 0 ? 'fcff negative' : 'fcff', 'กระแสเงินสดอิสระ')
        + `<text x="${(left + index * slot + slot / 2).toFixed(1)}" y="${height - 6}" text-anchor="middle">ปี ${index + 1}</text>`).join('');

    return `<div class="legend"><span><i class="revenue"></i>รายได้</span><span><i class="fcff"></i>กระแสเงินสดอิสระ (FCFF)</span><span>หน่วย: ล้าน ${currency()}</span></div>
        <div class="scroll"><svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="รายได้และกระแสเงินสดอิสระ 10 ปี">${bars}<line class="axis" x1="${left}" x2="${width - left}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/></svg></div>
        <details><summary>ดูตัวเลขรายปี</summary><div class="scroll"><table><thead><tr><th>ปี</th><th>โต</th><th>รายได้</th><th>Margin</th><th>EBIT</th><th>ลงทุนเพิ่ม</th><th>FCFF</th><th>WACC</th><th>มูลค่าปัจจุบัน</th></tr></thead>
        <tbody>${years.map((row) => `<tr><td>${row.year}</td><td>${percent(row.growth)}</td><td>${number(row.revenue)}</td><td>${percent(row.margin)}</td><td>${number(row.ebit)}</td><td>${number(row.reinvestment)}</td><td>${number(row.fcff)}</td><td>${percent(row.wacc)}</td><td>${number(row.pv)}</td></tr>`).join('')}</tbody></table></div></details>`;
}

function renderResults() {
    const { input, capm } = modelInput();
    const result = forecast(input);
    document.querySelectorAll('.field.invalid').forEach((element) => element.classList.remove('invalid'));
    $('#waccBox').innerHTML = state.a.waccMode === 'manual'
        ? `<div class="fields">${field('a', 'manualWacc', 'ต้นทุนเงินทุน (WACC)', '%', '', state.a.manualWacc)}</div>`
        : `<p class="note">${capm.ok ? `WACC ${percent(capm.wacc, 2)} = ทุน ${percent(capm.equityWeight, 0)} × ${percent(capm.costOfEquity, 2)} + หนี้ ${percent(capm.debtWeight, 0)} × ${percent(capm.costOfDebt, 2)} หลังภาษี` : 'กรอกราคา จำนวนหุ้น และ beta เพื่อคำนวณ'}</p>`;

    if (!result.ok) {
        result.errors.forEach((key) => document.querySelector(`[data-field="${key}"]`)?.classList.add('invalid'));
        $('#results').innerHTML = `<p class="note alert">ยังคำนวณไม่ได้: ${result.errors.map((key) => ERROR_LABELS[key] || `กรอก ${key}`).join(' · ')}</p>`;
        ['#chart', '#grid', '#bridge'].forEach((selector) => { $(selector).innerHTML = '<p class="note">รอตัวเลขครบก่อน</p>'; });

        return;
    }

    const value = result.valuePerShare;
    const price = state.price;
    const safety = state.a.marginOfSafety ?? 0;
    const [tone, label] = statusOf(value, price, safety);
    const impliedGrowth = reverse(input, price, 'growth2to5');
    const impliedMargin = reverse(input, price, 'targetMargin', 0, 0.9);
    $('#results').innerHTML = `
        <dl class="hero">
            <div class="stat lead"><dt>มูลค่าที่เหมาะสมต่อหุ้น</dt><dd>${perShare(Math.max(value, 0))}</dd><small><span class="pill ${tone} ${tone}">${label}</span></small></div>
            <div class="stat"><dt>ราคาปัจจุบัน</dt><dd>${perShare(price)}</dd><small class="${tone}">มูลค่า${value >= price ? 'สูง' : 'ต่ำ'}กว่าราคา ${signed(value / price - 1).replace(/[+-]/, '')}</small></div>
            <div class="stat"><dt>ราคาซื้อที่ส่วนเผื่อ ${percent(safety, 0)}</dt><dd>${perShare(buyPrice(value, safety))}</dd><small>ส่วนเผื่อที่ราคานี้ ${value > 0 ? signed(1 - price / value) : '–'}</small></div>
        </dl>
        <div class="group" style="margin-top:14px"><h3>ราคาปัจจุบันคาดหวังอะไร</h3>
            <ul class="implied">
                <li>รายได้ปีที่ 2–5 ต้องโต ${impliedGrowth === null ? '<b>เกินช่วงที่คำนวณได้</b>' : `<b>${percent(impliedGrowth)}</b> ต่อปี`} (คุณตั้งไว้ ${percent(state.a.growth2to5)})</li>
                <li>หรือ EBIT margin ระยะยาวต้องเป็น ${impliedMargin === null ? '<b>ไม่มีค่าที่ทำให้ถึงราคา</b>' : `<b>${percent(impliedMargin)}</b>`} (คุณตั้งไว้ ${percent(state.a.targetMargin)}, ปัจจุบัน ${percent(result.baseMargin)})</li>
            </ul>
        </div>
        ${result.terminalShare > 0.75 ? `<p class="note alert">มูลค่า ${percent(result.terminalShare, 0)} มาจากช่วงหลังปีที่ 10 ผลลัพธ์จึงไวต่อสมมติฐานระยะยาวมาก</p>` : ''}`;

    $('#chart').innerHTML = renderChart(result.years);

    const grid = sensitivity(input);
    $('#grid').innerHTML = `<div class="scroll"><table class="grid"><thead><tr><th>WACC \\ การเติบโต</th>${grid[0].cells.map((cell) => `<th>${cell.growthShift > 0 ? '+' : ''}${number(cell.growthShift * 100)} จุด</th>`).join('')}</tr></thead>
        <tbody>${grid.map((row) => `<tr><td>${percent(row.wacc)}</td>${row.cells.map((cell) => `<td class="${cell.value === null ? '' : cell.value >= price ? 'above' : 'below'} ${row.waccShift === 0 && cell.growthShift === 0 ? 'base' : ''}">${cell.value === null ? '–' : number(Math.max(cell.value, 0), 2)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
        <p class="note">ช่องสีเขียวคือมูลค่าสูงกว่าราคาปัจจุบัน ช่องสีแดงคือต่ำกว่า กรอบหนาคือสมมติฐานที่ใช้อยู่</p>`;

    const rows = [
        ['มูลค่าปัจจุบันของกระแสเงินสดปีที่ 1–10', result.pvForecast],
        [`มูลค่าปัจจุบันหลังปีที่ 10 (${percent(result.terminalShare, 0)} ของกิจการ)`, result.pvTerminal],
        ['บวก เงินสดและเงินลงทุนระยะสั้น', result.bridge.cash],
        ['หัก หนี้ที่มีดอกเบี้ย', -result.bridge.debt || 0],
        ['หัก ส่วนของผู้ถือหุ้นส่วนน้อย', -result.bridge.minority || 0],
    ];
    $('#bridge').innerHTML = `<div class="scroll"><table class="bridge"><tbody>${rows.map(([name, amount]) => `<tr><td>${name}</td><td>${number(amount)}</td></tr>`).join('')}
        <tr class="total"><td>มูลค่าส่วนของผู้ถือหุ้น (ล้าน ${currency()})</td><td>${number(result.equityValue)}</td></tr>
        <tr><td>หารด้วยจำนวนหุ้น (ล้านหุ้น)</td><td>${number(state.fin.shares, 2)}</td></tr>
        <tr class="total"><td>มูลค่าต่อหุ้น (${currency()})</td><td>${number(value, 2)}</td></tr></tbody></table></div>`;
}

function showMessage(text, isError = false) {
    const element = $('#searchMessage');
    element.textContent = text;
    element.hidden = !text;
    element.classList.toggle('error', isError);
}

async function getJson(path) {
    const response = await fetch(path, { headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));

    return { status: response.status, body };
}

async function fetchCompany(symbol, market) {
    const button = $('#searchForm button[type=submit]');
    button.disabled = true;
    $('#searchResults').hidden = true;
    showMessage(`กำลังดึงข้อมูล ${symbol}…`);
    try {
        const { status, body } = await getJson(`api/company?symbol=${encodeURIComponent(symbol)}&market=${market}`);
        if (status === 200) {
            loadFromPayload(body, market);
            showMessage(body.period ? `ดึงข้อมูล ${body.symbol} แล้ว (${body.period}) ตรวจตัวเลขกับงบจริงก่อนใช้` : '');
        } else if (status === 404) {
            await searchSymbols(symbol, market);
        } else if (status === 501) {
            showMessage('ยังไม่ได้ตั้งค่าแหล่งข้อมูลบนเซิร์ฟเวอร์ กด "กรอกตัวเลขเอง" เพื่อใช้งานต่อได้', true);
        } else {
            showMessage(body.message || 'ดึงข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง หรือกรอกตัวเลขเอง', true);
        }
    } catch {
        showMessage('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตอนนี้ใช้ได้เฉพาะการกรอกตัวเลขเองและรายการที่บันทึกไว้', true);
    } finally {
        button.disabled = false;
    }
}

async function searchSymbols(query, market) {
    const { status, body } = await getJson(`api/search?q=${encodeURIComponent(query)}&market=${market}`);
    const matches = status === 200 && Array.isArray(body.results) ? body.results : [];
    if (!matches.length) {
        showMessage(`ไม่พบหุ้น "${query}" ในตลาด${market === 'TH' ? 'ไทย' : 'อเมริกา'} ตรวจชื่อย่ออีกครั้ง`, true);

        return;
    }
    showMessage('ไม่พบชื่อย่อนี้ตรงตัว เลือกจากรายการใกล้เคียง');
    $('#searchResults').innerHTML = matches.map((match) => `<li><button type="button" data-symbol="${escapeHtml(match.symbol)}"><b>${escapeHtml(match.symbol)}</b><span>${escapeHtml(match.name)}</span><small>${escapeHtml(match.exchange || '')}</small></button></li>`).join('');
    $('#searchResults').hidden = false;
}

function savedItems() {
    return readStore(SAVED_KEY, []);
}

function renderSaved() {
    const items = savedItems();
    $('#savedCount').textContent = items.length;
    $('#savedList').innerHTML = items.length
        ? items.map((item, index) => `<li><div class="meta"><b>${escapeHtml(item.company.symbol)}</b> ${escapeHtml(item.company.name || '')}<small>มูลค่า ${number(item.value, 2)} · ราคา ${number(item.price, 2)} ${escapeHtml(item.company.currency || '')} · ${escapeHtml(item.savedAt)}</small></div>
            <div class="row"><button class="button small" type="button" data-open="${index}">เปิด</button><button class="button small ghost" type="button" data-remove="${index}">ลบ</button></div></li>`).join('')
        : '<li>ยังไม่มีรายการ กด "บันทึก" ที่หุ้นที่ประเมินแล้วเพื่อเก็บไว้ดูภายหลัง</li>';
}

function saveCurrent() {
    const result = forecast(modelInput().input);
    const entry = { company: { ...state.company, example: false }, market: state.market, price: state.price, fin: state.fin, assumptions: state.a, value: result.ok ? result.valuePerShare : null, savedAt: new Date().toLocaleDateString('th-TH') };
    const items = savedItems().filter((item) => item.company.symbol !== entry.company.symbol || item.market !== entry.market);
    writeStore(SAVED_KEY, [entry, ...items]);
    renderSaved();
    $('#saveButton').textContent = 'บันทึกแล้ว';
}

function bindEvents() {
    $('#searchForm').addEventListener('submit', (event) => {
        event.preventDefault();
        const symbol = $('#symbolInput').value.trim().toUpperCase();
        if (symbol) {
            fetchCompany(symbol, document.querySelector('input[name=market]:checked').value);
        }
    });
    $('#searchResults').addEventListener('click', (event) => {
        const button = event.target.closest('[data-symbol]');
        if (button) {
            $('#symbolInput').value = button.dataset.symbol;
            fetchCompany(button.dataset.symbol, document.querySelector('input[name=market]:checked').value);
        }
    });
    $('#manualButton').addEventListener('click', () => {
        const market = document.querySelector('input[name=market]:checked').value;
        const symbol = $('#symbolInput').value.trim().toUpperCase();
        setCompany({ company: { symbol, name: symbol || 'หุ้นของคุณ', currency: MARKET_DEFAULTS[market].currency, period: 'กรอกเอง' }, market, price: null, fin: { minority: 0, interestExpense: 0 }, assumptions: suggestAssumptions({ history: [] }, market) });
        showMessage('กรอกราคาและตัวเลขจากงบการเงินทางขวา ผลจะคำนวณทันทีเมื่อครบ');
    });
    $('#workspace').addEventListener('input', (event) => {
        const target = event.target;
        if (target.name === 'waccMode') {
            state.a.waccMode = target.value;
        } else if (target.dataset.key) {
            const raw = target.value === '' ? NaN : Number(target.value);
            const value = PERCENT_KEYS.has(target.dataset.key) ? raw / 100 : raw;
            if (target.dataset.scope === 'price') {
                state.price = value;
            } else {
                state[target.dataset.scope][target.dataset.key] = value;
            }
        } else {
            return;
        }
        renderResults();
        writeStore(DRAFT_KEY, { company: state.company, market: state.market, price: state.price, fin: state.fin, assumptions: state.a });
    });
    $('#workspace').addEventListener('click', (event) => {
        if (event.target.id === 'saveButton') {
            saveCurrent();
        }
    });
    $('#savedButton').addEventListener('click', () => {
        renderSaved();
        $('#savedDialog').showModal();
    });
    $('#savedDialog').addEventListener('click', (event) => {
        const target = event.target;
        if (target.dataset.close !== undefined) {
            $('#savedDialog').close();
        } else if (target.dataset.open !== undefined) {
            const item = savedItems()[Number(target.dataset.open)];
            setCompany(item);
            $('#savedDialog').close();
            showMessage('');
        } else if (target.dataset.remove !== undefined) {
            writeStore(SAVED_KEY, savedItems().filter((_, index) => index !== Number(target.dataset.remove)));
            renderSaved();
        }
    });

    let installPrompt = null;
    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        installPrompt = event;
        $('#installButton').hidden = false;
    });
    $('#installButton').addEventListener('click', async () => {
        await installPrompt?.prompt();
        installPrompt = null;
        $('#installButton').hidden = true;
    });
    const showConnection = () => { $('#offlineBadge').hidden = navigator.onLine; };
    window.addEventListener('online', showConnection);
    window.addEventListener('offline', showConnection);
    showConnection();
}

bindEvents();
renderSaved();
const draft = readStore(DRAFT_KEY, null);
if (draft?.company && draft.fin && draft.assumptions) {
    setCompany(draft);
} else {
    loadExample();
}
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
}
