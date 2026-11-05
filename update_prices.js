/**
 * update_prices.js
 * Batch-updates ProductValuation.StandardPrice in S/4HANA Cloud
 * for all materials in price_reference.json (CBD15-Li BOM).
 *
 * Usage:
 *   node update_prices.js [--dry-run] [--plant 1710] [--delay 200]
 *
 * Options:
 *   --dry-run   Print what would be sent, but make no actual API calls
 *   --plant     Plant / valuation area (default: 1710)
 *   --delay     ms between each PATCH request (default: 300)
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const https   = require('https');
const path    = require('path');
const fs      = require('fs');

const PRICES    = require('./price_reference.json');
const PLANT     = process.argv.includes('--plant')
    ? process.argv[process.argv.indexOf('--plant') + 1]
    : '1710';
const DRY_RUN   = process.argv.includes('--dry-run');
const DELAY_MS  = process.argv.includes('--delay')
    ? parseInt(process.argv[process.argv.indexOf('--delay') + 1], 10)
    : 300;

const PRODUCT_SRV = '/sap/opu/odata4/sap/api_product/srvd_a2x/sap/product/0001';

// ── helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    fs.appendFileSync(path.join(__dirname, 'update_prices.log'), line + '\n');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getRawHost() {
    let h = (process.env.S4_HOST || '').replace(/https?:\/\//, '').replace(/\/$/, '');
    if (!h.includes('-api.') && h.includes('.s4hana.cloud.sap'))
        h = h.replace('.s4hana.cloud.sap', '-api.s4hana.cloud.sap');
    return h;
}

// ── CSRF fetch ────────────────────────────────────────────────────────────────

function fetchCsrf(hostname, auth) {
    return new Promise((resolve, reject) => {
        https.request(
            { hostname, port: 443, path: PRODUCT_SRV + '/', method: 'GET',
              headers: { Authorization: `Basic ${auth}`, Accept: 'application/json',
                         'x-csrf-token': 'Fetch' } },
            res => {
                res.resume();
                res.on('end', () => {
                    const t = res.headers['x-csrf-token'];
                    const cookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
                    if (!t || t === 'Required') reject(new Error('CSRF fetch failed'));
                    else resolve({ csrfToken: t, sessionCookie: cookies });
                });
            }
        ).on('error', reject).end();
    });
}

// ── PATCH single material ─────────────────────────────────────────────────────

function patchValuation(hostname, auth, csrfToken, sessionCookie, material, price) {
    const encodedMat = encodeURIComponent(material);
    const urlPath    = `${PRODUCT_SRV}/ProductValuation(Product='${encodedMat}',ValuationArea='${PLANT}',ValuationType='')`;
    const body       = JSON.stringify({ StandardPrice: price.toFixed(2), PriceUnit: '1', Currency: 'CNY' });

    return new Promise((resolve, reject) => {
        const req = https.request(
            { hostname, port: 443, path: urlPath, method: 'PATCH',
              headers: {
                  Authorization: `Basic ${auth}`,
                  Accept: 'application/json',
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(body),
                  'x-csrf-token': csrfToken,
                  'If-Match': '*',
                  ...(sessionCookie ? { Cookie: sessionCookie } : {})
              } },
            res => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => resolve({ status: res.statusCode, body: data }));
            }
        );
        req.on('error', reject);
        req.end(body);
    });
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
    if (!process.env.S4_HOST || !process.env.S4_USER || !process.env.S4_PASS) {
        console.error('ERROR: S4_HOST, S4_USER, S4_PASS must be set in .env');
        process.exit(1);
    }

    const auth     = Buffer.from(`${process.env.S4_USER}:${process.env.S4_PASS}`).toString('base64');
    const hostname = getRawHost();

    // Filter out metadata keys and zero-price items
    const materials = Object.entries(PRICES)
        .filter(([k, v]) => !k.startsWith('_') && typeof v === 'number' && v > 0)
        .sort(([a], [b]) => a.localeCompare(b));

    log(`=== update_prices.js  plant=${PLANT}  materials=${materials.length}  dry-run=${DRY_RUN} ===`);

    if (DRY_RUN) {
        console.log('\n-- DRY RUN -- (no API calls)\n');
        materials.forEach(([mat, price]) =>
            console.log(`  PATCH ProductValuation  ${mat.padEnd(14)}  StandardPrice=${price}  plant=${PLANT}`));
        console.log(`\nTotal: ${materials.length} materials`);
        return;
    }

    log('Fetching CSRF token...');
    let csrfToken, sessionCookie;
    try {
        ({ csrfToken, sessionCookie } = await fetchCsrf(hostname, auth));
        log(`CSRF token obtained: ${csrfToken.slice(0, 8)}...`);
    } catch (e) {
        log(`FATAL: CSRF fetch failed — ${e.message}`);
        process.exit(1);
    }

    let ok = 0, fail = 0, skip = 0;
    const errors = [];

    for (const [material, price] of materials) {
        try {
            const { status, body } = await patchValuation(
                hostname, auth, csrfToken, sessionCookie, material, price);

            if (status === 204 || status === 200) {
                log(`OK    ${material}  → ${price} CNY  (HTTP ${status})`);
                ok++;
            } else if (status === 401 || status === 403) {
                // CSRF expired — refresh once then retry
                log(`CSRF expired (${status}) — refreshing token...`);
                try {
                    ({ csrfToken, sessionCookie } = await fetchCsrf(hostname, auth));
                    const retry = await patchValuation(
                        hostname, auth, csrfToken, sessionCookie, material, price);
                    if (retry.status === 204 || retry.status === 200) {
                        log(`OK    ${material}  → ${price} CNY  (retry HTTP ${retry.status})`);
                        ok++;
                    } else {
                        log(`FAIL  ${material}  HTTP ${retry.status}  ${retry.body.slice(0, 200)}`);
                        errors.push({ material, status: retry.status, body: retry.body.slice(0, 200) });
                        fail++;
                    }
                } catch (e2) {
                    log(`FAIL  ${material}  retry error: ${e2.message}`);
                    errors.push({ material, error: e2.message });
                    fail++;
                }
            } else if (status === 404) {
                log(`SKIP  ${material}  not found in S/4HANA (HTTP 404)`);
                skip++;
            } else {
                log(`FAIL  ${material}  HTTP ${status}  ${body.slice(0, 200)}`);
                errors.push({ material, status, body: body.slice(0, 200) });
                fail++;
            }
        } catch (e) {
            log(`FAIL  ${material}  ${e.message}`);
            errors.push({ material, error: e.message });
            fail++;
        }

        await sleep(DELAY_MS);
    }

    log(`=== DONE  ok=${ok}  fail=${fail}  skip=${skip} ===`);

    if (errors.length > 0) {
        const errFile = path.join(__dirname, 'update_prices_errors.json');
        fs.writeFileSync(errFile, JSON.stringify(errors, null, 2));
        log(`Error details → ${errFile}`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
