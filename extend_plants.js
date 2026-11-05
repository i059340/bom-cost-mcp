/**
 * extend_plants.js
 * 为 191 个通过 MM/085 回退创建（缺少工厂数据）的物料添加工厂 1710 数据
 * 运行方式: node extend_plants.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../EPK/.env') });
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PRODUCT_SRV = '/sap/opu/odata4/sap/api_product/srvd_a2x/sap/product/0001';
const PLANT = '1710';
const LOG_FILE = path.join(__dirname, 'extend_plants.log');

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    process.stdout.write(line);
    fs.appendFileSync(LOG_FILE, line);
}

// ── 191 materials that need plant extension (MM/085 fallback) ──────────────
const MATERIALS_NEEDING_PLANT = [
    // EP-21xxx (38 materials)
    'EP-21001400','EP-21001500','EP-21002200','EP-21002300','EP-21002400',
    'EP-21003200','EP-21003300','EP-21003400','EP-21004200','EP-21004300',
    'EP-21004400','EP-21005300','EP-21005400','EP-21005500','EP-21005600',
    'EP-21006200','EP-21006300','EP-21006400','EP-21006500','EP-21007300',
    'EP-21007400','EP-21008100','EP-21008200','EP-21008300','EP-21008400',
    'EP-21008500','EP-21009100','EP-21009200','EP-21009300',
    'EP-21010001','EP-21010002','EP-21010003','EP-21010004','EP-21010005',
    'EP-21010006','EP-21010007','EP-21010008','EP-21010009',
    // EP-31xxx (104 materials)
    'EP-31001001','EP-31001002','EP-31001003','EP-31001004','EP-31001005',
    'EP-31001100','EP-31001101','EP-31001102','EP-31001103','EP-31001104',
    'EP-31001105','EP-31001106','EP-31001107',
    'EP-31001200','EP-31001201','EP-31001202','EP-31001203','EP-31001204',
    'EP-31001205','EP-31001206','EP-31001207',
    'EP-31002001','EP-31002002','EP-31002003','EP-31002004','EP-31002005',
    'EP-31002006','EP-31002007','EP-31002008','EP-31002009','EP-31002010',
    'EP-31002011','EP-31002012',
    'EP-31002100','EP-31002101','EP-31002102','EP-31002103','EP-31002104','EP-31002105',
    'EP-31003001','EP-31003002','EP-31003003','EP-31003004','EP-31003005',
    'EP-31003006','EP-31003007','EP-31003008','EP-31003009','EP-31003010','EP-31003011',
    'EP-31003100','EP-31003101','EP-31003102','EP-31003103','EP-31003104',
    'EP-31004001','EP-31004002','EP-31004003','EP-31004004','EP-31004005',
    'EP-31004006','EP-31004007','EP-31004008','EP-31004009',
    'EP-31004100','EP-31004101','EP-31004102','EP-31004103','EP-31004104',
    'EP-31004105','EP-31004106',
    'EP-31005001','EP-31005002','EP-31005003','EP-31005004','EP-31005005',
    'EP-31005006','EP-31005007','EP-31005008','EP-31005009','EP-31005010',
    'EP-31005100','EP-31005101','EP-31005102','EP-31005103','EP-31005104',
    'EP-31005105','EP-31005106',
    'EP-31005200','EP-31005201','EP-31005202','EP-31005203','EP-31005204',
    'EP-31006001','EP-31006002','EP-31006003','EP-31006004','EP-31006005','EP-31006006',
    'EP-31006100','EP-31006101','EP-31006102','EP-31006103','EP-31006104',
    'EP-31007001','EP-31007002','EP-31007003','EP-31007004','EP-31007005','EP-31007006',
    'EP-31007100','EP-31007101','EP-31007102','EP-31007103','EP-31007104',
    'EP-31007105','EP-31007106',
    'EP-31007200','EP-31007201','EP-31007202','EP-31007203',
    'EP-31008001','EP-31008002','EP-31008003','EP-31008004','EP-31008005',
    'EP-31008006','EP-31008007','EP-31008008',
    'EP-31009001','EP-31009002','EP-31009003','EP-31009004','EP-31009005',
    // EP-41xxx (49 materials)
    'EP-41001001','EP-41001002','EP-41001003','EP-41001004','EP-41001005',
    'EP-41001006','EP-41001007',
    'EP-41001010','EP-41001011','EP-41001012','EP-41001013','EP-41001014',
    'EP-41001015','EP-41001016',
    'EP-41001020','EP-41001021','EP-41001022','EP-41001023','EP-41001024',
    'EP-41004001','EP-41004002','EP-41004003','EP-41004004','EP-41004005','EP-41004006',
];

async function getCSRFToken(rawHost, auth) {
    return new Promise((resolve, reject) => {
        https.request(
            { hostname: rawHost, port: 443, path: PRODUCT_SRV + '/',
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

// Helper: raw POST to any V4 path
function postV4(rawHost, auth, csrfToken, sessionCookie, urlPath, body) {
    const bodyStr = JSON.stringify(body);
    const extraHeaders = sessionCookie ? { Cookie: sessionCookie } : {};
    return new Promise((resolve) => {
        const req = https.request(
            { hostname: rawHost, port: 443, path: urlPath, method: 'POST',
              headers: { Authorization: `Basic ${auth}`, Accept: 'application/json',
                         'Content-Type': 'application/json',
                         'Content-Length': Buffer.byteLength(bodyStr),
                         'x-csrf-token': csrfToken, ...extraHeaders } },
            res => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    if (res.statusCode >= 400) {
                        resolve({ ok: false, code: res.statusCode, msg: data.slice(0, 400) });
                    } else {
                        resolve({ ok: true, code: res.statusCode });
                    }
                });
            }
        );
        req.on('error', err => resolve({ ok: false, msg: err.message }));
        req.end(bodyStr);
    });
}

async function addPlantToMaterial(rawHost, auth, csrfToken, sessionCookie, material) {
    // Strategy 1: Navigation property write  POST /Product(Product='EP-...')/_ProductPlant
    const enc = encodeURIComponent(material);
    const navPath = `${PRODUCT_SRV}/Product(Product='${enc}')/_ProductPlant`;
    let r = await postV4(rawHost, auth, csrfToken, sessionCookie, navPath,
        { Plant: PLANT });
    if (r.ok) return { material, ...r };

    // Strategy 2: Same but without named key  /Product('EP-...')/_ProductPlant
    const navPath2 = `${PRODUCT_SRV}/Product('${enc}')/_ProductPlant`;
    r = await postV4(rawHost, auth, csrfToken, sessionCookie, navPath2,
        { Plant: PLANT });
    if (r.ok) return { material, ...r };

    // Strategy 3: Pass both Product+Plant in body
    r = await postV4(rawHost, auth, csrfToken, sessionCookie, navPath,
        { Product: material, Plant: PLANT });
    return { material, ...r, triedAll: true };
}

async function addPlantToMaterialWithGroup(rawHost, auth, csrfToken, sessionCookie, material) {
    const enc = encodeURIComponent(material);
    const navPath = `${PRODUCT_SRV}/Product(Product='${enc}')/_ProductPlant`;
    const r = await postV4(rawHost, auth, csrfToken, sessionCookie, navPath,
        { Plant: PLANT, ProductGroup: 'L001' });
    return { material, ...r };
}

async function main() {
    if (!process.env.S4_HOST || !process.env.S4_USER || !process.env.S4_PASS) {
        console.error('ERROR: S4_HOST / S4_USER / S4_PASS not set in .env');
        process.exit(1);
    }

    let rawHost = process.env.S4_HOST.replace(/https?:\/\//, '').replace(/\/$/, '');
    if (!rawHost.includes('-api.') && rawHost.includes('.s4hana.cloud.sap')) {
        rawHost = rawHost.replace('.s4hana.cloud.sap', '-api.s4hana.cloud.sap');
    }
    const auth = Buffer.from(`${process.env.S4_USER}:${process.env.S4_PASS}`).toString('base64');

    log(`Starting plant extension for ${MATERIALS_NEEDING_PLANT.length} materials → plant ${PLANT}`);
    log(`SAP host: ${rawHost}`);

    // Process in batches of 10 to avoid overwhelming the API
    const BATCH_SIZE = 10;
    let ok = 0, fail = 0, skip = 0;
    const failed = [];

    for (let i = 0; i < MATERIALS_NEEDING_PLANT.length; i += BATCH_SIZE) {
        const batch = MATERIALS_NEEDING_PLANT.slice(i, i + BATCH_SIZE);
        
        // Fetch a fresh CSRF token for each batch
        let csrfToken, sessionCookie;
        try {
            ({ csrfToken, sessionCookie } = await getCSRFToken(rawHost, auth));
        } catch (e) {
            log(`ERROR: CSRF fetch failed for batch ${i/BATCH_SIZE + 1}: ${e.message}`);
            batch.forEach(m => failed.push(m));
            fail += batch.length;
            continue;
        }

        // Process batch in parallel
        const results = await Promise.all(
            batch.map(m => addPlantToMaterial(rawHost, auth, csrfToken, sessionCookie, m))
        );

        for (const r of results) {
            if (r.ok) {
                log(`  ✓ ${r.material} → plant ${PLANT} added (HTTP ${r.code})`);
                ok++;
            } else if (r.msg && (r.msg.includes('already') || r.msg.includes('009') || r.msg.includes('duplicate'))) {
                log(`  ~ ${r.material} → already has plant data (skipped)`);
                skip++;
            } else if (r.msg && (r.msg.includes('MM/085') || r.msg.includes('material group'))) {
                // ROH materials need a ProductGroup — retry with a default group
                log(`  ↳ MM/085 on ${r.material} — retrying with ProductGroup 'L001'`);
                const { csrfToken: t2, sessionCookie: s2 } = await getCSRFToken(rawHost, auth).catch(() => ({ csrfToken, sessionCookie }));
                const retry = await addPlantToMaterialWithGroup(rawHost, auth, t2 || csrfToken, s2 || sessionCookie, r.material);
                if (retry.ok) {
                    log(`  ✓ ${r.material} → plant ${PLANT} added with ProductGroup (HTTP ${retry.code})`);
                    ok++;
                } else {
                    log(`  ✗ ${r.material} → still failed: ${retry.msg}`);
                    failed.push(r.material);
                    fail++;
                }
            } else {
                log(`  ✗ ${r.material} → FAILED (${r.code}): ${r.msg}`);
                failed.push(r.material);
                fail++;
            }
        }

        log(`Progress: ${Math.min(i + BATCH_SIZE, MATERIALS_NEEDING_PLANT.length)}/${MATERIALS_NEEDING_PLANT.length}  ok=${ok}  skip=${skip}  fail=${fail}`);
        
        // Small delay between batches
        await new Promise(r => setTimeout(r, 500));
    }

    log(`\n=== DONE ===`);
    log(`Success: ${ok}  Already had plant: ${skip}  Failed: ${fail}`);
    if (failed.length > 0) {
        log(`Failed materials: ${JSON.stringify(failed)}`);
    }
    log(`Log saved to: ${LOG_FILE}`);
}

main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});
