/**
 * CBD15-Li 产品数据批量导入脚本 (Node.js)
 * 复用 server.js 已验证的认证 + CSRF 机制
 * 三阶段：1) 创建物料  2) 创建 BOM  3) 写入计价成本
 *
 * 运行方式（在 bom-cost-mcp 目录下）:
 *   node CBD15-Li_Full_Import.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../EPK/.env') });

const https   = require('https');
const fs      = require('fs');
const path    = require('path');

// ── 配置 ──────────────────────────────────────────────────────────
const PLANT       = '1710';
const DELAY_MS    = 300;
const EXCEL_PATH  = 'C:\\Joule Work\\CBD15-Li_Migration_Cockpit_Import.xlsx';
const LOG_PATH    = `C:\\Joule Work\\CBD15-Li_import_${Date.now()}.json`;

// ── 测试模式：每阶段只处理前 N 条（0 = 全量运行）────────────────
const TEST_LIMIT  = 6;   // Phase2: 跳过4个已存 BOM 后触发第一个新 BOM; Phase3: 看前6条成本记录

// ── S/4HANA 连接（复用 server.js 方式）────────────────────────────
let S4_HOST = (process.env.S4_HOST || '').replace(/\/$/, '');
const S4_USER   = process.env.S4_USER || '';
const S4_PASS   = process.env.S4_PASS || '';

// 自动补全 -api 子域
if (S4_HOST && !S4_HOST.includes('-api.') && S4_HOST.includes('.s4hana.cloud.sap')) {
    S4_HOST = S4_HOST.replace('.s4hana.cloud.sap', '-api.s4hana.cloud.sap');
}

const PRODUCT_SRV = '/sap/opu/odata4/sap/api_product/srvd_a2x/sap/product/0001';
const BOM_SRV     = '/sap/opu/odata/sap/API_BILL_OF_MATERIAL_SRV;v=0002';

const PRICE_CTRL = { ROH: 'V', HALB: 'S', FERT: 'S' };

const UNIT_MAP = { SET: 'EA', ST: 'EA' };
function normalizeUnit(u) {
    u = UNIT_MAP[u] || u;
    return ['PC','EA','KG','G','M','L','PCS','CS','ML'].includes(u) ? u : 'EA';
}

// 已存在不用重新创建的物料（可安全扩充）
const EXISTING_MATERIALS = new Set([
    'EP-10000001','EP-20001000','EP-20002000','EP-20003000','EP-20004000',
    'EP-20005000','EP-20006000','EP-20007000','EP-20008000','EP-20009000',
    'EP-20010000','EP-21001000','EP-21004000','EP-21002000'
]);
const EXISTING_BOMS = {
    'EP-10000001': '00002069',
    'EP-20001000': '00002103',
    'EP-20004000': '00002106',
    'EP-20005000': '00002108',
};

// ── HTTP 工具 ──────────────────────────────────────────────────────
function authHeader() {
    return 'Basic ' + Buffer.from(`${S4_USER}:${S4_PASS}`).toString('base64');
}

function s4Request(method, urlPath, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const host = new URL(S4_HOST);
        const bodyStr = body ? JSON.stringify(body) : null;
        const headers = {
            Authorization: authHeader(),
            Accept: 'application/json',
            ...(bodyStr ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr)
            } : {}),
            ...extraHeaders
        };
        const req = https.request({
            hostname: host.hostname, port: 443,
            path: urlPath, method,
            headers
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                resolve({ status: res.statusCode, headers: res.headers, body: data });
            });
        });
        req.on('error', reject);
        if (bodyStr) req.end(bodyStr); else req.end();
    });
}

async function fetchCSRF(srvPath) {
    const r = await s4Request('GET', srvPath, null, { 'x-csrf-token': 'Fetch' });
    const token = r.headers['x-csrf-token'] || '';
    const cookies = (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    if (!token || token === 'Required') throw new Error(`CSRF fetch failed (HTTP ${r.status})`);
    return { token, cookies };
}

async function s4Post(urlPath, body, csrf, cookies) {
    const extra = { 'x-csrf-token': csrf };
    if (cookies) extra['Cookie'] = cookies;
    const r = await s4Request('POST', urlPath, body, extra);
    return r;
}

async function s4Patch(urlPath, body, csrf, cookies) {
    const extra = { 'x-csrf-token': csrf, 'If-Match': '*' };
    if (cookies) extra['Cookie'] = cookies;
    const r = await s4Request('PATCH', urlPath, body, extra);
    return r;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseJson(str) {
    try { return JSON.parse(str); } catch { return null; }
}

function isAlreadyExists(r) {
    const body = r.body || '';
    return r.status === 409 || r.status === 422 ||
        body.includes('already') || body.includes('exist') ||
        body.includes('MM017') || body.includes('BM016') || body.includes('BM003');
}

// ── Phase 1: 创建物料主数据 ─────────────────────────────────────────
async function createMaterial(matnr, mtart, desc, unit, csrf, cookies) {
    unit = normalizeUnit(unit);
    const payload = {
        Product: matnr, ProductType: mtart,
        BaseUnit: unit, IndustrySector: 'M',
        _ProductDescription: [{ Product: matnr, Language: 'ZH', ProductDescription: desc }],
        _ProductPlant: [{ Product: matnr, Plant: PLANT }]
    };
    let r = await s4Post(PRODUCT_SRV + '/Product', payload, csrf, cookies);
    if (r.status >= 200 && r.status < 300) return 'created';
    if (isAlreadyExists(r) || r.status === 400) {
        // 重试不带工厂
        const p2 = { ...payload }; delete p2._ProductPlant;
        r = await s4Post(PRODUCT_SRV + '/Product', p2, csrf, cookies);
        if (r.status >= 200 && r.status < 300) return 'created-no-plant';
        if (isAlreadyExists(r)) return 'exists';
        return `ERR ${r.status}: ${r.body.slice(0, 80)}`;
    }
    return `ERR ${r.status}: ${r.body.slice(0, 80)}`;
}

// 工厂扩展 — 通过 localhost:8080 MCP server（已验证认证可用）
const http = require('http');
async function addPlant(matnr) {
    return new Promise(resolve => {
        const body = JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'add_plant_to_material',
                      arguments: { material: matnr, plant: PLANT } }
        });
        const req = http.request({
            hostname: 'localhost', port: 8080, path: '/mcp', method: 'POST',
            headers: { 'Content-Type': 'application/json',
                       'Content-Length': Buffer.byteLength(body) }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const resp = JSON.parse(data);
                    if (resp?.error) { resolve(`+plant_ERR ${resp.error.message?.slice(0,50)}`); return; }
                    const txt = resp?.result?.content?.[0]?.text || '';
                    const obj = JSON.parse(txt);
                    if (obj.success || txt.includes('already')) resolve('+plant(mcp)');
                    else resolve(`+plant_WARN ${txt.slice(0,50)}`);
                } catch { resolve('+plant_ERR parse'); }
            });
        });
        req.on('error', e => resolve(`+plant_ERR ${e.message}`));
        req.end(body);
    });
}

// ── Phase 2: 创建 BOM ──────────────────────────────────────────────
async function createBOM(matnr, items, csrf, cookies) {
    // BOM 行项目单位：SET 在此系统无英文文本 → 映射为 EA
    const unitMap = { 'SET': 'EA', 'ST': 'EA', 'PCS': 'PC' };
    const bomItems = items.map(it => ({
        BillOfMaterialComponent:    it.IDNRK,
        BillOfMaterialItemQuantity: String(it.MENGE || '1'),
        BillOfMaterialItemUnit:     unitMap[it.MEINS] || it.MEINS || 'EA',
        BillOfMaterialItemCategory: it.POSTP || 'L',
        IsProductionRelevant: true
    }));
    const payload = {
        Material: matnr, Plant: PLANT,
        BillOfMaterialVariantUsage: '1',
        to_BillOfMaterialItem: { results: bomItems }
    };
    const r = await s4Post(BOM_SRV + '/MaterialBOM', payload, csrf, cookies);
    if (r.status >= 200 && r.status < 300) return 'created';
    if (isAlreadyExists(r)) return 'exists';
    // 倒出完整错误（含所有 errordetails）以精确诊断
    try {
        const eb = JSON.parse(r.body);
        const top = eb?.error?.message?.value || '';
        const details = (eb?.error?.innererror?.errordetails || [])
            .map(d => d?.message?.value || d?.message || JSON.stringify(d))
            .join('\n    > ');
        return `ERR ${r.status}: ${top}${details ? '\n    > ' + details : ''}`;
    } catch { return `ERR ${r.status}: ${r.body.slice(0, 400)}`; }
}

// ── Phase 3: 写入计价控制 + 成本 ──────────────────────────────────
// 使用 OData V2 API_PRODUCT_SRV（与 V4 SrvD A2X 并行，由 SAP_COM_0009 授权）
const PRODUCT_SRV_V2 = '/sap/opu/odata/sap/API_PRODUCT_SRV';

async function setValuation(matnr, mtart, priceCNY, csrf, cookies) {
    const ctrl     = PRICE_CTRL[mtart] || 'S';
    const priceStr = parseFloat(priceCNY || 0).toFixed(2);

    // ── 诊断 GET：先读取记录，了解字段结构和记录是否存在 ──────────
    // ValuationType='' 会被 SAP URL 解析器误读为新 segment，改为不带 ValuationType
    const v2Url = `${S4_HOST}${PRODUCT_SRV_V2}/A_ProductValuation(Product='${encodeURIComponent(matnr)}',ValuationArea='${PLANT}')`;
    const getExtra = { 'Authorization': `Basic ${Buffer.from(`${S4_USER}:${S4_PASS}`).toString('base64')}`,
                       'Accept': 'application/json' };
    const getR = await s4Request('GET', v2Url, null, getExtra);
    if (getR.status === 200) {
        // 记录存在 → 打印关键字段名（帮助确认正确字段）
        try {
            const rec = JSON.parse(getR.body);
            const d = rec?.d || rec;
            console.log(`  [diag GET ok] PriceControl=${d.PriceControl} StdPrice=${d.StandardPrice} MAP=${d.MovingAveragePrice} PriceUnit=${d.PriceUnitQty}`);
        } catch { console.log(`  [diag GET raw] ${getR.body.slice(0, 200)}`); }
    } else {
        console.log(`  [diag GET] ${getR.status}: ${getR.body.slice(0, 150)}`);
    }

    // ① V2 PATCH（记录存在时）
    const patchExtra = { 'x-csrf-token': csrf, 'If-Match': '*',
                         'Accept': 'application/json', 'Content-Type': 'application/json' };
    if (cookies) patchExtra['Cookie'] = cookies;
    const patchBody = ctrl === 'S'
        ? { StandardPrice: priceStr,      PriceUnitQty: '1.000' }
        : { MovingAveragePrice: priceStr, PriceUnitQty: '1.000' };
    const r = await s4Request('PATCH', v2Url, patchBody, patchExtra);
    if (r.status >= 200 && r.status < 300) return `ok-v2(${ctrl}=¥${priceStr})`;
    console.log(`  [PATCH v2 ${r.status}] ${r.body.slice(0, 200)}`);

    // ② V2 POST（记录不存在时）
    // ValuationClass 是 POST 创建记录的必填字段（M3/407）
    const valClass = { 'FERT': '7920', 'HALB': '7900', 'ROH': '3000' }[mtart] || '7900';
    const postBody = { ...patchBody, Product: matnr, ValuationArea: PLANT, ValuationType: '',
                       ValuationClass: valClass };
    const r2 = await s4Post(`${S4_HOST}${PRODUCT_SRV_V2}/A_ProductValuation`, postBody, csrf, cookies);
    if (r2.status >= 200 && r2.status < 300) return `created-v2(${ctrl}=¥${priceStr})`;
    console.log(`  [POST v2 ${r2.status}] ${r2.body.slice(0, 200)}`);

    return `ERR v2=${r.status}/${r2.status}: see above`;
}

// ── 读取 Excel ────────────────────────────────────────────────────
async function readExcel() {
    // 使用 xlsx 模块；若未安装则提示
    let XLSX;
    try { XLSX = require('xlsx'); }
    catch {
        console.error('❌ 请先安装 xlsx: npm install xlsx');
        process.exit(1);
    }
    const wb = XLSX.readFile(EXCEL_PATH);

    function sheetToRows(ws) {
        const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (raw.length < 2) return [];
        const headers = raw[0].map(h => String(h).split('\n')[0].trim());
        return raw.slice(1)
            .filter(r => r.some(v => v !== ''))
            .map(r => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? '').trim()])));
    }

    const matRows  = sheetToRows(wb.Sheets['1_物料主数据']);
    const bomItems = sheetToRows(wb.Sheets['3_BOM行项目']);
    return { matRows, bomItems };
}

// ── 主程序 ────────────────────────────────────────────────────────
async function main() {
    if (!S4_HOST || !S4_USER || !S4_PASS) {
        console.error('❌ .env 中缺少 S4_HOST / S4_USER / S4_PASS，请检查 EPK/.env');
        process.exit(1);
    }
    console.log(`\nS4_HOST : ${S4_HOST}`);
    console.log(`S4_USER : ${S4_USER}`);
    console.log(`密码长度: ${S4_PASS.length} 字符\n`);

    // 读取 Excel
    if (!fs.existsSync(EXCEL_PATH)) {
        console.error(`❌ 找不到: ${EXCEL_PATH}`); process.exit(1);
    }
    const { matRows, bomItems } = await readExcel();
    const bomMap = {};
    for (const it of bomItems) {
        const parent = it['MATNR'] || '';
        if (!bomMap[parent]) bomMap[parent] = [];
        bomMap[parent].push(it);
    }
    console.log(`Excel 读取完成: ${matRows.length} 物料, ${Object.keys(bomMap).length} BOM`);

    const toCreate = matRows.filter(m => !EXISTING_MATERIALS.has(m['MATNR']));
    const log = { phase1: [], phase2: [], phase3: [], summary: {} };

    // ════════════════════════════════════════
    // PHASE 1: 创建物料 + 挂工厂
    // ════════════════════════════════════════
    console.log(`\n${'='.repeat(60)}\nPhase 1: 创建物料主数据\n${'='.repeat(60)}`);
    console.log(`需创建: ${toCreate.length} 条（跳过已知 ${EXISTING_MATERIALS.size} 条）\n`);

    // 先尝试 Product V4 端点，失败则 fallback 到 BOM V2（两者在同一 SAP 后端）
    let csrf_v4, ck_v4;
    try {
        ({ token: csrf_v4, cookies: ck_v4 } = await fetchCSRF(PRODUCT_SRV + '/'));
        console.log('✅ CSRF 获取成功（Product V4 根路径）\n');
    } catch (e1) {
        console.log(`  → Product V4 根路径失败 (${e1.message})，尝试 BOM V2 fallback...`);
        try {
            ({ token: csrf_v4, cookies: ck_v4 } = await fetchCSRF(BOM_SRV + '/'));
            console.log('✅ CSRF 获取成功（BOM V2 fallback）\n');
        } catch (e2) {
            console.error('❌ CSRF 全部失败。请先在 S/4HANA 中解锁 BTP_COST_OPT 用户，然后重试。');
            console.error('   路径：维护通信用户 → BTP_COST_OPT → 解锁 + 重设密码');
            process.exit(1);
        }
    }

    // 先对已知物料挂工厂
    process.stdout.write(`→ 为 ${EXISTING_MATERIALS.size} 个已知物料确认工厂 ${PLANT}...`);
    for (const m of EXISTING_MATERIALS) {
        await addPlant(m);
        await sleep(DELAY_MS * 0.5);
    }
    console.log(' 完成\n');

    let cnt1 = { created: 0, exists: 0, error: 0, plantOk: 0 };
    const createdSet = new Set(EXISTING_MATERIALS);
    const mat1Limit = TEST_LIMIT > 0 ? Math.min(TEST_LIMIT, toCreate.length) : toCreate.length;
    if (TEST_LIMIT > 0) console.log(`⚡ 测试模式：只处理前 ${mat1Limit} 条物料\n`);

    for (let i = 0; i < mat1Limit; i++) {
        const mat   = toCreate[i];
        const matnr = mat['MATNR'] || mat['MATNR\n物料号'] || '';
        const mtart = mat['MTART'] || mat['MTART\n物料类型'] || 'ROH';
        const desc  = mat['MAKTX'] || mat['MAKTX\n物料描述'] || '';
        const unit  = mat['MEINS'] || mat['MEINS\n基本计量单位'] || 'PC';
        if (!matnr) continue;

        let st = await createMaterial(matnr, mtart, desc, unit, csrf_v4, ck_v4);

        // 挂工厂
        if (st.startsWith('created') || st === 'exists') {
            const ps = await addPlant(matnr);
            if (ps.includes('+plant')) cnt1.plantOk++;
            st += `  [${ps}]`;
            await sleep(DELAY_MS * 0.5);
            createdSet.add(matnr);
        }

        const isNew  = st.startsWith('created') && !st.includes('exists');
        const isSkip = st.includes('exists');
        const icon   = isNew ? '✅' : (isSkip ? '⚠️' : '❌');
        const line   = `[${String(i+1).padStart(3)}/${toCreate.length}] ${icon} ${matnr.padEnd(20)}  ${desc.slice(0,24).padEnd(24)}  → ${st}`;
        console.log(line);
        log.phase1.push(line);

        if (isNew)   cnt1.created++;
        else if (isSkip) cnt1.exists++;
        else         cnt1.error++;

        await sleep(DELAY_MS);
        if ((i + 1) % 40 === 0) {
            const r = await fetchCSRF(PRODUCT_SRV + '/').catch(() => null);
            if (r) { csrf_v4 = r.token; ck_v4 = r.cookies; }
        }
    }
    console.log(`\nPhase 1 完成: 新建 ${cnt1.created} | 已存在 ${cnt1.exists} | 错误 ${cnt1.error} | 工厂1710挂载 ${cnt1.plantOk}`);

    // ════════════════════════════════════════
    // PHASE 2: 创建 BOM
    // ════════════════════════════════════════
    console.log(`\n${'='.repeat(60)}\nPhase 2: 创建 BOM 结构\n${'='.repeat(60)}`);
    console.log(`共 ${Object.keys(bomMap).length} 个父级物料\n`);

    let { token: csrf_v2, cookies: ck_v2 } = await fetchCSRF(BOM_SRV + '/').catch(e => {
        console.error('❌ BOM V2 CSRF 获取失败:', e.message); process.exit(1);
    });
    console.log('✅ CSRF 获取成功（BOM V2 API）\n');

    // ── BOM 前置：确保所有组件物料都有工厂 1710 视图（BOM/201 前置条件）──
    const allMaterials = matRows.map(m => m.MATNR).filter(Boolean);
    process.stdout.write(`→ 批量确认 ${allMaterials.length} 个物料的工厂 ${PLANT} 视图（BOM 前置）...`);
    let plantFixed = 0, plantErr = 0;
    const sampleErrs = [];
    for (const m of allMaterials) {
        const ps = await addPlant(m);
        if (ps.includes('mcp') || ps === '+plant' || ps.includes('patch')) plantFixed++;
        else if (ps.includes('ERR')) { plantErr++; if (sampleErrs.length < 3) sampleErrs.push(`${m}: ${ps}`); }
        await sleep(DELAY_MS * 0.3);
    }
    console.log(` 完成（挂载 ${plantFixed} 个 | 失败 ${plantErr} 个）`);
    if (sampleErrs.length) console.log('  ⚠️  失败样本:', sampleErrs.join('\n              '));
    console.log();

    let cnt2 = { created: 0, exists: 0, error: 0 };
    const parents = Object.keys(bomMap).sort();
    const bomLimit = TEST_LIMIT > 0 ? Math.min(TEST_LIMIT, parents.length) : parents.length;
    if (TEST_LIMIT > 0) console.log(`⚡ 测试模式：只处理前 ${bomLimit} 个 BOM\n`);

    for (let j = 0; j < bomLimit; j++) {
        const parent = parents[j];
        const items  = bomMap[parent];
        if (EXISTING_BOMS[parent]) {
            const line = `[${String(j+1).padStart(2)}/${parents.length}] ⚠️  ${parent.padEnd(20)}  已存在 BOM ${EXISTING_BOMS[parent]}（跳过）`;
            console.log(line); log.phase2.push(line);
            cnt2.exists++; continue;
        }
        const st   = await createBOM(parent, items, csrf_v2, ck_v2);
        const icon = st === 'created' ? '✅' : (st === 'exists' ? '⚠️' : '❌');
        const line = `[${String(j+1).padStart(2)}/${parents.length}] ${icon} ${parent.padEnd(20)}  ${items.length} items  → ${st}`;
        console.log(line); log.phase2.push(line);

        if (st === 'created')  cnt2.created++;
        else if (st === 'exists') cnt2.exists++;
        else cnt2.error++;

        await sleep(DELAY_MS);
        if ((j + 1) % 10 === 0) {
            const r = await fetchCSRF(BOM_SRV + '/').catch(() => null);
            if (r) { csrf_v2 = r.token; ck_v2 = r.cookies; }
        }
    }
    console.log(`\nPhase 2 完成: 新建 ${cnt2.created} | 已存在 ${cnt2.exists} | 错误 ${cnt2.error}`);

    // ════════════════════════════════════════
    // PHASE 3: 写入计价控制 + 参考成本
    // ════════════════════════════════════════
    console.log(`\n${'='.repeat(60)}\nPhase 3: 写入计价控制 + 参考成本\n${'='.repeat(60)}`);

    let { token: csrf_p3, cookies: ck_p3 } = await fetchCSRF(PRODUCT_SRV + '/').catch(e => {
        console.error('❌ Phase3 CSRF 失败:', e.message); process.exit(1);
    });
    console.log('✅ CSRF 获取成功\n');

    let cnt3 = { ok: 0, error: 0 };
    const mat3Limit = TEST_LIMIT > 0 ? Math.min(TEST_LIMIT, matRows.length) : matRows.length;
    if (TEST_LIMIT > 0) console.log(`⚡ 测试模式：只处理前 ${mat3Limit} 条成本记录\n`);

    for (let k = 0; k < mat3Limit; k++) {
        const mat   = matRows[k];
        const matnr = mat['MATNR'] || mat['MATNR\n物料号'] || '';
        const mtart = mat['MTART'] || mat['MTART\n物料类型'] || 'ROH';
        const price = mat['参考成本(CNY)'] || '0';
        if (!matnr || parseFloat(price) === 0) continue;

        const st   = await setValuation(matnr, mtart, price, csrf_p3, ck_p3);
        const icon = st.startsWith('ok') || st.startsWith('created') ? '✅' : '❌';
        const ctrl = PRICE_CTRL[mtart] || 'S';
        const line = `[${String(k+1).padStart(3)}/${matRows.length}] ${icon} ${matnr.padEnd(20)}  ${mtart} ${ctrl}  ¥${String(price).padStart(7)}  → ${st}`;
        console.log(line); log.phase3.push(line);

        if (icon === '✅') cnt3.ok++; else cnt3.error++;
        await sleep(DELAY_MS);
        if ((k + 1) % 40 === 0) {
            const r = await fetchCSRF(PRODUCT_SRV + '/').catch(() => null);
            if (r) { csrf_p3 = r.token; ck_p3 = r.cookies; }
        }
    }
    console.log(`\nPhase 3 完成: 成功 ${cnt3.ok} | 错误 ${cnt3.error}`);

    // ── 保存日志 ──────────────────────────────────────────────────
    log.summary = {
        phase1: cnt1, phase2: cnt2, phase3: cnt3,
        timestamp: new Date().toISOString()
    };
    fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2), 'utf8');
    console.log(`\n📄 报告已保存: ${LOG_PATH}`);
    console.log('✅ 导入完成！');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
