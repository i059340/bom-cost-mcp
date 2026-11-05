#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
link_eco_objects.py
只给已存在的变更单补充物料 + BOM 关联，不重新创建主记录。
Change Record: 1000000111
UUID:          fa163e33-7178-1fe1-b1f3-051201571c28
"""

import json, base64, ssl, urllib.request, urllib.error, http.cookiejar

# ── 配置 ──────────────────────────────────────────────────────────────
S4_HOST  = "https://my409379-api.s4hana.cloud.sap"
S4_USER  = "BTP_COST_OPT"
S4_PASS  = "5Mg4RgX)C~AoWmX(ogv2d]a9SF2SDT#[3=wGuVwK"       # ← 填入密码

CHG_SRV  = "/sap/opu/odata/sap/API_CHANGE_RECORD"

# ── 目标变更单（不要改这两行）──────────────────────────────────────────
CHG_UUID = "fa163e33-7178-1fe1-b1f3-051201571c28"
CHG_NUM  = "1000000111"

# ── 待关联对象 ─────────────────────────────────────────────────────────
MATERIALS = [
    "EP-10000001",   # 整车（根对象）
    "EP-20003000",   # 电机控制器总成（待替换）
    "EP-20006000",   # 整车电控与仪表系统（待替换）
    "EP-21001100",   # BMS总控单元（接口标准化）
    "EP-20011000",   # 集成驱动与整车控制器总成（新增）
]

PLANT = "1710"
BOM_USAGE = "1"

# ── HTTP 工具 ──────────────────────────────────────────────────────────
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

def probe_relevance(opener, csrf):
    """
    扫描 ChangeRecordItemRelevance 的合法值（针对 S03 类型）。
    逐个尝试候选值：
      - /PLMI/CR_BO/061 → 值不允许（继续）
      - /PLMI/CR_BO/015 → 值空（不应出现，继续）
      - HTTP 201        → 成功，已创建关联
      - 其他错误        → 可能通过了 relevance 校验，记录下来
    """
    print("\n[探测] 正在扫描 S03 允许的 ChangeRecordItemRelevance 值...")
    candidates = (
        list("ABCDEFGHJKLMNPQRSTUVWXYZ") +          # 单字母（跳过 I/O 避免混淆）
        [str(i) for i in range(0, 10)] +             # 单数字 0-9
        ["10","20","30","40","50","60","70","80","90"] +
        ["01","02","03","04","05","06","07","08","09"] +
        ["EN","PR","DE","MF","QA","EC","PC","RC"]
    )
    mat = MATERIALS[0]
    found = []
    for val in candidates:
        payload = {
            "ChangeRecordUUID":          CHG_UUID,
            "Material":                  mat,
            "ChangeRecordItemRelevance": val,
        }
        r = s4_post(opener, S4_HOST + CHG_SRV + "/A_ChangeRecordReferenceMat", payload, csrf)
        msg = r.get("msg", "")
        if r["ok"]:
            print(f"   ✅ 值 '{val}' 有效（关联已创建！）")
            found.append(val)
            return val, True   # (valid_value, already_linked_first_mat)
        elif "/PLMI/CR_BO/061" in msg:
            pass   # 值不允许，静默继续
        elif "/PLMI/CR_BO/015" in msg:
            print(f"   ? '{val}': 空值错误（不应出现）")
        else:
            # 其他错误 — relevance 可能通过了，但遇到别的问题
            short = msg[:160]
            print(f"   ? '{val}': 其他错误 → {short}")
            found.append(val)
    if not found:
        print("   ❌ 所有候选值均被 061 拒绝，请在 Fiori 中手动确认 S03 允许的 relevance 值")
    return None, False


def fetch_metadata(opener):
    """诊断：打印 EntitySet、NavProperty，以及关键实体的所有字段名。"""
    url = S4_HOST + CHG_SRV + "/$metadata"
    req = urllib.request.Request(url)
    req.add_header("Authorization", _auth())
    req.add_header("Accept", "application/xml")
    try:
        with opener.open(req, timeout=30) as r:
            xml = r.read().decode("utf-8", errors="replace")
        import re
        sets = re.findall(r'EntitySet[^>]*Name="([^"]+)"', xml)
        navs = re.findall(r'NavigationProperty[^>]*Name="([^"]+)"', xml)
        print("   EntitySet    :", sets)
        print("   NavProperty  :", list(dict.fromkeys(navs)))

        # ── 打印关键实体的字段名 ──────────────────────────────────
        targets = {
            "A_ChangeRecordReferenceMat": None,
            "A_ChgRecdRefEngBOM":         None,
            "A_ChangeRecordReferenceBOM": None,
        }
        # EntitySet Name → EntityType Name
        for m in re.finditer(r'<EntitySet[^>]+Name="([^"]+)"[^>]+EntityType="[^.]+\.([^"]+)"', xml):
            if m.group(1) in targets:
                targets[m.group(1)] = m.group(2)

        for es_name, et_name in targets.items():
            if not et_name:
                print(f"\n   [{es_name}] ← EntitySet 不存在")
                continue
            m2 = re.search(rf'<EntityType[^>]+Name="{re.escape(et_name)}"(.*?)</EntityType>', xml, re.DOTALL)
            if m2:
                props = re.findall(r'<Property[^>]+Name="([^"]+)"[^>]+Type="([^"]+)"', m2.group(1))
                keys  = re.findall(r'<PropertyRef[^>]+Name="([^"]+)"', m2.group(1))
                print(f"\n   [{es_name}]  (EntityType: {et_name})")
                print(f"      Keys      : {keys}")
                print(f"      Properties: {[p[0] for p in props]}")
    except Exception as e:
        print(f"   ❌ 获取 metadata 失败：{e}")

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
        msg = ""
        try: msg = e.read().decode()[:400]
        except: pass
        return {"ok": False, "status": e.code, "msg": msg}
    except Exception as e:
        return {"ok": False, "status": 0, "msg": str(e)}

# ── 关联物料 ────────────────────────────────────────────────────────────
# 修正：
#   1. 正确实体 A_ChangeRecordReferenceMat（metadata 已确认）
#   2. 导航 to_RefMat（metadata 已确认，原 to_ChgRecdRefMat 不存在）
def link_one_material(opener, csrf, mat, relevance="1"):
    attempts = [
        {
            "url":     S4_HOST + CHG_SRV + "/A_ChangeRecordReferenceMat",
            "payload": {
                "ChangeRecordUUID":          CHG_UUID,
                "Material":                  mat,
                "ChangeRecordItemRelevance": relevance,
            },
            "label": f"A_ChangeRecordReferenceMat+Rel{relevance}"
        },
        {
            "url":     S4_HOST + CHG_SRV + f"/A_ChangeRecord(guid'{CHG_UUID}')/to_RefMat",
            "payload": {
                "Material":                  mat,
                "ChangeRecordItemRelevance": relevance,
            },
            "label": f"to_RefMat+Rel{relevance}"
        },
    ]
    for a in attempts:
        r = s4_post(opener, a["url"], a["payload"], csrf)
        if r["ok"]:
            print(f"   ✅ [{a['label']}] 关联物料 {mat}")
            return True
        else:
            print(f"   ⚠  [{a['label']}] {r['status']}: {r.get('msg','')[:300]}")
    print(f"   ❌ 所有方式均失败：{mat}")
    return False

# ── 关联 BOM ────────────────────────────────────────────────────────────
# metadata 确认字段名：BillOfMaterialVariant（非 AlternativeBOMNumber / BillOfMaterialAlternativeNum）
# ChangeRecordItemRelevance 必填（否则 /PLMI/CR_BO/015）
def link_bom(opener, csrf, relevance="1"):
    mat = "EP-10000001"
    attempts = [
        {
            "url":     S4_HOST + CHG_SRV + f"/A_ChangeRecord(guid'{CHG_UUID}')/to_ChgRecdRefEngBOM",
            "payload": {
                "Material":                   mat,
                "Plant":                      PLANT,
                "BillOfMaterialVariantUsage": BOM_USAGE,
                "BillOfMaterialVariant":      "1",
                "ChangeRecordItemRelevance":  relevance,
            },
            "label":   f"to_ChgRecdRefEngBOM+Var+Rel{relevance}"
        },
        {
            "url":     S4_HOST + CHG_SRV + f"/A_ChangeRecord(guid'{CHG_UUID}')/to_RefBOM",
            "payload": {
                "Material":                   mat,
                "Plant":                      PLANT,
                "BillOfMaterialVariantUsage": BOM_USAGE,
                "BillOfMaterialVariant":      "1",
                "ChangeRecordItemRelevance":  relevance,
            },
            "label":   f"to_RefBOM+Var+Rel{relevance}"
        },
        {
            "url":     S4_HOST + CHG_SRV + "/A_ChgRecdRefEngBOM",
            "payload": {
                "ChangeRecordUUID":           CHG_UUID,
                "Material":                   mat,
                "Plant":                      PLANT,
                "BillOfMaterialVariantUsage": BOM_USAGE,
                "BillOfMaterialVariant":      "1",
                "ChangeRecordItemRelevance":  relevance,
            },
            "label":   f"A_ChgRecdRefEngBOM直接+Rel{relevance}"
        },
    ]
    for a in attempts:
        r = s4_post(opener, a["url"], a["payload"], csrf)
        if r["ok"]:
            print(f"   ✅ [{a['label']}] 关联 BOM {mat} / {PLANT}")
            return True
        else:
            print(f"   ⚠  [{a['label']}] {r['status']}: {r.get('msg','')[:300]}")
    print(f"   ❌ BOM 关联所有方式均失败，请在 Fiori 手动补充")
    return False

# ── 主程序 ─────────────────────────────────────────────────────────────
def main():
    if not S4_PASS:
        print("❌ 请先填写 S4_PASS"); return

    print(f"目标变更单：{CHG_NUM}（UUID: {CHG_UUID}）\n")
    opener = _make_opener()

    print("① 获取 CSRF Token...")
    csrf = fetch_csrf(opener)
    if not csrf:
        print("❌ CSRF 获取失败，终止"); return

    print("\n[诊断] 读取 OData metadata（EntitySet / NavigationProperty）...")
    fetch_metadata(opener)

    # ── 探测合法的 ChangeRecordItemRelevance 值 ──────────────────────────
    valid_rel, first_mat_done = probe_relevance(opener, csrf)
    if not valid_rel:
        print("\n⚠  无法自动确定 relevance 值，跳过物料/BOM 关联")
        print("   请在 Fiori → Manage Change Records → 手动打开变更单添加受影响对象")
        return
    print(f"\n   → 将使用 ChangeRecordItemRelevance = '{valid_rel}' 进行所有关联\n")

    print(f"② 关联受影响物料（共 {len(MATERIALS)} 个）...")
    for i, mat in enumerate(MATERIALS):
        if i == 0 and first_mat_done:
            print(f"   ✅ {mat} 已在探测阶段关联，跳过")
            continue
        link_one_material(opener, csrf, mat, valid_rel)

    print(f"\n③ 关联受影响 BOM（EP-10000001 / {PLANT}）...")
    link_bom(opener, csrf, valid_rel)

    print("\n" + "="*60)
    print(f"完成！请在 S/4HANA → Manage Change Records 中查看 {CHG_NUM}")

if __name__ == "__main__":
    main()
