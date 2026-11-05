/**
 * create_all_boms.js
 * 使用从 debug.log 提取的精确数据，批量创建所有剩余的 BOM
 *
 * 前置条件:
 *   1. 已运行 extend_plants.js（191 个物料已有工厂 1710 数据）
 *   2. EP-10000001 BOM 已存在 (00002069)
 *   3. EP-20001000、EP-20004000、EP-20005000 各有 1 个组件的不完整 BOM
 *      → 这 3 个需要在 SAP MM03 中手动补全，或通过 BAPI 修改
 *
 * 运行方式: node create_all_boms.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../EPK/.env') });
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const BOM_SRV = '/sap/opu/odata/sap/API_BILL_OF_MATERIAL_SRV;v=0002';
const PLANT   = '1710';
const LOG_FILE = path.join(__dirname, 'create_boms.log');

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    process.stdout.write(line);
    fs.appendFileSync(LOG_FILE, line);
}

// ── Complete BOM data from debug.log ─────────────────────────────────────────
// Format: { material: 'EP-...', items: [{component, quantity, unit}, ...] }
// Items already completed: EP-10000001 (done), EP-20001000/04000/05000 (partial - skip)
const BOMS_TO_CREATE = [
    // ─── Level 2: EP-20xxx → EP-21xxx ────────────────────────────────────────
    // NOTE: EP-20001000, EP-20004000, EP-20005000 have partial BOMs → SKIPPED
    {
        material: 'EP-20002000',
        items: [
            { component: 'EP-21002000', quantity: 1,  unit: 'PC' },
            { component: 'EP-21002100', quantity: 1,  unit: 'EA' },
            { component: 'EP-21002200', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-21002300', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-21002400', quantity: 1,  unit: 'PC', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-20003000',
        items: [
            { component: 'EP-21003000', quantity: 1,  unit: 'PC' },
            { component: 'EP-21003100', quantity: 1,  unit: 'PC' },
            { component: 'EP-21003200', quantity: 1,  unit: 'EA', itemCategory: 'N' },
            { component: 'EP-21003300', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-21003400', quantity: 1,  unit: 'PC', itemCategory: 'N' },
        ]
    },
    // EP-20004000 partial BOM exists → skip; needs manual completion:
    // remaining: EP-21004100(PC), EP-21004200(PC), EP-21004300(EA), EP-21004400(PC)
    {
        material: 'EP-20006000',
        items: [
            { component: 'EP-21006000', quantity: 1,  unit: 'EA' },
            { component: 'EP-21006100', quantity: 1,  unit: 'EA' },
            { component: 'EP-21006200', quantity: 1,  unit: 'EA', itemCategory: 'N' },
            { component: 'EP-21006300', quantity: 1,  unit: 'EA', itemCategory: 'N' },
            { component: 'EP-21006400', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-21006500', quantity: 1,  unit: 'PC', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-20007000',
        items: [
            { component: 'EP-21007000', quantity: 1,  unit: 'PC' },
            { component: 'EP-21007100', quantity: 1,  unit: 'EA' },
            { component: 'EP-21007200', quantity: 1,  unit: 'PC' },
            { component: 'EP-21007300', quantity: 1,  unit: 'EA', itemCategory: 'N' },
            { component: 'EP-21007400', quantity: 1,  unit: 'PC', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-20008000',
        items: [
            { component: 'EP-21008000', quantity: 1,  unit: 'PC' },
            { component: 'EP-21008100', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-21008200', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-21008300', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-21008400', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-21008500', quantity: 1,  unit: 'PC', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-20009000',
        items: [
            { component: 'EP-21009000', quantity: 2,  unit: 'EA' },
            { component: 'EP-21009100', quantity: 4,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-21009200', quantity: 2,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-21009300', quantity: 1,  unit: 'PC', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-20010000',
        items: [
            { component: 'EP-21010001', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-21010002', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-21010003', quantity: 1,  unit: 'EA', itemCategory: 'N' },
            { component: 'EP-21010004', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-21010005', quantity: 1,  unit: 'EA', itemCategory: 'N' },
            { component: 'EP-21010006', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-21010007', quantity: 1,  unit: 'EA', itemCategory: 'N' },
            { component: 'EP-21010008', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-21010009', quantity: 1,  unit: 'EA', itemCategory: 'N' },
        ]
    },

    // ─── Level 3: EP-21xxx → EP-31xxx ────────────────────────────────────────
    {
        material: 'EP-21001000',
        items: [
            { component: 'EP-31001001', quantity: 40, unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31001002', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31001003', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31001004', quantity: 4,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31001005', quantity: 4,  unit: 'PC', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-21001100',
        items: [
            { component: 'EP-31001100', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31001101', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31001102', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31001103', quantity: 2,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31001104', quantity: 1,  unit: 'EA', itemCategory: 'N' },
            { component: 'EP-31001105', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31001106', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31001107', quantity: 1,  unit: 'PC', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-21001200',
        items: [
            { component: 'EP-31001200', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31001201', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31001202', quantity: 1,  unit: 'EA', itemCategory: 'N' },
            { component: 'EP-31001203', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31001204', quantity: 4,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31001205', quantity: 1,  unit: 'EA', itemCategory: 'N' },
            { component: 'EP-31001206', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31001207', quantity: 1,  unit: 'PC', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-21002000',
        items: [
            { component: 'EP-31002001', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31002002', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31002003', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31002004', quantity: 8,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31002005', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31002006', quantity: 2,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31002007', quantity: 2,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31002008', quantity: 2,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31002009', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31002010', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31002011', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31002012', quantity: 1,  unit: 'EA', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-21002100',
        items: [
            { component: 'EP-31002100', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31002101', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31002102', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31002103', quantity: 2,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31002104', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31002105', quantity: 1,  unit: 'EA', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-21003000',
        items: [
            { component: 'EP-31003001', quantity: 6,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31003002', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31003003', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31003004', quantity: 3,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31003005', quantity: 4,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31003006', quantity: 1,  unit: 'EA', itemCategory: 'N' },
            { component: 'EP-31003007', quantity: 2,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31003008', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31003009', quantity: 1,  unit: 'EA', itemCategory: 'N' },
            { component: 'EP-31003010', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31003011', quantity: 1,  unit: 'EA', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-21003100',
        items: [
            { component: 'EP-31003100', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31003101', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31003102', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31003103', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31003104', quantity: 1,  unit: 'EA', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-21004000',
        items: [
            { component: 'EP-31004001', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31004002', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31004003', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31004004', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31004005', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31004006', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31004007', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31004008', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31004009', quantity: 1,  unit: 'PC', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-21004100',
        items: [
            { component: 'EP-31004100', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31004101', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31004102', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31004103', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31004104', quantity: 1,  unit: 'EA', itemCategory: 'N' },
            { component: 'EP-31004105', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31004106', quantity: 1,  unit: 'PC', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-21005000',
        items: [
            { component: 'EP-31005001', quantity: 2,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31005002', quantity: 3,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31005003', quantity: 2,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31005004', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31005005', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31005006', quantity: 1,  unit: 'EA', itemCategory: 'N' },
            { component: 'EP-31005007', quantity: 8,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31005008', quantity: 2,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31005009', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31005010', quantity: 1,  unit: 'PC', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-21005100',
        items: [
            { component: 'EP-31005100', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31005101', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31005102', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31005103', quantity: 4,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31005104', quantity: 2,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31005105', quantity: 4,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31005106', quantity: 4,  unit: 'PC', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-21005200',
        items: [
            { component: 'EP-31005200', quantity: 2,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31005201', quantity: 4,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31005202', quantity: 4,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31005203', quantity: 2,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31005204', quantity: 2,  unit: 'PC', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-21006000',
        items: [
            { component: 'EP-31006001', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31006002', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31006003', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31006004', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31006005', quantity: 1,  unit: 'EA', itemCategory: 'N' },
            { component: 'EP-31006006', quantity: 2,  unit: 'PC', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-21006100',
        items: [
            { component: 'EP-31006100', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31006101', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31006102', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31006103', quantity: 1,  unit: 'EA', itemCategory: 'N' },
            { component: 'EP-31006104', quantity: 1,  unit: 'PC', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-21007000',
        items: [
            { component: 'EP-31007001', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31007002', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31007003', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31007004', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31007005', quantity: 2,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31007006', quantity: 1,  unit: 'PC', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-21007100',
        items: [
            { component: 'EP-31007100', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31007101', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31007102', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31007103', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31007104', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31007105', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31007106', quantity: 1,  unit: 'EA', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-21007200',
        items: [
            { component: 'EP-31007200', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31007201', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31007202', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31007203', quantity: 1,  unit: 'PC', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-21008000',
        items: [
            { component: 'EP-31008001', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31008002', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31008003', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31008004', quantity: 2,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31008005', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31008006', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31008007', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31008008', quantity: 1,  unit: 'PC', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-21009000',
        items: [
            { component: 'EP-31009001', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31009002', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31009003', quantity: 2,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31009004', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-31009005', quantity: 1,  unit: 'PC', itemCategory: 'N' },
        ]
    },

    // ─── Level 4: EP-31xxx → EP-41xxx ────────────────────────────────────────
    {
        material: 'EP-31001001',
        items: [
            { component: 'EP-41001001', quantity: 180,  unit: 'G',   itemCategory: 'N' },
            { component: 'EP-41001002', quantity: 120,  unit: 'G',   itemCategory: 'N' },
            { component: 'EP-41001003', quantity: 1,    unit: 'PC',  itemCategory: 'N' },
            { component: 'EP-41001004', quantity: 15,   unit: 'ML',  itemCategory: 'N' },
            { component: 'EP-41001005', quantity: 1,    unit: 'PC',  itemCategory: 'N' },
            { component: 'EP-41001006', quantity: 1,    unit: 'PC',  itemCategory: 'N' },
            { component: 'EP-41001007', quantity: 1,    unit: 'PC',  itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-31001002',
        items: [
            { component: 'EP-41001010', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-41001011', quantity: 1,  unit: 'EA', itemCategory: 'N' },
            { component: 'EP-41001012', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-41001013', quantity: 4,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-41001014', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-41001015', quantity: 4,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-41001016', quantity: 1,  unit: 'EA', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-31001003',
        items: [
            { component: 'EP-41001020', quantity: 2.1, unit: 'KG', itemCategory: 'N' },
            { component: 'EP-41001021', quantity: 2,   unit: 'PC', itemCategory: 'N' },
            { component: 'EP-41001022', quantity: 4,   unit: 'PC', itemCategory: 'N' },
            { component: 'EP-41001023', quantity: 1,   unit: 'EA', itemCategory: 'N' },
            { component: 'EP-41001024', quantity: 16,  unit: 'PC', itemCategory: 'N' },
        ]
    },
    {
        material: 'EP-31004001',
        items: [
            { component: 'EP-41004001', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-41004002', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-41004003', quantity: 1,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-41004004', quantity: 2,  unit: 'PC', itemCategory: 'N' },
            { component: 'EP-41004005', quantity: 1,  unit: 'EA', itemCategory: 'N' },
            { component: 'EP-41004006', quantity: 2,  unit: 'PC', itemCategory: 'N' },
        ]
    },
];

// ── S/4HANA BOM POST (OData V2 with CSRF token + cookie) ─────────────────────
async function getCSRFToken(host, auth) {
    return new Promise((resolve, reject) => {
        https.request(
            { hostname: host, port: 443, path: BOM_SRV,
              method: 'GET',
              headers: { Authorization: `Basic ${auth}`, Accept: 'application/json',
                         'x-csrf-token': 'Fetch' } },
            res => {
                res.resume();
                res.on('end', () => {
                    const t = res.headers['x-csrf-token'];
                    const cookies = res.headers['set-cookie'] || [];
                    const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
                    if (!t || t === 'Required') reject(new Error('CSRF fetch failed'));
                    else resolve({ csrfToken: t, sessionCookie: cookieStr });
                });
            }
        ).on('error', reject).end();
    });
}

async function createBOM(host, auth, csrfToken, sessionCookie, material, items) {
    const payload = {
        Material: material,
        Plant: PLANT,
        BillOfMaterialVariantUsage: '1',
        to_BillOfMaterialItem: {
            results: items.map(item => ({
                BillOfMaterialComponent:    item.component,
                BillOfMaterialItemQuantity: String(item.quantity),
                BillOfMaterialItemUnit:     item.unit,
                BillOfMaterialItemCategory: item.itemCategory || 'L',
                IsProductionRelevant:       true
            }))
        }
    };

    const bodyStr = JSON.stringify(payload);
    const extraHeaders = sessionCookie ? { Cookie: sessionCookie } : {};

    return new Promise((resolve) => {
        const req = https.request(
            { hostname: host, port: 443,
              path: BOM_SRV + '/MaterialBOM', method: 'POST',
              headers: { Authorization: `Basic ${auth}`, Accept: 'application/json',
                         'Content-Type': 'application/json',
                         'Content-Length': Buffer.byteLength(bodyStr),
                         'x-csrf-token': csrfToken, ...extraHeaders } },
            res => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    if (res.statusCode >= 400) {
                        resolve({ material, ok: false, code: res.statusCode, msg: data.slice(0, 300) });
                    } else {
                        const parsed = data ? JSON.parse(data) : {};
                        const bomNumber = parsed?.d?.BillOfMaterial || '?';
                        resolve({ material, ok: true, bomNumber, itemCount: items.length });
                    }
                });
            }
        );
        req.on('error', err => resolve({ material, ok: false, msg: err.message }));
        req.end(bodyStr);
    });
}

async function main() {
    if (!process.env.S4_HOST || !process.env.S4_USER || !process.env.S4_PASS) {
        console.error('ERROR: S4_HOST / S4_USER / S4_PASS not set in .env');
        process.exit(1);
    }

    const host = new URL(process.env.S4_HOST).hostname;
    const auth = Buffer.from(`${process.env.S4_USER}:${process.env.S4_PASS}`).toString('base64');

    log(`Starting BOM creation for ${BOMS_TO_CREATE.length} BOMs at plant ${PLANT}`);
    log(`SAP host: ${host}`);

    let ok = 0, fail = 0;
    const failed = [];

    // Process one at a time to avoid CSRF token issues with parallel requests
    for (const bomDef of BOMS_TO_CREATE) {
        const { material, items } = bomDef;
        log(`Creating BOM for ${material} (${items.length} items)...`);

        let csrfToken, sessionCookie;
        try {
            ({ csrfToken, sessionCookie } = await getCSRFToken(host, auth));
        } catch (e) {
            log(`  ERROR: CSRF fetch failed: ${e.message}`);
            failed.push(material);
            fail++;
            continue;
        }

        const result = await createBOM(host, auth, csrfToken, sessionCookie, material, items);

        if (result.ok) {
            log(`  ✓ ${material} → BOM ${result.bomNumber} (${result.itemCount} items)`);
            ok++;
        } else {
            log(`  ✗ ${material} → FAILED (${result.code}): ${result.msg}`);
            failed.push(material);
            fail++;
        }

        // Small delay between requests
        await new Promise(r => setTimeout(r, 300));
    }

    log(`\n=== DONE ===`);
    log(`Success: ${ok}  Failed: ${fail}`);
    if (failed.length > 0) {
        log(`Failed BOMs: ${JSON.stringify(failed)}`);
    }
    log(`\nManual actions required (partial BOMs from earlier tests):`);
    log(`  EP-20001000 (BOM 00002103): Add items EP-21001100(EA), EP-21001200(PC), EP-21001300(EA), EP-21001400(PC), EP-21001500(PC)`);
    log(`  EP-20004000 (BOM 00002106): Add items EP-21004100(PC), EP-21004200(PC), EP-21004300(EA), EP-21004400(PC)`);
    log(`  EP-20005000 (BOM 00002108): Add items EP-21005100(EA), EP-21005200(EA), EP-21005300(PC), EP-21005400(PC), EP-21005500(PC), EP-21005600(EA)`);
}

main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});
