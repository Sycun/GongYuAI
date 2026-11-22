#!/usr/bin/env python3
"""Kali 正式入口的独立工程验收（第七轮，验收项 6）。

用**虚构的原始资产材料**，经正式入口（HTTP）走完整链路：
  缺件核算 → 目标未通过 → 补交 → 重新核算 → 首次通过 → 报告/快照。

要求与断言：
1. 只上交一侧材料时，核算结论点名缺件，目标未通过、当前支持为 0；
2. 补交另一侧后重新核算，差异文件由本次发布的实际实现产生（不是预置答案，
   证据目录里不得出现 *-mock.json）；
3. 首次通过采用的核算文件生成时间早于首次通过时间；采纳路径、核算结果哈希、
   首次通过封存哈希、报告引用四处对应；
4. 输出可离线复算的交付快照，历史通过 / 当前支持 / 人工覆盖分别记录。

用法（在 Kali 上，跑在正式实例旁边；只读 HTTP + 只读文件 stat）：
  python3 formal-acceptance.py --base http://127.0.0.1:8877 \
      --data-root /home/parallels/GongYuAI-<short>/.gongyuai --out ./kali-formal
"""
import argparse
import calendar
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASELINE = """asset_id,owner,os_version,risk
GY-SRV-01,运维甲,Ubuntu 22.04,low
GY-SRV-02,运维乙,CentOS 7.9,high
GY-SRV-03,运维丙,Debian 12,low
GY-SRV-05,运维戊,Windows Server 2019,medium
"""

CURRENT = """asset_id,owner,os_version,risk
GY-SRV-01,运维甲,Ubuntu 22.04,low
GY-SRV-02,运维乙,CentOS 7.9,medium
GY-SRV-04,运维丁,Ubuntu 24.04,low
GY-SRV-05,运维戊,Windows Server 2019,medium
"""

REQUIRED_KEYS = ["GY-SRV-01", "GY-SRV-02", "GY-SRV-05", "GY-SRV-09"]
GOAL_ID = "kali-eng-asset-diff"

steps = []


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime())


def record(step, ok, detail):
    steps.append({"step": step, "ok": bool(ok), "detail": detail, "at": now()})
    print(("PASS  " if ok else "FAIL  ") + step + "  " + detail, flush=True)
    if not ok:
        raise SystemExit(f"步骤失败：{step}: {detail}")


def http(base, method, path, body=None, raw=False):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8") if not isinstance(body, bytes) else body
        headers["content-type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            payload = res.read()
            status = res.status
    except urllib.error.HTTPError as err:
        payload = err.read()
        status = err.code
    if raw:
        return status, payload.decode("utf-8", "replace")
    try:
        return status, json.loads(payload.decode("utf-8"))
    except Exception:
        return status, payload.decode("utf-8", "replace")


def wait_terminal(base, task_id, timeout=180):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        status, body = http(base, "GET", f"/tasks/{task_id}")
        last = body.get("task", {}) if isinstance(body, dict) else {}
        if last.get("status") in ("completed", "incomplete", "failed", "budget_exhausted", "stopped"):
            return last
        time.sleep(0.5)
    return last or {}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8877")
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--out", default="./kali-formal")
    args = parser.parse_args()
    base = args.base.rstrip("/")
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    started = now()

    status, health = http(base, "GET", "/health")
    record("0 正式入口健康", status == 200 and health.get("ok") is True, f"{base}/health → {status} {json.dumps(health, ensure_ascii=False)}")

    # ── 建档（虚构材料，独立工程验收任务）────────────────────────────────
    name = f"kali-engineering-acceptance-{int(time.time())}"
    status, created = http(base, "POST", "/tasks", {
        "name": name,
        "mock": True,
        "auth": {
            "authorizationNote": "虚构材料：Kali 正式入口工程验收，不代表任何真实客户或系统",
            "targets": ["kali-fixture.invalid"],
            "outOfScope": [],
            "capability": "observe",
        },
        "goals": [{
            "id": GOAL_ID,
            "title": "两份原始资产清单完成差异比对",
            "description": "缺任一侧材料都不算完成比对；两份齐全后缺项本身是有效核查结论",
            "assets": ["kali-fixture.invalid"],
            "evidencePatterns": ["reconcile/kali-eng-*.json"],
            "reconcileGate": {
                "pattern": "reconcile/kali-eng-*.json",
                "maxUnknown": 0,
                "maxAmbiguous": 0,
            },
        }],
    })
    task_id = created.get("task", {}).get("id") if isinstance(created, dict) else None
    record("1 建档", status == 201 and bool(task_id), f"POST /tasks → {status} task={task_id}")

    status, paused = http(base, "POST", f"/tasks/{task_id}/pause")
    record("1 暂停模拟 Worker", status == 200 and paused.get("task", {}).get("status") == "paused",
           f"status={paused.get('task', {}).get('status')}")

    # ── 只交当前清单：缺件 ───────────────────────────────────────────────
    status, up = http(base, "POST", f"/tasks/{task_id}/evidence",
                      {"path": "assets/yingji-current.csv", "content": CURRENT})
    record("2 导入当前清单（只交一侧）", status == 201, f"{up}")

    status, missing = http(base, "POST", f"/tasks/{task_id}/reconcile", {
        "name": "kali-eng-missing",
        "baseline": {"path": "assets/yingji-baseline.csv"},
        "current": {"path": "assets/yingji-current.csv"},
        "keyField": "asset_id",
        "requiredKeys": REQUIRED_KEYS,
    })
    missing_result = missing.get("result", {}) if isinstance(missing, dict) else {}
    record("2 缺件核算被接受", status == 201, f"POST /reconcile → {status} {missing.get('evidencePath')}")
    record("2 缺件结论点名基线材料",
           missing_result.get("missingMaterials") == ["assets/yingji-baseline.csv"],
           f"missingMaterials={json.dumps(missing_result.get('missingMaterials'), ensure_ascii=False)}")
    record("2 缺件时全部为未知",
           missing_result.get("counts", {}).get("unknown") == missing_result.get("counts", {}).get("totalKeys")
           and missing_result.get("counts", {}).get("changed") == 0,
           f"counts={json.dumps(missing_result.get('counts'), ensure_ascii=False)}")

    # 证据目录里不得有可匹配的 *-mock.json / 预置答案
    evidence_dir = os.path.join(args.data_root, "tasks", task_id, "evidence")
    mockish = []
    for root, _dirs, files in os.walk(evidence_dir):
        for f in files:
            if f.endswith("-mock.json") or f in ("expected.json", "answer.json"):
                mockish.append(os.path.join(root, f))
    record("2 证据目录没有预置答案", not mockish, f"命中 {len(mockish)} 个：{mockish}")

    # ── 走正常恢复：目标判定 → 报告 → 记分卡 ────────────────────────────
    status, resumed1 = http(base, "POST", f"/tasks/{task_id}/resume")
    record("3 任务恢复", status == 200, f"status={resumed1.get('task', {}).get('status')}")
    terminal1 = wait_terminal(base, task_id)
    record("3 缺件运行没有判通过", terminal1.get("status") == "incomplete",
           f"任务 status={terminal1.get('status')}（缺一侧材料不得 completed）")

    status, history1 = http(base, "GET", f"/tasks/{task_id}/history")
    goals1 = {g["id"]: g for g in history1.get("goals", [])}
    record("3 目标保持未通过", goals1.get(GOAL_ID, {}).get("passes") is False,
           f"{GOAL_ID} passes={goals1.get(GOAL_ID, {}).get('passes')}")
    rejections = [e for e in history1.get("events", [])
                  if e.get("kind") == "goal_assert_rejected" and e.get("payload", {}).get("goalId") == GOAL_ID]
    reason = rejections[0]["payload"].get("reason") if rejections else ""
    record("3 未通过原因点名缺件", "缺少基线材料 assets/yingji-baseline.csv" in (reason or ""),
           (reason or "没有拒绝记录")[:180])
    proofs1 = [p for p in history1.get("goalProofs", []) if p.get("goalId") == GOAL_ID]
    record("3 缺件阶段没有首次通过依据", not proofs1, f"goalProofs={len(proofs1)}")

    status, card1 = http(base, "GET", f"/tasks/{task_id}/snapshot")
    sc1 = card1.get("scorecard", {})
    record("3 记分卡当前支持为 0", sc1.get("currentlySupported") == 0 and sc1.get("historicallyPassed") == 0,
           f"历史 {sc1.get('historicallyPassed')}/{sc1.get('denominator')} · 当前 {sc1.get('currentlySupported')}/{sc1.get('denominator')}")
    with open(os.path.join(out_dir, "snapshot-after-missing.json"), "w") as fh:
        json.dump(card1.get("snapshot"), fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    status, report1 = http(base, "GET", f"/tasks/{task_id}/report", raw=True)
    record("3 报告写出缺件与未通过",
           "缺少基线材料 assets/yingji-baseline.csv" in report1 and "首次通过采用的核算文件" not in report1,
           f"报告 {len(report1)} 字节")

    # ── 补交另一侧：重新核算 ─────────────────────────────────────────────
    status, _ = http(base, "POST", f"/tasks/{task_id}/evidence",
                     {"path": "assets/yingji-baseline.csv", "content": BASELINE})
    record("4 补交基线清单", status == 201, "assets/yingji-baseline.csv 已导入")

    status, good = http(base, "POST", f"/tasks/{task_id}/reconcile", {
        "name": "kali-eng-diff",
        "baseline": {"path": "assets/yingji-baseline.csv"},
        "current": {"path": "assets/yingji-current.csv"},
        "keyField": "asset_id",
        "requiredKeys": REQUIRED_KEYS,
    })
    good_result = good.get("result", {}) if isinstance(good, dict) else {}
    record("4 合格核算", status == 201, f"POST /reconcile → {status} {good.get('evidencePath')}")
    counts = good_result.get("counts", {})
    # 独立预期（手算，不看实现）：01 未变、02 变更、03 移除、04 新增、05 未变，
    # 约定项 GY-SRV-09 两侧都不存在 → 缺件；合计 6 项。
    record("4 差异结论符合预期",
           counts.get("added") == 1 and counts.get("removed") == 1 and counts.get("changed") == 1
           and counts.get("unchanged") == 2 and counts.get("missing") == 1
           and counts.get("unknown") == 0 and counts.get("ambiguous") == 0 and counts.get("totalKeys") == 6,
           f"counts={json.dumps(counts, ensure_ascii=False)}")

    # 人工抽查一条差异及其原始行号
    changed = next((i for i in good_result.get("items", []) if i.get("key") == "GY-SRV-02"), None)
    record("4 人工抽查 GY-SRV-02",
           changed is not None and changed.get("status") == "changed"
           and changed.get("baselineLine") == 3 and changed.get("currentLine") == 3
           and changed.get("changes") == [{"field": "risk", "before": "high", "after": "medium"}],
           json.dumps(changed, ensure_ascii=False))
    absent = next((i for i in good_result.get("items", []) if i.get("key") == "GY-SRV-09"), None)
    record("4 两侧都不存在的约定项是有效结论",
           absent is not None and absent.get("status") == "missing"
           and absent.get("reason") == "required-key-absent-in-both",
           json.dumps(absent, ensure_ascii=False))

    diff_rel = good.get("evidencePath")
    diff_sha = good.get("evidenceSha256")
    diff_path = os.path.join(args.data_root, "tasks", task_id, "evidence", diff_rel)
    diff_mtime = os.path.getmtime(diff_path)
    record("4 差异文件由本次实现产生",
           os.path.isfile(diff_path) and hashlib.sha256(open(diff_path, "rb").read()).hexdigest() == diff_sha,
           f"{diff_rel} mtime={time.strftime('%Y-%m-%dT%H:%M:%S%z', time.localtime(diff_mtime))} sha256={diff_sha[:12]}…")

    # ── 首次通过 ─────────────────────────────────────────────────────────
    status, resumed2 = http(base, "POST", f"/tasks/{task_id}/resume")
    record("5 补交后从正常入口重新判定", status == 200, f"status={resumed2.get('task', {}).get('status')}")
    terminal2 = wait_terminal(base, task_id)
    record("5 目标由核算结果满足", terminal2.get("status") == "completed", f"status={terminal2.get('status')}")

    status, history2 = http(base, "GET", f"/tasks/{task_id}/history")
    goals2 = {g["id"]: g for g in history2.get("goals", [])}
    record("5 目标首次通过", goals2.get(GOAL_ID, {}).get("passes") is True,
           f"assertedAt={goals2.get(GOAL_ID, {}).get('assertedAt')}")
    asserted_at = goals2.get(GOAL_ID, {}).get("assertedAt") or ""
    # assertedAt 是 UTC（Z 结尾）：必须按 UTC 解析，不能当本地时间。
    asserted_ts = calendar.timegm(time.strptime(asserted_at[:19], "%Y-%m-%dT%H:%M:%S")) if asserted_at else 0
    # 文件系统 mtime 带毫秒、assertedAt 是整秒 UTC；按秒比较（放宽 1 秒容差），
    # 同时把两个绝对值都写进证据，便于复核人自行判断。
    record("5 差异文件生成时间早于首次通过",
           diff_mtime <= asserted_ts + 1,
           f"文件 mtime={time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(diff_mtime))}+08:00"
           f"（{int(diff_mtime)}s） ≤ 首次通过 {asserted_at}（{asserted_ts}s）")

    proofs = [p for p in history2.get("goalProofs", []) if p.get("goalId") == GOAL_ID]
    record("5 首次通过只指向一份核算文件",
           len(proofs) == 1 and proofs[0].get("path") == diff_rel and proofs[0].get("sha256") == diff_sha,
           json.dumps(proofs, ensure_ascii=False))
    adopted_events = [e for e in history2.get("events", [])
                      if e.get("kind") == "goal_asserted" and e.get("payload", {}).get("goalId") == GOAL_ID]
    adopted = adopted_events[0]["payload"].get("adoptedReconcile", {}) if adopted_events else {}
    record("5 首次通过事件指向实际采用的核算文件",
           adopted.get("path") == diff_rel and adopted.get("sha256") == diff_sha and len(adopted_events) == 1,
           f"{adopted.get('path')} · {str(adopted.get('sha256'))[:12]}…（事件 {len(adopted_events)} 条）")

    status, report2 = http(base, "GET", f"/tasks/{task_id}/report", raw=True)
    record("5 报告引用采用的核算文件与哈希",
           diff_rel in report2 and diff_sha in report2, f"报告 {len(report2)} 字节")
    with open(os.path.join(out_dir, "report.md"), "w") as fh:
        fh.write(report2)

    status, card2 = http(base, "GET", f"/tasks/{task_id}/snapshot")
    sc2 = card2.get("scorecard", {})
    with open(os.path.join(out_dir, "delivery-snapshot.json"), "w") as fh:
        json.dump(card2.get("snapshot"), fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    record("6 交付快照已保存", os.path.getsize(os.path.join(out_dir, "delivery-snapshot.json")) > 0,
           os.path.join(out_dir, "delivery-snapshot.json"))
    record("6 记分卡历史与当前分列",
           sc2.get("historicallyPassed") == 1 and sc2.get("currentlySupported") == 1 and sc2.get("denominator") == 1,
           f"历史 {sc2.get('historicallyPassed')}/{sc2.get('denominator')} · 当前 {sc2.get('currentlySupported')}/{sc2.get('denominator')} · "
           f"归属未知 {sc2.get('unknownAttribution')} · 人工覆盖 {json.dumps(sc2.get('coverage'), ensure_ascii=False)}")

    record_obj = {
        "kind": "kali-formal-acceptance",
        "startedAt": started,
        "finishedAt": now(),
        "base": base,
        "taskName": name,
        "taskId": task_id,
        "goalId": GOAL_ID,
        "dataRoot": args.data_root,
        "materials": {
            "baseline": {"path": "assets/yingji-baseline.csv", "sha256": hashlib.sha256(BASELINE.encode()).hexdigest()},
            "current": {"path": "assets/yingji-current.csv", "sha256": hashlib.sha256(CURRENT.encode()).hexdigest()},
        },
        "missingStage": {
            "evidencePath": missing.get("evidencePath"),
            "evidenceSha256": missing.get("evidenceSha256"),
            "missingMaterials": missing_result.get("missingMaterials"),
            "counts": missing_result.get("counts"),
            "taskStatus": terminal1.get("status"),
            "goalPasses": goals1.get(GOAL_ID, {}).get("passes"),
            "rejectionReason": reason,
            "scorecard": {k: sc1.get(k) for k in ("denominator", "historicallyPassed", "currentlySupported", "unknownAttribution", "coverage")},
        },
        "firstPass": {
            "evidencePath": diff_rel,
            "evidenceSha256": diff_sha,
            "fileMtime": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(diff_mtime)),
            "assertedAt": asserted_at,
            "adopted": adopted,
            "proofs": proofs,
            "counts": counts,
            "spotCheck": changed,
            "absentInBoth": absent,
            "scorecard": {k: sc2.get(k) for k in ("denominator", "historicallyPassed", "currentlySupported", "unknownAttribution", "coverage")},
            "snapshotSha256": card2.get("snapshot", {}).get("sha256"),
        },
        "steps": steps,
    }
    with open(os.path.join(out_dir, "kali-formal-acceptance.json"), "w") as fh:
        json.dump(record_obj, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    with open(os.path.join(out_dir, "kali-formal-acceptance.md"), "w") as fh:
        fh.write("# Kali 正式入口独立工程验收\n\n")
        fh.write(f"任务　{task_id}\n\n委托　{name}\n\n目标　{GOAL_ID}\n\n数据根　{args.data_root}\n\n")
        fh.write(f"开始　{started}\n\n结束　{record_obj['finishedAt']}\n\n")
        fh.write("| 步骤 | 结果 | 说明 |\n| --- | --- | --- |\n")
        for s in steps:
            fh.write(f"| {s['step']} | {'通过' if s['ok'] else '失败'} | {s['detail'].replace('|', chr(92)+'|')} |\n")
        fh.write("\n## 首次通过采用的核算文件\n\n")
        fh.write(f"- 路径　`{diff_rel}`\n- SHA-256　`{diff_sha}`\n- 文件生成时间　{diff_rel and time.strftime('%Y-%m-%dT%H:%M:%S%z', time.localtime(diff_mtime))}\n- 首次通过时间　{asserted_at}\n")
        fh.write(f"- 快照内容封印　`{card2.get('snapshot', {}).get('sha256')}`\n")
    print("\n记录：" + os.path.join(out_dir, "kali-formal-acceptance.json"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
