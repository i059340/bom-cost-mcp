#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_bom_data.py
从 S/4HANA Cloud 读取 EP-10000001 全层级 BOM 物料的描述和价格
输出 bom_real_data.js，供 bom-cost-optimizer-app.html 使用
"""

import json, base64, ssl, urllib.request, urllib.error, http.cookiejar, time

# ── 配置 ──────────────────────────────────────────
S4_HOST  = "https://my409379-api.s4hana.cloud.sap"
S4_USER  = "BTP_COST_OPT"
S4_PASS  = "5Mg4RgX)C~AoWmX(ogv2d]a9SF2SDT#[3=wGuVwK"   # ← 填入密码

PRODUCT_SRV = "/sap/opu/odata4/sap/api_product/srvd_a2x/sap/product/0002"
DELAY       = 0.2   # 请求间隔秒数

# ── 要读取的物料清单（按层级）──────────────────────
MATERIALS = {
    "L1": ["EP-10000001"],
    "L2": [
        "EP-20001000","EP-20002000","EP-20003000","EP-20004000","EP-20005000",
        "EP-20006000","EP-20007000","EP-20008000","EP-20009000","EP-20010000",
        "EP-20011000"
    ],
    "L3": [
        "EP-21001000","EP-21001100","EP-21001200","EP-21001300","EP-21001400","EP-21001500",
        "EP-21002000","EP-21002100","EP-21002200","EP-21002300","EP-21002400",
        "EP-21003000","EP-21003100","EP-21003200","EP-21003300","EP-21003400",
        "EP-21004000","EP-21004100","EP-21004200","EP-21004300","EP-21004400",
        "EP-21005000","EP-21005100","EP-21005200","EP-21005300","EP-21005400",
        "EP-21006000","EP-21006100","EP-21006200","EP-21006300",
        "EP-21007000","EP-21007100","EP-21007200","EP-21007300",
        "EP-21008000","EP-21008100","EP-21008200","EP-21008300","EP-21008400","EP-21008500",
        "EP-21009000","EP-21009100","EP-21009200","EP-21009300",
        "EP-21010001","EP-21010002","EP-21010003","EP-21010004",
        "EP-21010005","EP-21010006","EP-21010007","EP-21010008","EP-21010009"
    ],
    "L4": [
        "EP-31001001","EP-31001002","EP-31001003","EP-31001004","EP-31001005",
        "EP-31001100","EP-31001101","EP-31001102","EP-31001103","EP-31001104",
        "EP-31001105","EP-31001106","EP-31001107",
        "EP-31001200","EP-31001201","EP-31001202","EP-31001203"
    ]
}

# ── HTTP 工具 ──────────────────────────────────────
def make_opener():
    ctx = ssl.create_default_context()
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ctx),
        urllib.request.HTTPCookieProcessor(jar)
    )

def auth_header():
    return "Basic " + base64.b64encode(f"{S4_USER}:{S4_PASS}".encode()).decode()

def get_json(opener, path):
    url = S4_HOST + PRODUCT_SRV + path
    req = urllib.request.Request(url)
    req.add_header("Authorization", auth_header())
    req.add_header("Accept", "application/json")
    try:
        with opener.open(req, timeout=15) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None   # 物料不存在，跳过
        print(f"  HTTP {e.code}: {path[:80]}")
        return None
    except Exception as ex:
        print(f"  ERR: {ex} — {path[:80]}")
        return None

# ── 读取单个物料的描述和估价 ───────────────────────
def fetch_material(opener, matnr):
    result = {"matnr": matnr, "desc": "", "price": 0,
              "price_type": "S", "type": "", "unit": "EA"}

    # 描述
    d = get_json(opener, f"/Product/{matnr}/_ProductDescription")
    if d and d.get("value"):
        result["desc"] = d["value"][0].get("ProductDescription", "")

    time.sleep(DELAY)

    # 物料类型 + 计量单位
    p = get_json(opener, f"/Product/{matnr}")
    if p:
        result["type"] = p.get("ProductType", "")
        result["unit"] = p.get("BaseUnit", "EA")

    time.sleep(DELAY)

    # 估价（标准价 or 移动平均价）
    v = get_json(opener, f"/Product/{matnr}/_ProductValuation")
    if v and v.get("value"):
        val = v["value"][0]
        proc = val.get("InventoryValuationProcedure", "S")
        if proc == "V":
            result["price"] = float(val.get("MovingAveragePrice", 0))
            result["price_type"] = "V"
        else:
            result["price"] = float(val.get("StandardPrice", 0))
            result["price_type"] = "S"

    time.sleep(DELAY)
    return result

# ── 主程序 ─────────────────────────────────────────
def main():
    if not S4_PASS:
        print("❌ 请先在第 14 行填写 S4_PASS"); return

    opener  = make_opener()
    all_mats = []
    for level, mnrs in MATERIALS.items():
        all_mats.extend([(level, m) for m in mnrs])

    total   = len(all_mats)
    results = {}

    print(f"开始读取 {total} 个物料...\n")
    for i, (level, matnr) in enumerate(all_mats, 1):
        print(f"[{i:>3}/{total}] {level} {matnr} ...", end=" ", flush=True)
        data = fetch_material(opener, matnr)
        if data["desc"]:
            results[matnr] = {
                "level":      level,
                "desc":       data["desc"],
                "price":      data["price"],
                "priceType":  data["price_type"],
                "type":       data["type"],
                "unit":       data["unit"]
            }
            print(f"✅ {data['desc'][:30]}  ¥{data['price']}")
        else:
            print("⚠ 不存在，跳过")

    # 输出 JS 文件
    js_lines = ["// 由 fetch_bom_data.py 自动生成 — 来自 S/4HANA my409379",
                "// 请勿手动修改，重新运行脚本即可更新",
                "const BOM_REAL = {"]
    for matnr, info in results.items():
        js_lines.append(
            f'  "{matnr}": {{'
            f'"level":"{info["level"]}",'
            f'"desc":"{info["desc"]}",'
            f'"price":{info["price"]},'
            f'"priceType":"{info["priceType"]}",'
            f'"type":"{info["type"]}",'
            f'"unit":"{info["unit"]}"}},'
        )
    js_lines.append("};")

    out_path = "bom_real_data.js"
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(js_lines))

    print(f"\n✅ 已写入 {out_path}（{len(results)} 个物料）")
    print("下一步：把 bom_real_data.js 发给 Joule，更新 HTML 中的 BOM 树数据")

if __name__ == "__main__":
    main()
