require('dotenv').config();
const https = require('https');
const fs    = require('fs');

const HOST = (process.env.S4_HOST || '').replace(/\/$/, '');
const USER = process.env.S4_USER || '';
const PASS = process.env.S4_PASS || '';
if (!HOST || !USER || !PASS) { console.error('[ERROR] .env 缺少必要配置'); process.exit(1); }

let API_HOST = HOST.replace(/https?:\/\//, '');
if (!API_HOST.includes('-api.') && API_HOST.includes('.s4hana.cloud.sap'))
  API_HOST = API_HOST.replace('.s4hana.cloud.sap', '-api.s4hana.cloud.sap');

const AUTH         = Buffer.from(`${USER}:${PASS}`).toString('base64');
const PLANT        = '1710';
const CURRENCY     = 'CNY';
const VALUATION_SRV = '/sap/opu/odata/sap/API_MATERIAL_VALUATION_SRV';

console.log(`[INFO] https://${API_HOST}  |  ${VALUATION_SRV}\n`);

const MATERIALS = [
  ['EP-10000001',32000],
  ['EP-20001000',12160],['EP-20002000',3800],['EP-20003000',3240],
  ['EP-20004000',3840],['EP-20005000',4480],['EP-20006000',2560],
  ['EP-20007000',1850],['EP-20008000',1920],['EP-20009000',1680],['EP-20010000',850],
  ['EP-21001000',9800],['EP-21001100',1260],['EP-21001200',680],
  ['EP-21001300',185],['EP-21001400',95],['EP-21001500',135],
  ['EP-21002000',2650],['EP-21002100',680],['EP-21002200',145],
  ['EP-21002300',125],['EP-21002400',85],
  ['EP-21003000',2180],['EP-21003100',480],['EP-21003200',285],
  ['EP-21003300',155],['EP-21003400',85],
  ['EP-21004000',1920],['EP-21004100',1280],['EP-21004200',185],
  ['EP-21004300',125],['EP-21004400',145],
  ['EP-21005000',2250],['EP-21005100',985],['EP-21005200',685],
  ['EP-21005300',285],['EP-21005400',185],['EP-21005500',125],['EP-21005600',45],
  ['EP-21006000',1250],['EP-21006100',485],['EP-21006200',385],
  ['EP-21006300',285],['EP-21006400',45],['EP-21006500',65],
  ['EP-21007000',680],['EP-21007100',485],['EP-21007200',285],
  ['EP-21007300',285],['EP-21007400',55],
  ['EP-21008000',1150],['EP-21008100',285],['EP-21008200',85],
  ['EP-21008300',125],['EP-21008400',145],['EP-21008500',35],
  ['EP-21009000',685],['EP-21009100',485],['EP-21009200',185],['EP-21009300',185],
  ['EP-21010001',285],['EP-21010002',125],['EP-21010003',65],
  ['EP-21010004',185],['EP-21010005',28],['EP-21010006',35],
  ['EP-21010007',65],['EP-21010008',35],['EP-21010009',15],
  ['EP-31001001',180],['EP-31001002',420],['EP-31001003',280],
  ['EP-31001004',65],['EP-31001005',42],
  ['EP-31001100',380],['EP-31001101',95],['EP-31001102',145],
  ['EP-31001103',220],['EP-31001104',68],['EP-31001105',125],
  ['EP-31001106',45],['EP-31001107',182],
  ['EP-31001200',145],['EP-31001201',285],['EP-31001202',68],
  ['EP-31001203',22],['EP-31001204',15],['EP-31001205',28],
  ['EP-31001206',48],['EP-31001207',8],
  ['EP-31002001',380],['EP-31002002',295],['EP-31002003',265],
  ['EP-31002004',420],['EP-31002005',185],['EP-31002006',145],
  ['EP-31002007',42],['EP-31002008',18],['EP-31002009',220],
  ['EP-31002010',125],['EP-31002011',35],['EP-31002012',68],
  ['EP-31002100',245],['EP-31002101',165],['EP-31002102',85],
  ['EP-31002103',55],['EP-31002104',95],['EP-31002105',28],
  ['EP-31003001',385],['EP-31003002',320],['EP-31003003',45],
  ['EP-31003004',65],['EP-31003005',125],['EP-31003006',85],
  ['EP-31003007',68],['EP-31003008',95],['EP-31003009',145],
  ['EP-31003010',185],['EP-31003011',0],
  ['EP-31003100',245],['EP-31003101',85],['EP-31003102',38],
  ['EP-31003103',28],['EP-31003104',12],
  ['EP-31004001',680],['EP-31004002',485],['EP-31004003',125],
  ['EP-31004004',145],['EP-31004005',68],['EP-31004006',42],
  ['EP-31004007',35],['EP-31004008',85],['EP-31004009',255],
  ['EP-31004100',285],['EP-31004101',345],['EP-31004102',125],
  ['EP-31004103',95],['EP-31004104',65],['EP-31004105',85],['EP-31004106',22],
  ['EP-31005001',385],['EP-31005002',245],['EP-31005003',165],
  ['EP-31005004',285],['EP-31005005',125],['EP-31005006',45],
  ['EP-31005007',65],['EP-31005008',85],['EP-31005009',55],['EP-31005010',45],
  ['EP-31005100',245],['EP-31005101',195],['EP-31005102',165],
  ['EP-31005103',85],['EP-31005104',48],['EP-31005105',22],['EP-31005106',8],
  ['EP-31005200',285],['EP-31005201',125],['EP-31005202',65],
  ['EP-31005203',28],['EP-31005204',18],
  ['EP-31006001',685],['EP-31006002',125],['EP-31006003',95],
  ['EP-31006004',145],['EP-31006005',0],['EP-31006006',85],
  ['EP-31006100',185],['EP-31006101',145],['EP-31006102',65],
  ['EP-31006103',45],['EP-31006104',12],
  ['EP-31007001',125],['EP-31007002',245],['EP-31007003',38],
  ['EP-31007004',85],['EP-31007005',28],['EP-31007006',95],
  ['EP-31007100',65],['EP-31007101',65],['EP-31007102',85],
  ['EP-31007103',35],['EP-31007104',125],['EP-31007105',45],['EP-31007106',28],
  ['EP-31007200',95],['EP-31007201',65],['EP-31007202',45],['EP-31007203',22],
  ['EP-31008001',285],['EP-31008002',245],['EP-31008003',125],
  ['EP-31008004',85],['EP-31008005',145],['EP-31008006',65],
  ['EP-31008007',28],['EP-31008008',85],
  ['EP-31009001',95],['EP-31009002',65],['EP-31009003',22],
  ['EP-31009004',45],['EP-31009005',85],
  ['EP-41001001',55],['EP-41001002',28],['EP-41001003',12],
  ['EP-41001004',18],['EP-41001005',8],['EP-41001006',3],['EP-41001007',3],
  ['EP-41001010',85],['EP-41001011',62],['EP-41001012',38],
  ['EP-41001013',12],['EP-41001014',25],['EP-41001015',45],['EP-41001016',18],
  ['EP-41001020',95],['EP-41001021',45],['EP-41001022',32],
  ['EP-41001023',15],['EP-41001024',8],
  ['EP-41004001',95],['EP-41004002',85],['EP-41004003',145],
  ['EP-41004004',65],['EP-41004005',28],['EP-41004006',35],
];

function httpReq(method, path, body, extra = {}) {
  return new Promise((resolve, reject) => {
    const s = body ? JSON.stringify(body) : '';
    const r = https.request(
      { hostname: API_HOST, port: 443, path, method, rejectUnauthorized: false,
        headers: { Authorization: `Basic ${AUTH}`, Accept: 'application/json',
          ...(body ? { 'Content-Type':'application/json','Content-Length':Buffer.byteLength(s) } : {}),
          ...extra } },
      res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:d})); }
    );
    r.on('error', reject); r.end(s);
  });
}

async function step1_discoverEntity() {
  console.log('[1/4] 读取服务元数据...');
  const r = await httpReq('GET', VALUATION_SRV+'/$metadata', null, {Accept:'application/xml'});
  console.log(`  HTTP ${r.status}`);
  if (r.status !== 200) return 'A_MaterialValuation';
  const m = r.body.match(/EntitySet[^>]+Name="([^"]+)"/g) || [];
  const sets = m.map(x => x.match(/"([^"]+)"/)[1]);
  console.log('  实体集:', sets.join(', '));
  return sets.find(s=>/[Pp]rice|[Vv]aluat|[Mm]aterial/i.test(s)) || sets[0] || 'A_MaterialValuation';
}

async function step2_csrf() {
  console.log('[2/4] 获取 CSRF Token...');
  const r = await httpReq('GET', VALUATION_SRV+'/', null, {'x-csrf-token':'Fetch'});
  const token   = r.headers['x-csrf-token'] || '';
  const cookies = (r.headers['set-cookie']||[]).map(c=>c.split(';')[0]).join('; ');
  console.log(`  HTTP ${r.status} | Token: ${token?'✅':'❌'}`);
  if (!token || token==='Required') { console.log('  响应:',r.body.slice(0,200)); return null; }
  return { token, cookies };
}

async function patch(entity, mat, price, csrf) {
  const enc = encodeURIComponent;
  const key  = `(Material='${enc(mat)}',ValuationArea='${enc(PLANT)}',ValuationType='')`;
  return httpReq('PATCH', `${VALUATION_SRV}/${entity}${key}`,
    { StandardPrice: price.toFixed(2), Currency: CURRENCY, PriceControl: 'S' },
    { 'x-csrf-token': csrf.token, Cookie: csrf.cookies, 'If-Match': '*' }
  );
}

(async () => {
  const entity = await step1_discoverEntity();
  const csrf   = await step2_csrf();
  if (!csrf) { console.error('\n[ABORT] 无法获取 CSRF'); process.exit(3); }

  console.log(`\n[3/4] 使用实体集: ${entity}`);
  console.log(`[4/4] 批量 PATCH ${MATERIALS.length} 个物料...\n`);

  const ok=[], fail=[], skip=[];
  for (let i=0; i<MATERIALS.length; i++) {
    const [mat,price] = MATERIALS[i];
    const idx = String(i+1).padStart(3);
    if (price===0) { skip.push(mat); console.log(`  [${idx}] ${mat.padEnd(16)} SKIP`); continue; }
    let r;
    try { r = await patch(entity, mat, price, csrf); }
    catch(e) { fail.push({mat,price,err:e.message}); console.log(`  [${idx}] ${mat.padEnd(16)} ERR ${e.message.slice(0,50)}`); continue; }

    if ([200,201,204].includes(r.status)) {
      ok.push({mat,price});
      console.log(`  [${idx}] ${mat.padEnd(16)} OK    CNY ${price.toLocaleString()}`);
    } else {
      const msg = r.body.slice(0,100).replace(/\s+/g,' ');
      fail.push({mat,price,status:r.status,err:msg});
      console.log(`  [${idx}] ${mat.padEnd(16)} FAIL  HTTP ${r.status} ${msg.slice(0,55)}`);
      if (i===0 && [401,403].includes(r.status)) {
        console.log('\n[ABORT] 首条鉴权失败。完整响应:\n', r.body.slice(0,500)); break;
      }
    }
    if ((i+1)%10===0) await new Promise(res=>setTimeout(res,80));
  }

  console.log('\n' + '='.repeat(58));
  console.log(`✅ 成功: ${ok.length}  ❌ 失败: ${fail.length}  ⏭ 跳过: ${skip.length}`);
  console.log('='.repeat(58));
  if (fail.length) { console.log('\n失败明细:'); fail.slice(0,10).forEach(f=>console.log(`  ${f.mat}: HTTP ${f.status||'?'} ${(f.err||'').slice(0,70)}`)); }

  fs.writeFileSync('price_update_result.json', JSON.stringify(
    { ts: new Date().toISOString(), ok: ok.length, fail: fail.length, skip: skip.length,
      success: ok, failed: fail }, null, 2));
  console.log('\n结果 → price_update_result.json');
})();
