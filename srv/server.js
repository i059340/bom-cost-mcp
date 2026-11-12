require('dotenv').config({ path: require('path').join(__dirname, '../.env') });


const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { z }   = require('zod');
const https   = require('https');

const LOG_FILE = path.join(__dirname, '..', 'debug.log');
function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    process.stdout.write(line);
    try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
}

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Mcp-Session-Id');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Request logger
app.use((req, res, next) => {
    log(`${req.method} ${req.url}`);
    if (req.body && Object.keys(req.body).length > 0)
        log(`  body: ${JSON.stringify(req.body).slice(0, 300)}`);
    res.on('finish', () => log(`  → ${res.statusCode}`));
    next();
});

// ── S/4HANA call ─────────────────────────────────────────────────────────────
async function s4Get(urlPath) {
    if (process.env.S4_HOST && process.env.S4_USER && process.env.S4_PASS) {
        return new Promise((resolve, reject) => {
            const auth = Buffer.from(`${process.env.S4_USER}:${process.env.S4_PASS}`).toString('base64');
            const host = new URL(process.env.S4_HOST);
            https.request(
                { hostname: host.hostname, port: 443, path: urlPath, method: 'GET',
                  headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } },
                res => {
                    let data = '';
                    res.on('data', c => data += c);
                    res.on('end', () => {
                        if (res.statusCode !== 200)
                            reject(new Error(`S/4HANA ${res.statusCode}: ${data.slice(0, 200)}`));
                        else resolve(JSON.parse(data));
                    });
                }
            ).on('error', reject).end();
        });
    }
    const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
    const { getDestination }     = require('@sap-cloud-sdk/connectivity');
    const dest = await getDestination({ destinationName: process.env.DEST_NAME || 'S4HANA_COST_OPT' });
    const resp = await executeHttpRequest(dest, { method: 'GET', url: urlPath });
    return resp.data;
}

const BOM_SRV     = '/sap/opu/odata/sap/API_BILL_OF_MATERIAL_SRV;v=0002';
const PRODUCT_SRV = '/sap/opu/odata4/sap/api_product/srvd_a2x/sap/product/0002';
const CHG_SRV     = '/sap/opu/odata/sap/API_CHANGE_RECORD';

// ── S/4HANA POST V4 (OData V4, for Product API) ──────────────────────────────
async function s4PostV4(urlPath, body) {
    if (process.env.S4_HOST && process.env.S4_USER && process.env.S4_PASS) {
        const auth = Buffer.from(`${process.env.S4_USER}:${process.env.S4_PASS}`).toString('base64');
        // Auto-correct: use -api subdomain for API calls
        let rawHost = process.env.S4_HOST.replace(/https?:\/\//, '').replace(/\/$/, '');
        if (!rawHost.includes('-api.') && rawHost.includes('.s4hana.cloud.sap')) {
            rawHost = rawHost.replace('.s4hana.cloud.sap', '-api.s4hana.cloud.sap');
        }

        // Step 1: fetch CSRF token from V4 service root — capture session cookie
        const { csrfToken, sessionCookie } = await new Promise((resolve, reject) => {
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
                        if (!t || t === 'Required') reject(new Error('CSRF V4 token fetch failed'));
                        else resolve({ csrfToken: t, sessionCookie: cookieStr });
                    });
                }
            ).on('error', reject).end();
        });

        // Step 2: POST with CSRF token + session cookie
        return new Promise((resolve, reject) => {
            const bodyStr = JSON.stringify(body);
            const extraHeaders = sessionCookie ? { Cookie: sessionCookie } : {};
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
                        if (res.statusCode >= 400)
                            reject(new Error(`S/4HANA V4 POST ${res.statusCode}: ${data.slice(0, 400)}`));
                        else resolve(data ? JSON.parse(data) : { statusCode: res.statusCode });
                    });
                }
            );
            req.on('error', reject);
            req.end(bodyStr);
        });
    }
    throw new Error('S4_HOST / S4_USER / S4_PASS not set in environment');
}

// ── S/4HANA POST (with CSRF token) ───────────────────────────────────────────
async function s4Post(urlPath, body) {
    if (process.env.S4_HOST && process.env.S4_USER && process.env.S4_PASS) {
        const auth = Buffer.from(`${process.env.S4_USER}:${process.env.S4_PASS}`).toString('base64');
        const host = new URL(process.env.S4_HOST);

        // Step 1: fetch CSRF token + capture session cookie
        const { csrfToken, sessionCookie } = await new Promise((resolve, reject) => {
            https.request(
                { hostname: host.hostname, port: 443, path: BOM_SRV,
                  method: 'GET',
                  headers: { Authorization: `Basic ${auth}`, Accept: 'application/json',
                             'x-csrf-token': 'Fetch' } },
                res => {
                    res.resume();
                    res.on('end', () => {
                        const t = res.headers['x-csrf-token'];
                        const cookies = res.headers['set-cookie'] || [];
                        const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
                        if (!t || t === 'Required') reject(new Error('CSRF token fetch failed'));
                        else resolve({ csrfToken: t, sessionCookie: cookieStr });
                    });
                }
            ).on('error', reject).end();
        });

        // Step 2: POST with CSRF token + session cookie
        return new Promise((resolve, reject) => {
            const bodyStr = JSON.stringify(body);
            const extraHeaders = sessionCookie ? { Cookie: sessionCookie } : {};
            const req = https.request(
                { hostname: host.hostname, port: 443, path: urlPath, method: 'POST',
                  headers: { Authorization: `Basic ${auth}`, Accept: 'application/json',
                             'Content-Type': 'application/json',
                             'Content-Length': Buffer.byteLength(bodyStr),
                             'x-csrf-token': csrfToken, ...extraHeaders } },
                res => {
                    let data = '';
                    res.on('data', c => data += c);
                    res.on('end', () => {
                        if (res.statusCode >= 400)
                            reject(new Error(`S/4HANA POST ${res.statusCode}: ${data.slice(0, 300)}`));
                        else resolve(data ? JSON.parse(data) : { statusCode: res.statusCode });
                    });
                }
            );
            req.on('error', reject);
            req.end(bodyStr);
        });
    }
    const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
    const { getDestination }     = require('@sap-cloud-sdk/connectivity');
    const dest = await getDestination({ destinationName: process.env.DEST_NAME || 'S4HANA_COST_OPT' });
    const resp = await executeHttpRequest(dest, { method: 'POST', url: urlPath, data: body });
    return resp.data;
}

async function fetchBomItems(material, plant) {
    const enc = s => encodeURIComponent(s);
    // Step 1: get BOM header (V2 OData returns d.results, not value)
    const p = `${BOM_SRV}/MaterialBOM`
            + `?$filter=Material%20eq%20%27${enc(material)}%27%20and%20Plant%20eq%20%27${enc(plant)}%27`
            + `&$format=json&$top=1&sap-language=ZH`;
    const data = await s4Get(p);
    const hdr = (data?.d?.results || data?.value || [])[0];
    if (!hdr) return null;
    // Step 2: fetch items via navigation (expand returns __deferred in V2)
    const key = `BillOfMaterial='${hdr.BillOfMaterial}',BillOfMaterialCategory='${hdr.BillOfMaterialCategory}',BillOfMaterialVariant='${hdr.BillOfMaterialVariant}',BillOfMaterialVersion='${hdr.BillOfMaterialVersion}',EngineeringChangeDocument='${hdr.EngineeringChangeDocument}',Material='${enc(material)}',Plant='${enc(plant)}'`;
    const itemsData = await s4Get(`${BOM_SRV}/MaterialBOM(${key})/to_BillOfMaterialItem?$format=json&sap-language=ZH`);
    return itemsData?.d?.results || itemsData?.value || [];
}


// ── MCP tool definitions ──────────────────────────────────────────────────────
const TOOLS = [
    {
        name: 'get_bom',
        description: 'Fetch bill of materials (BOM) for a material/plant from S/4HANA. Returns all components with quantities and units.',
        inputSchema: {
            type: 'object',
            properties: {
                material: { type: 'string', description: 'Material number, e.g. EB-A9A8000' },
                plant:    { type: 'string', description: 'Plant code, e.g. 1710' }
            },
            required: ['material', 'plant']
        }
    },
    {
        name: 'analyze_cost_space',
        description: 'Analyze cost reduction opportunities for a product BOM. Returns sub-assembly count, direct component count, and actionable optimization areas.',
        inputSchema: {
            type: 'object',
            properties: {
                material: { type: 'string', description: 'Top-level material number, e.g. EB-A9A8000' },
                plant:    { type: 'string', description: 'Plant code, e.g. 1710' }
            },
            required: ['material', 'plant']
        }
    },
    {
        name: 'get_bom_cost_breakdown',
        description: 'ONE-CALL complete BOM cost breakdown: fetches L1+L2 BOM structure AND standard prices for all components in parallel. Use THIS instead of calling query_api repeatedly. Returns top-5 cost drivers, cost share %, and full breakdown. Input: material + plant.',
        inputSchema: {
            type: 'object',
            properties: {
                material: { type: 'string', description: 'Top-level material number, e.g. EB-A9A8000' },
                plant:    { type: 'string', description: 'Plant code, e.g. 1710' }
            },
            required: ['material', 'plant']
        }
    },
    {
        name: 'get_material_bom_items',
        description: 'Get detailed BOM item list with scrap percentages and backflush settings for cost review.',
        inputSchema: {
            type: 'object',
            properties: {
                material: { type: 'string', description: 'Material number' },
                plant:    { type: 'string', description: 'Plant code' }
            },
            required: ['material', 'plant']
        }
    },
    {
        name: 'create_material',
        description: 'Create a new material master record in S/4HANA Cloud using the OData V4 Product API. Creates basic data + plant data in one call.',
        inputSchema: {
            type: 'object',
            properties: {
                material:     { type: 'string', description: 'Material number, e.g. EP-10000001' },
                description:  { type: 'string', description: 'Material description (language ZH or EN)' },
                materialType: { type: 'string', description: 'Material type: FERT=Finished, HALB=Semi-finished, ROH=Raw material' },
                baseUnit:     { type: 'string', description: 'Base unit of measure, e.g. PC, KG, SET' },
                plant:        { type: 'string', description: 'Plant code, e.g. 1710' },
                industrySector: { type: 'string', description: 'Industry sector: M=Mechanical (default)' }
            },
            required: ['material', 'description', 'materialType', 'baseUnit', 'plant']
        }
    },
    {
        name: 'query_api',
        description: 'Diagnostic GET query to any S/4HANA OData path. Returns raw JSON (max 20 records). DO NOT call repeatedly in a loop — use $filter and $select to get targeted data in ONE call. Pagination is disabled.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'OData URL path, e.g. /sap/opu/odata4/.../ProductGroup?$top=5' }
            },
            required: ['path']
        }
    },
    {
        name: 'add_plant_to_material',
        description: 'Extend an existing material to a plant in S/4HANA Cloud by posting to the _ProductPlant navigation property. Use this for materials that were created without plant data (MM/085 fallback).',
        inputSchema: {
            type: 'object',
            properties: {
                material: { type: 'string', description: 'Material number to extend, e.g. EP-21001400' },
                plant:    { type: 'string', description: 'Plant code to extend to, e.g. 1710' }
            },
            required: ['material', 'plant']
        }
    },
    {
        name: 'create_bom',
        description: 'Create a new Bill of Materials (BOM) in S/4HANA Cloud for a given material and plant with a list of components.',
        inputSchema: {
            type: 'object',
            properties: {
                material: { type: 'string', description: 'Header material number, e.g. EB-A9A8000' },
                plant:    { type: 'string', description: 'Plant code, e.g. 1710' },
                usage:    { type: 'string', description: 'BOM usage: 1=Production (default), 5=Sales, 6=Costing' },
                items: {
                    type: 'array',
                    description: 'List of BOM components',
                    items: {
                        type: 'object',
                        properties: {
                            component:    { type: 'string', description: 'Component material number' },
                            quantity:     { type: 'number', description: 'Component quantity' },
                            unit:         { type: 'string', description: 'Unit of measure, e.g. EA, KG, PC' },
                            itemCategory: { type: 'string', description: 'Item category: L=Stock item (default), N=Non-stock, T=Text' }
                        },
                        required: ['component', 'quantity', 'unit']
                    }
                }
            },
            required: ['material', 'plant', 'items']
        }
    },
    {
        name: 'create_eco',
        description: 'Create an Engineering Change Order (ECO / 工程变更单) in S/4HANA Cloud using API_CHANGE_RECORD. Optionally links affected materials and BOMs to the change record.',
        inputSchema: {
            type: 'object',
            properties: {
                title: {
                    type: 'string',
                    description: 'Change record title / description (max 40 chars), e.g. "M2 电控集成降本 EP-10000001"'
                },
                changeType: {
                    type: 'string',
                    description: 'Change record type code, e.g. S03 (default). Corresponds to ECO type configured in S/4HANA.'
                },
                materials: {
                    type: 'array',
                    description: 'Optional list of affected material numbers to link to the change record.',
                    items: { type: 'string', description: 'Material number, e.g. EP-10000001' }
                },
                boms: {
                    type: 'array',
                    description: 'Optional list of affected BOMs to link to the change record.',
                    items: {
                        type: 'object',
                        properties: {
                            material: { type: 'string', description: 'BOM header material number' },
                            plant:    { type: 'string', description: 'Plant code, e.g. 1710' },
                            usage:    { type: 'string', description: 'BOM usage, default 1 (Production)' },
                            variant:  { type: 'string', description: 'BOM alternative/variant number, default 1' }
                        },
                        required: ['material', 'plant']
                    }
                },
                relevance: {
                    type: 'string',
                    description: 'ChangeRecordItemRelevance for material/BOM links. Valid values: S01=更改(default), S02=创建, S03=更改触发器(BOM only), S05=新版本(BOM only).'
                },
                personResponsible: {
                    type: 'string',
                    description: 'SAP user ID of the person responsible, e.g. \"LEVY.LI\". Assign this so the record is visible in CC02 for that user.'
                }
            },
            required: ['title']
        }
    }
];

// ── Tool execution ────────────────────────────────────────────────────────────
async function callTool(name, args) {
    const { material, plant } = args;

    if (name === 'get_bom') {
        const items = await fetchBomItems(material, plant);
        if (!items) return [{ type: 'text', text: `No BOM found for ${material} / ${plant}` }];
        const rows = items.map((i, idx) => ({
            seq:         idx + 1,
            component:   i.BillOfMaterialComponent,
            description: i.ComponentDescription || '',
            quantity:    parseFloat(i.BillOfMaterialItemQuantity || 1),
            unit:        i.BillOfMaterialUnit,
            isAssembly:  i.IsAssembly === 'X'
        }));
        return [{ type: 'text', text: JSON.stringify({ material, plant, itemCount: rows.length, items: rows }, null, 2) }];
    }

    if (name === 'analyze_cost_space') {
        const items = await fetchBomItems(material, plant);
        if (!items) return [{ type: 'text', text: `No BOM data found for ${material} / ${plant}` }];
        const assemblies = items.filter(i => i.IsAssembly === 'X');
        const components = items.filter(i => i.IsAssembly !== 'X');
        const subResults = await Promise.allSettled(
            assemblies.map(async a => {
                const sub = await fetchBomItems(a.BillOfMaterialComponent, plant);
                return { parent: a.BillOfMaterialComponent, desc: a.ComponentDescription, items: sub || [] };
            })
        );
        const subs    = subResults.filter(r => r.status === 'fulfilled').map(r => r.value);
        const totalL2 = subs.reduce((s, sa) => s + sa.items.length, 0);
        const areas   = [];
        if (assemblies.length > 0)
            areas.push(`${assemblies.length} sub-assembly(ies) — evaluate modular consolidation or make-vs-buy`);
        if (components.length > 5)
            areas.push(`${components.length} direct components — standardization / common parts opportunities`);
        subs.forEach(sa => {
            if (sa.items.length > 4)
                areas.push(`Sub-assembly ${sa.parent} (${sa.desc}) has ${sa.items.length} parts — possible simplification`);
        });
        if (areas.length === 0) areas.push('BOM structure looks lean — consider material price benchmarking');
        return [{
            type: 'text',
            text: JSON.stringify({
                material, plant,
                summary: { totalL1Items: items.length, subAssemblies: assemblies.length, directComponents: components.length, totalL2Items: totalL2 },
                optimizationAreas: areas,
                subAssemblyDetail: subs.map(sa => ({ component: sa.parent, description: sa.desc, itemCount: sa.items.length }))
            }, null, 2)
        }];
    }

    if (name === 'get_bom_cost_breakdown') {
        // Step 1: fetch L1 BOM
        const l1Items = await fetchBomItems(material, plant);
        if (!l1Items) return [{ type: 'text', text: `No BOM found for ${material} / ${plant}` }];

        // Step 2: fetch all L2 BOMs in parallel
        const assemblies = l1Items.filter(i => i.IsAssembly === 'X');
        const l2Results = await Promise.allSettled(
            assemblies.map(a =>
                fetchBomItems(a.BillOfMaterialComponent, plant)
                    .then(sub => ({ parent: a.BillOfMaterialComponent,
                                    parentDesc: a.ComponentDescription,
                                    items: sub || [] }))
            )
        );

        // Step 3: collect all unique components with level info
        const allComps = new Map();
        const addComp = (i, level, parentMat) => {
            const key = i.BillOfMaterialComponent;
            if (!allComps.has(key)) {
                allComps.set(key, {
                    material:    key,
                    description: i.ComponentDescription,
                    level,
                    parent:      parentMat || material,
                    isAssembly:  i.IsAssembly === 'X',
                    quantity:    parseFloat(i.BillOfMaterialItemQuantity || 1),
                    unit:        i.BillOfMaterialUnit,
                    standardPrice: null, currency: null, lineItemCost: null
                });
            }
        };
        l1Items.forEach(i => addComp(i, 1, material));
        l2Results.forEach(r => {
            if (r.status === 'fulfilled')
                r.value.items.forEach(i => addComp(i, 2, r.value.parent));
        });

        // Step 4: fetch standard prices — 3-level fallback per component
        // Level 1: CO-PC (ProductPlantCosting.StandardCost)
        // Level 2: MM Valuation (ProductValuation.StandardPrice)
        // Level 3: Local reference JSON from PDF import
        await Promise.allSettled(
            Array.from(allComps.keys()).map(async comp => {
                const entry = allComps.get(comp);
                // L1: MM valuation standard price (ProductValuation.StandardPrice, API /0002)
                // OData V4 requires URL-encoded filter — spaces → %20, single quotes → %27
                // Price priority: L1 StandardPrice → L2 MovingAveragePrice (定期单价) → null
                try {
                    const enc = encodeURIComponent;
                    const p2 = `${PRODUCT_SRV}/ProductValuation?$filter=Product%20eq%20%27${enc(comp)}%27%20and%20ValuationArea%20eq%20%27${enc(plant)}%27&$select=Product,ValuationArea,StandardPrice,MovingAveragePrice,Currency&$top=1`;
                    const d2 = await s4Get(p2);
                    const r2 = d2?.value?.[0];
                    if (r2 && parseFloat(r2.StandardPrice) > 0) {
                        // L1: standard price
                        entry.standardPrice = parseFloat(r2.StandardPrice);
                        entry.currency      = r2.Currency || 'CNY';
                        entry.lineItemCost  = entry.standardPrice * entry.quantity;
                        entry.priceSource   = 'MM-VAL';
                        return;
                    }
                    if (r2 && parseFloat(r2.MovingAveragePrice) > 0) {
                        // L2: periodic unit price (定期单价 / 移动平均价)
                        entry.standardPrice = parseFloat(r2.MovingAveragePrice);
                        entry.currency      = r2.Currency || 'CNY';
                        entry.lineItemCost  = entry.standardPrice * entry.quantity;
                        entry.priceSource   = 'MAP';
                        return;
                    }
                } catch (_) {}
                // No S/4HANA price found — lineItemCost stays null, reported as 无价格数据
            })
        );

        // Step 5: build result
        // totalCost = L1 direct children only (no double-counting with L2)
        const all        = Array.from(allComps.values());
        const withPrice  = all.filter(c => c.lineItemCost !== null);
        const l1Only     = withPrice.filter(c => c.level === 1);
        const totalCost  = l1Only.reduce((s, c) => s + c.lineItemCost, 0);
        const top5       = [...withPrice].sort((a, b) => b.lineItemCost - a.lineItemCost).slice(0, 5);
        const currency   = withPrice[0]?.currency || 'N/A';

        const result = {
            material, plant,
            summary: {
                totalComponents: all.length,
                l1Components: l1Items.length,
                l2Components: all.filter(c => c.level === 2).length,
                componentsWithPrice: withPrice.length,
                estimatedTotalCost: totalCost.toFixed(2),
                currency
            },
            top5CostDrivers: top5.map(c => ({
                material:     c.material,
                description:  c.description,
                level:        `L${c.level}`,
                quantity:     c.quantity,
                unit:         c.unit,
                standardPrice: c.standardPrice?.toFixed(2),
                lineItemCost: c.lineItemCost?.toFixed(2),
                costShare:    totalCost > 0 ? `${(c.lineItemCost / totalCost * 100).toFixed(1)}%` : 'N/A'
            })),
            fullBreakdown: all.map(c => ({
                material:     c.material,
                description:  c.description,
                level:        `L${c.level}`,
                parent:       c.parent,
                quantity:     c.quantity,
                unit:         c.unit,
                standardPrice: c.standardPrice?.toFixed(2) || null,
                lineItemCost: c.lineItemCost?.toFixed(2) || null,
                costShare:    (totalCost > 0 && c.lineItemCost)
                              ? `${(c.lineItemCost / totalCost * 100).toFixed(1)}%` : null,
                priceSource:  c.priceSource || null
            }))
        };
        return [{ type: 'text', text: JSON.stringify(result, null, 2).slice(0, 10000) }];
    }

    if (name === 'get_material_bom_items') {
        const items = await fetchBomItems(material, plant);
        if (!items) return [{ type: 'text', text: 'No items found' }];
        const detail = items.map(i => ({
            component:    i.BillOfMaterialComponent,
            description:  i.ComponentDescription || '',
            quantity:     i.BillOfMaterialItemQuantity,
            unit:         i.BillOfMaterialUnit,
            isAssembly:   i.IsAssembly === 'X',
            scrapPct:     i.ComponentScrapInPercent,
            backflush:    i.MatlCompIsMarkedForBackflush,
            itemCategory: i.BillOfMaterialItemCategory
        }));
        return [{ type: 'text', text: JSON.stringify(detail, null, 2) }];
    }

    if (name === 'query_api') {
        // Generic GET for diagnostics — hard cap prevents AI pagination loops
        let { path: apiPath } = args;
        if (!apiPath) throw new Error('path is required');
        // Inject $top=20 if no $top present, to prevent runaway pagination
        if (!apiPath.includes('$top=')) {
            apiPath += (apiPath.includes('?') ? '&' : '?') + '$top=20';
        }
        log(`query_api  path="${apiPath}"`);
        const result = await s4Get(apiPath);
        // Remove nextLink to stop AI from following pagination chains
        if (result && typeof result === 'object') {
            delete result['@odata.nextLink'];
            if (result.value && Array.isArray(result.value)) {
                result['_note'] = `Showing up to 20 records. Use $filter or $select to narrow results.`;
            }
        }
        return [{ type: 'text', text: JSON.stringify(result, null, 2).slice(0, 8000) }];
    }

    if (name === 'add_plant_to_material') {
        if (!material || !plant)
            throw new Error('material and plant are required');

        const auth = Buffer.from(`${process.env.S4_USER}:${process.env.S4_PASS}`).toString('base64');
        let rawHost = process.env.S4_HOST.replace(/https?:\/\//, '').replace(/\/$/, '');
        if (!rawHost.includes('-api.') && rawHost.includes('.s4hana.cloud.sap')) {
            rawHost = rawHost.replace('.s4hana.cloud.sap', '-api.s4hana.cloud.sap');
        }

        // Step 1: fetch CSRF token
        const { csrfToken, sessionCookie } = await new Promise((resolve, reject) => {
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
                        if (!t || t === 'Required') reject(new Error('CSRF token fetch failed'));
                        else resolve({ csrfToken: t, sessionCookie: cookieStr });
                    });
                }
            ).on('error', reject).end();
        });

        // Step 2: POST to _ProductPlant navigation property (correct key name = Product)
        const plantPayload = JSON.stringify({ Plant: plant });
        const plantPath = `${PRODUCT_SRV}/Product(Product='${encodeURIComponent(material)}')/_ProductPlant`;
        log(`add_plant_to_material  material="${material}"  plant="${plant}"  path="${plantPath}"`);

        const result = await new Promise((resolve, reject) => {
            const extraHeaders = sessionCookie ? { Cookie: sessionCookie } : {};
            const req = https.request(
                { hostname: rawHost, port: 443, path: plantPath, method: 'POST',
                  headers: { Authorization: `Basic ${auth}`, Accept: 'application/json',
                             'Content-Type': 'application/json',
                             'Content-Length': Buffer.byteLength(plantPayload),
                             'x-csrf-token': csrfToken, ...extraHeaders } },
                res => {
                    let data = '';
                    res.on('data', c => data += c);
                    res.on('end', () => {
                        if (res.statusCode >= 400)
                            reject(new Error(`S/4HANA V4 POST ${res.statusCode}: ${data.slice(0, 300)}`));
                        else resolve({ statusCode: res.statusCode, body: data });
                    });
                }
            );
            req.on('error', reject);
            req.end(plantPayload);
        });

        return [{ type: 'text', text: JSON.stringify({
            success: true,
            message: `Plant ${plant} added to material ${material} via navigation property POST`,
            statusCode: result.statusCode
        }, null, 2) }];
    }

    if (name === 'create_material') {
        const { description, materialType, baseUnit, industrySector } = args;
        if (!material || !description || !materialType || !baseUnit || !plant)
            throw new Error('material, description, materialType, baseUnit, plant are all required');

        // Map non-standard units to SAP-configured equivalents
        const unitMap = { 'SET': 'EA', 'set': 'EA', 'ML': 'ML', 'G': 'G', 'KG': 'KG' };
        const safeUnit = unitMap[baseUnit] || baseUnit;

        // OData V4 deep insert — Product + _ProductDescription + _ProductPlant in one call
        // For ROH materials: _ProductPlant triggers purchasing view which requires ProductGroup
        // We conditionally include plant data and add ProductGroup for ROH
        const isROH = materialType === 'ROH';
        const productPayload = {
            Product:          material,
            ProductType:      materialType,
            BaseUnit:         safeUnit,
            IndustrySector:   industrySector || 'M',
            _ProductDescription: [
                { Product: material, Language: 'ZH', ProductDescription: description }
            ],
            _ProductPlant: [
                { Product: material, Plant: plant }
            ]
        };
        log(`create_material  material="${material}"  type=${materialType}  plant=${plant}`);
        let result;
        try {
            result = await s4PostV4(`${PRODUCT_SRV}/Product`, productPayload);
        } catch (e) {
            // MM/085: material group required for ROH purchasing data
            // Retry without _ProductPlant — plant view can be added later
            if (e.message.includes('MM/085') || e.message.includes('material group')) {
                log(`  ↳ MM/085 on ${material} — retrying without _ProductPlant`);
                const { _ProductPlant, ...payloadNoPlant } = productPayload;
                result = await s4PostV4(`${PRODUCT_SRV}/Product`, payloadNoPlant);
            } else {
                throw e;
            }
        }
        const created = result?.value?.[0]?.Product || result?.Product || material;

        return [{ type: 'text', text: JSON.stringify({
            success: true,
            message: `Material ${created} created in plant ${plant}`,
            product: created,
            materialType,
            baseUnit
        }, null, 2) }];
    }

    if (name === 'create_bom') {
        const { usage, items: bomItems } = args;
        if (!bomItems || bomItems.length === 0)
            throw new Error('items array is required and must not be empty');

        const payload = {
            Material: material,
            Plant: plant,
            BillOfMaterialVariantUsage: usage || '1',
            to_BillOfMaterialItem: {
                results: bomItems.map(item => ({
                    BillOfMaterialComponent:    item.component,
                    BillOfMaterialItemQuantity: String(item.quantity),
                    BillOfMaterialItemUnit:     item.unit,
                    BillOfMaterialItemCategory: item.itemCategory || 'L',
                    IsProductionRelevant:       true
                }))
            }
        };

        log(`create_bom  material="${material}"  plant="${plant}"  items=${bomItems.length}`);
        const result = await s4Post(`${BOM_SRV}/MaterialBOM`, payload);
        const bomNumber = result?.d?.BillOfMaterial || result?.BillOfMaterial || '(see result)';

        return [{
            type: 'text',
            text: JSON.stringify({
                success: true,
                message: `BOM created for material ${material} at plant ${plant}`,
                billOfMaterial: bomNumber,
                usage: usage || '1',
                itemCount: bomItems.length
            }, null, 2)
        }];
    }

    if (name === 'create_eco') {
        const { title, changeType, materials, boms, relevance } = args;
        if (!title) throw new Error('title is required');

        if (!(process.env.S4_HOST && process.env.S4_USER && process.env.S4_PASS))
            throw new Error('S4_HOST / S4_USER / S4_PASS not set in environment');

        const auth     = Buffer.from(`${process.env.S4_USER}:${process.env.S4_PASS}`).toString('base64');
        const hostname = new URL(process.env.S4_HOST).hostname;
        const rel      = relevance || 'S01'; // S01=更改, S02=创建, S03=更改触发器(BOM only), S05=新版本(BOM only)

        // ── Step 1: fetch CSRF token from Change Record service ──────────
        const { csrfToken, sessionCookie } = await new Promise((resolve, reject) => {
            https.request(
                { hostname, port: 443,
                  path: `${CHG_SRV}/A_ChangeRecord?$top=0`,
                  method: 'GET',
                  headers: { Authorization: `Basic ${auth}`, Accept: 'application/json',
                             'x-csrf-token': 'Fetch' } },
                res => {
                    res.resume();
                    res.on('end', () => {
                        const t = res.headers['x-csrf-token'];
                        const cookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
                        if (!t || t === 'Required')
                            reject(new Error('CSRF fetch failed for API_CHANGE_RECORD'));
                        else resolve({ csrfToken: t, sessionCookie: cookies });
                    });
                }
            ).on('error', reject).end();
        });

        // Helper: POST to Change Record API reusing same CSRF token + session
        const chgPost = (path, body) => new Promise((resolve, reject) => {
            const bodyStr = JSON.stringify(body);
            const req = https.request(
                { hostname, port: 443, path, method: 'POST',
                  headers: { Authorization: `Basic ${auth}`, Accept: 'application/json',
                             'Content-Type': 'application/json',
                             'Content-Length': Buffer.byteLength(bodyStr),
                             'x-csrf-token': csrfToken,
                             ...(sessionCookie ? { Cookie: sessionCookie } : {}) } },
                res => {
                    let data = '';
                    res.on('data', c => data += c);
                    res.on('end', () => {
                        if (res.statusCode >= 400)
                            reject(new Error(`POST ${res.statusCode}: ${data.slice(0, 300)}`));
                        else resolve(data ? JSON.parse(data) : { statusCode: res.statusCode });
                    });
                }
            );
            req.on('error', reject);
            req.end(bodyStr);
        });

        // ── Step 2: create the change record main entry ──────────────────
        log(`create_eco  title="${title}"  type=${changeType || 'S03'}`);
        const createResult = await chgPost(`${CHG_SRV}/A_ChangeRecord`, {
            ChangeRecordType:        changeType || 'S03',
            ChgRecordDescriptionText: title,
            ...(args.personResponsible ? { PersonResponsible: args.personResponsible } : {})
        });
        const chgUuid = createResult?.d?.ChangeRecordUUID || '';
        const chgNum  = createResult?.d?.ChangeRecord     || '';
        log(`create_eco  created  UUID=${chgUuid}  num=${chgNum}`);

        const linked = { materials: [], boms: [], errors: [] };

        // ── Step 3: link affected materials ─────────────────────────────
        for (const mat of (materials || [])) {
            try {
                const matBody = { ChangeRecordUUID: chgUuid, Material: mat };
                if (rel) matBody.ChangeRecordItemRelevance = rel;
                await chgPost(`${CHG_SRV}/A_ChangeRecordReferenceMat`, matBody);
                linked.materials.push(mat);
                log(`create_eco  linked material ${mat}`);
            } catch (e) {
                linked.errors.push(`Material ${mat}: ${e.message}`);
                log(`create_eco  ERROR linking material ${mat}: ${e.message}`);
            }
        }

        // ── Step 4: link affected BOMs ───────────────────────────────────
        for (const bom of (boms || [])) {
            try {
                const bomBody = {
                    ChangeRecordUUID:           chgUuid,
                    Material:                   bom.material,
                    Plant:                      bom.plant,
                    BillOfMaterialVariantUsage: bom.usage   || '1',
                    BillOfMaterialVariant:      bom.variant || '1'
                };
                if (rel) bomBody.ChangeRecordItemRelevance = rel;
                await chgPost(`${CHG_SRV}/A_ChgRecdRefEngBOM`, bomBody);
                linked.boms.push(`${bom.material}/${bom.plant}`);
                log(`create_eco  linked BOM ${bom.material}/${bom.plant}`);
            } catch (e) {
                linked.errors.push(`BOM ${bom.material}: ${e.message}`);
                log(`create_eco  ERROR linking BOM ${bom.material}: ${e.message}`);
            }
        }

        return [{ type: 'text', text: JSON.stringify({
            success:         true,
            changeRecord:    chgNum,
            changeRecordUUID: chgUuid,
            title,
            changeType:      changeType || 'S03',
            linkedMaterials: linked.materials,
            linkedBoms:      linked.boms,
            errors:          linked.errors,
            message: errors => errors.length
                ? `Change record ${chgNum} created. ${linked.materials.length} materials and ${linked.boms.length} BOMs linked. ${linked.errors.length} error(s).`
                : `Change record ${chgNum} created successfully. ${linked.materials.length} materials and ${linked.boms.length} BOMs linked.`
        }, null, 2) }];
    }

    throw new Error(`Unknown tool: ${name}`);
}

// ── Manual JSON-RPC handler ───────────────────────────────────────────────────
app.get('/mcp', (req, res) => {
    // Workbuddy / MCP 2025-06-18+ clients open a GET SSE stream for server→client notifications
    if ((req.headers.accept || '').includes('text/event-stream')) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        const hb = setInterval(() => { if (!res.writableEnded) res.write(': keepalive\n\n'); }, 15000);
        req.on('close', () => clearInterval(hb));
        return;
    }
    res.json({ server: 'bom-cost-optimizer', version: '1.0.0', protocol: 'MCP/2025-11-25', status: 'ready' });
});

app.post('/mcp', async (req, res) => {
    const { method, params, id, jsonrpc } = req.body || {};

    const ok  = result => res.json({ jsonrpc: '2.0', id: id ?? null, result });
    const err = (code, msg) => res.status(200).json({ jsonrpc: '2.0', id: id ?? null, error: { code, message: msg } });

    try {
        // Notifications — no response body needed
        if (method === 'notifications/initialized' || method?.startsWith('notifications/')) {
            return res.status(202).end();
        }

        if (method === 'initialize') {
            // Echo back the client's requested protocol version
            const clientVersion = params?.protocolVersion || '2025-11-25';
            return ok({
                protocolVersion: clientVersion,
                capabilities: { tools: {} },
                serverInfo: { name: 'bom-cost-optimizer', version: '1.0.0' }
            });
        }

        if (method === 'tools/list') {
            return ok({ tools: TOOLS });
        }

        if (method === 'tools/call') {
            const { name, arguments: toolArgs } = params || {};
            log(`tools/call  name="${name}"  args=${JSON.stringify(toolArgs)}`);
            const content = await callTool(name, toolArgs || {});
            const preview = JSON.stringify(content).slice(0, 300);
            log(`tools/call result: ${preview}`);
            return ok({ content });
        }

        if (method === 'ping') {
            return ok({});
        }

        return err(-32601, `Method not found: ${method}`);

    } catch (e) {
        log(`ERROR: ${e.message}`);
        return err(-32000, e.message);
    }
});

app.delete('/mcp', (_req, res) => res.status(200).end());

app.get('/health', (_req, res) => {
    const mode = process.env.S4_HOST ? 'local-direct' : 'btp-destination';
    res.json({ status: 'ok', server: 'bom-cost-optimizer', version: '1.0.0', mode });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    const mode = process.env.S4_HOST ? `local (${process.env.S4_HOST})` : 'BTP Destination';
    log(`bom-cost-optimizer MCP server :${PORT}  [${mode}]`);
    log(`debug log → ${LOG_FILE}`);
});
