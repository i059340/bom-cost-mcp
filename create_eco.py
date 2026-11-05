#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
create_eco.py — 在 S/4HANA Cloud 创建工程变更单（Change Record）
用途：M2 三套独立电控系统整合降本
"""

import json, base64, ssl, urllib.request, urllib.error, http.cookiejar

# ── 配置 ──────────────────────────────────────────────────────
S4_HOST  = "https://my409379-api.s4hana.cloud.sap"
S4_USER  = "BTP_COST_OPT"
S4_PASS  = "5Mg4RgX)C~AoWmX(ogv2d]a9SF2SDT#[3=wGuVwK"

CHG_SRV  = "/sap/opu/odata/sap/API_CHANGE_RECORD"

# ── 变更单参数 ─────────────────────────────────────────────────
CHG_TYPE  = "S03"

# 短标题（40 字符以内）
CHG_TITLE = "M2 电控集成降本 EP-10000001"

# 长描述
CHG_DESC  = (
    "三套独立电控系统整合：\n"
    "  替换 EP-20003000 电机控制器总成\n"
    "  替换 EP-20006000 整车电控与仪表系统\n"
    "  新增 EP-20011000 集成驱动与整车控制器总成\n"
    "预计降本：USD 1,450 / 台（~4.5%）"
)

AFFECTED_MATERIALS = [
    "EP-10000001",
    "EP-20003000",
    "EP-20006000",
    "EP-21001100",
    "EP-20011000",
]

AFFECTED_BOMS = [
    {"Material": "EP-10000001", "Plant": "1710", "BOMUsage": "1", "BOMAlternative": "1"},
]

# ── HTTP 工具 ──────────────────────────────────────────────────
def _make_opener():
    ctx = ssl.create_default_context()
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ctx),
        urllib.request.HTTPCookieProcessor(jar)
    )

def _auth():
    return "Basic " + base64.b64encode(f"{S4_USER}:{S4_PASS}".encode()).decode()

def fetch_csrf(opener):
    url = S4_HOST + CHG_SRV + "/A_ChangeRecord?$top=0"
    req = urllib.request.Request(url)
    req.add_header("Authorization", _auth())
    req.add_header("x-csrf-token",  "Fetch")
    req.add_header("Accept",        "application/json")
    with opener.open(req, timeout=30) as r:
        token = r.headers.get("x-csrf-token", "")
        print(f"   CSRF token: {'OK (' + token[:8] + '...)' if token else '❌ 未获取到'}")
        return token

def s4_post(opener, url, body, csrf):
    data = json.dumps(body).encode("utf-8")
    req  = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Authorization",  _auth())
    req.add_header("Content-Type",   "application/json; charset=utf-8")
    req.add_header("Content-Length", str(len(data)))
    req.add_header("Accept",         "application/json")
    req.add_header("x-csrf-token",   csrf)
    try:
        with opener.open(req, timeout=30) as r:
            raw = r.read()
            return {"ok": True, "status": r.status,
                    "body": json.loads(raw) if raw else {}}
    except urllib.error.HTTPError as e:
        body_err = e.read().decode("utf-8", errors="replace")
        return {"ok": False, "status": e.code, "msg": body_err[:600]}
    except Exception as e:
        return {"ok": False, "status": 0, "msg": str(e)}

# ── Step 1：创建变更单主记录 ───────────────────────────────────
def create_change_record(opener, csrf):
    payload = {
        "ChangeRecordType":        CHG_TYPE,
        # FIX Bug3: 正确字段名为 ChangeRecordDescription（非 ChgRecordDescriptionText）
        "ChangeRecordDescription": CHG_TITLE,
    }
    url = S4_HOST + CHG_SRV + "/A_ChangeRecord"
    r   = s4_post(opener, url, payload, csrf)
    if r["ok"]:
        chg_uuid = r["body"].get("d", {}).get("ChangeRecordUUID", "")
        chg_num  = r["body"].get("d", {}).get("ChangeRecord", "")
        print(f"   ✅ 变更单创建成功")
        print(f"      ChangeRecordUUID : {chg_uuid}")
        print(f"      ChangeRecord     : {chg_num}")
        return chg_uuid
    print(f"   ❌ 创建失败 HTTP {r['status']}：{r.get('msg', '')[:300]}")
    return None

# ── Step 2：关联受影响物料 ─────────────────────────────────────
def link_materials(opener, csrf, chg_uuid):
    # FIX Bug2: 正确实体名为 A_ChgRecdRefMat（非 A_ChangeRecordRefMat）
    url = S4_HOST + CHG_SRV + "/A_ChgRecdRefMat"
    for mat in AFFECTED_MATERIALS:
        payload = {
            "ChangeRecordUUID": chg_uuid,
            "Material":         mat,
        }
        r = s4_post(opener, url, payload, csrf)
        mark = "✅" if r["ok"] else f"❌ HTTP {r['status']}: {r.get('msg','')[:120]}"
        print(f"   {mark}  物料 {mat}")

# ── Step 3：关联受影响 BOM ─────────────────────────────────────
def link_boms(opener, csrf, chg_uuid):
    # FIX Bug1: 删除第二个（错误的）link_boms 定义，保留此"修正版"
    # 正确字段名：BillOfMaterialVariantUsage / AlternativeBOMNumber
    # 正确方式：直接 POST 到顶层实体，携带 ChangeRecordUUID 作为外键
    url = S4_HOST + CHG_SRV + "/A_ChgRecdRefEngBOM"
    for bom in AFFECTED_BOMS:
        payload = {
            "ChangeRecordUUID":           chg_uuid,
            "Material":                   bom["Material"],
            "Plant":                      bom["Plant"],
            "BillOfMaterialVariantUsage": bom["BOMUsage"],
            "AlternativeBOMNumber":       bom["BOMAlternative"],
        }
        r = s4_post(opener, url, payload, csrf)
        mark = "✅" if r["ok"] else f"❌ HTTP {r['status']}: {r.get('msg','')[:120]}"
        print(f"   {mark}  BOM {bom['Material']} / Plant {bom['Plant']}")

# ── 主程序 ─────────────────────────────────────────────────────
def main():
    if not S4_PASS:
        print("❌ 请先填写 S4_PASS"); return

    opener = _make_opener()

    print("① 获取 CSRF Token...")
    csrf = fetch_csrf(opener)
    if not csrf:
        print("❌ CSRF 获取失败，终止"); return

    print(f"\n② 创建变更单（类型 {CHG_TYPE}）...")
    chg_uuid = create_change_record(opener, csrf)
    if not chg_uuid:
        print("❌ 变更单创建失败，终止"); return

    print(f"\n③ 关联受影响物料（共 {len(AFFECTED_MATERIALS)} 个）...")
    link_materials(opener, csrf, chg_uuid)

    print(f"\n④ 关联受影响 BOM（共 {len(AFFECTED_BOMS)} 个）...")
    link_boms(opener, csrf, chg_uuid)

    print("\n" + "=" * 60)
    print("✅ 完成！请在 S/4HANA → Manage Change Records 中确认。")
    print(f"   变更单 UUID：{chg_uuid}")

if __name__ == "__main__":
    main()
