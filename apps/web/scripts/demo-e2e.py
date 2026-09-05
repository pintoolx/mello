"""Real browser-to-API demo acceptance. No mocked routes or fake settlement responses."""
import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from uuid import uuid4
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument("--inspect", action="store_true")
parser.add_argument("--live", action="store_true")
parser.add_argument("--layout-only", action="store_true")
args = parser.parse_args()
base = os.environ.get("MELLO_E2E_URL", "http://127.0.0.1:3400").rstrip("/")
output = Path(os.environ.get("MELLO_E2E_OUTPUT", "/tmp/mello-e2e-local"))
output.mkdir(parents=True, exist_ok=True)
if args.live and os.environ.get("MELLO_TESTNET_PAYMENT_APPROVED") != "true":
    raise RuntimeError("Live acceptance requires explicit MELLO_TESTNET_PAYMENT_APPROVED=true (three 0.05 Test USDC purchases maximum)")

report = {"url": base, "live": args.live, "purchases": [], "checks": [], "pageErrors": []}

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1280, "height": 900}, reduced_motion="reduce")
    page = context.new_page()
    page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
    page.goto(base + "/app", wait_until="networkidle")
    page.screenshot(path=str(output / "initial.png"), full_page=True)
    print(json.dumps({"buttons": page.get_by_role("button").all_text_contents()}, ensure_ascii=False), flush=True)
    if args.inspect:
        context.close()
        browser.close()
        raise SystemExit(0)

    def check(name):
        report["checks"].append(name)
        (output / "progress.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print("PASS " + name, flush=True)

    def get(path):
        response = page.request.get(base + "/api/v1" + path)
        assert response.ok, (path, response.status)
        return response.json()

    def current_task():
        task_id = parse_qs(urlparse(page.url).query)["task"][0]
        return get("/tasks/" + task_id)

    def terminal():
        page.wait_for_function("() => /COMPLETED|ACTION_REQUIRED|REJECTED|FAILED/.test(document.querySelector('[data-testid=task-status]')?.textContent || '')", timeout=180_000)
        return current_task()

    def complete_purchase():
        task = terminal()
        if task["status"] == "ACTION_REQUIRED" and task.get("purchase", {}).get("availableActions", {}).get("retryInvoice"):
            payment = task["purchase"]["payment"]["transactionHash"]
            page.get_by_role("button", name="重試發票（不重付）").click()
            expect(page.get_by_test_id("task-status")).to_contain_text("COMPLETED", timeout=180_000)
            task = current_task()
            assert task["purchase"]["payment"]["transactionHash"] == payment
            check("invoice retry preserves the original settlement")
        assert task["status"] == "COMPLETED", {"status": task["status"], "error": task.get("error")}
        purchase = task["purchase"]
        assert purchase["payment"]["status"] == "SETTLED"
        assert purchase["delivery"]["status"] == "DELIVERED" and purchase["delivery"]["responseBody"]
        assert purchase["invoice"]["status"] == "ISSUED_DEMO"
        assert purchase["reconciliation"]["status"] == "MATCHED"
        assert {a["kind"] for a in purchase["anchors"] if a["status"] == "CONFIRMED"} >= {"AUTHORIZE", "FINALIZE"}
        assert purchase["expectedAmountAtomic"] == "50000"
        if args.live:
            assert purchase["modes"]["payment"] == "x402" and purchase["modes"]["anchor"] == "onchain"
            assert purchase["explorerLinks"]["payment"] == "https://sepolia.basescan.org"
            assert purchase["payment"]["transactionHash"].startswith("0x")
            expect(page.get_by_test_id("payment-hash").get_by_role("link")).to_have_attribute("href", "https://sepolia.basescan.org/tx/" + purchase["payment"]["transactionHash"])
        report["purchases"].append({"taskId": task["taskId"], "purchaseId": purchase["purchaseId"], "paymentHash": purchase["payment"]["transactionHash"], "amountAtomic": purchase["expectedAmountAtomic"], "anchors": purchase["anchors"]})
        (output / "progress.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        return task

    assert page.request.get(base + "/api/v1/settings").status == 401
    assert page.request.post(base + "/api/v1/tasks", data={"prompt": "unauthorized purchase"}).status == 401
    check("anonymous access cannot read or create purchases")
    page.get_by_label("登入採購操作台").fill(os.environ["MELLO_ACCESS_CODE"])
    page.get_by_role("button", name="登入", exact=True).click()
    expect(page.get_by_role("button", name="執行採購任務 →")).to_be_enabled(timeout=60_000)
    session = next(cookie for cookie in context.cookies() if cookie["name"] == "mello_session")
    assert session["httpOnly"] and session["sameSite"] == "Strict"
    if args.live:
        assert session["secure"]
    check("authenticated HttpOnly session and initial API data")
    assert page.request.put(base + "/api/v1/controls", data={"paymentsFrozen": True}, headers={"origin": "https://untrusted.example"}).status == 403
    check("cross-origin privileged actions are rejected")

    if args.layout_only:
        existing = next(task for task in get("/tasks?limit=100")["items"] if task["status"] == "COMPLETED")
        page.goto(base + "/app?task=" + existing["taskId"], wait_until="networkidle")
        expect(page.get_by_test_id("task-status")).to_contain_text("COMPLETED", timeout=60_000)
        for title in ["完整付款與報告證據", "發票資料", "完整稽核紀錄"]:
            page.get_by_text(title, exact=True).click()
        for width in [375, 768, 1280]:
            page.set_viewport_size({"width": width, "height": 900})
            page.screenshot(path=str(output / f"layout-{width}.png"), full_page=True)
            print(json.dumps(page.evaluate("({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,offenders:[...document.querySelectorAll('body > *,main > *')].filter(e=>e.getBoundingClientRect().right>innerWidth).map(e=>({tag:e.tagName,class:e.className,width:e.getBoundingClientRect().width}))})")), flush=True)
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), f"horizontal page overflow at {width}px"
        assert not report["pageErrors"], report["pageErrors"]
        report["ok"] = True
        check("read-only deployed layout and existing evidence at all three viewports")
        (output / "layout-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        context.close()
        browser.close()
        raise SystemExit(0)

    page.get_by_role("button", name="執行採購任務 →").click()
    first = complete_purchase()
    check("purchase → settlement → delivery → invoice → reconciliation → anchors")
    before_summary = get("/dashboard/summary")
    page.reload(wait_until="networkidle")
    expect(page.get_by_test_id("task-status")).to_contain_text("COMPLETED", timeout=60_000)
    assert current_task()["purchaseId"] == first["purchaseId"]
    check("reload restores the same task and evidence")
    page.get_by_role("button", name="模擬財務 Agent 重複下單").click()
    expect(page.get_by_role("status").filter(has_text="DUPLICATE_PURCHASE")).to_be_visible(timeout=30_000)
    after_summary = get("/dashboard/summary")
    assert after_summary["counts"]["purchases"] == before_summary["counts"]["purchases"]
    assert after_summary["settledAmountAtomic"] == before_summary["settledAmountAtomic"]
    assert current_task()["purchase"]["payment"]["transactionHash"] == first["purchase"]["payment"]["transactionHash"]
    check("cross-agent request-key replay does not add a task or payment")

    page.get_by_role("button", name="凍結所有新付款", exact=True).click()
    expect(page.get_by_role("button", name="付款已凍結 · 點擊解除")).to_be_visible()
    page.reload(wait_until="networkidle")
    expect(page.get_by_role("button", name="付款已凍結 · 點擊解除")).to_be_visible(timeout=60_000)
    assert get("/controls")["paymentsFrozen"] is True
    response = page.request.post(base + "/api/v1/tasks", data={"prompt": "購買信用報告，預算 0.10 USDC", "requestKey": str(uuid4())}, headers={"origin": base})
    assert response.status == 409 and response.json()["error"]["code"] == "PAYMENTS_FROZEN"
    page.get_by_role("button", name="付款已凍結 · 點擊解除").click()
    expect(page.get_by_role("button", name="凍結所有新付款", exact=True)).to_be_visible()
    check("freeze survives reload and is enforced server-side")

    page.get_by_role("button", name="測試 0.03 預算").click()
    expect(page.get_by_test_id("task-status")).to_contain_text("REJECTED", timeout=60_000)
    assert current_task()["purchase"] is None
    check("0.03 USDC budget is rejected without a payment")
    page.get_by_role("button", name="測試 payTo 不符").click()
    expect(page.get_by_test_id("task-status")).to_contain_text("REJECTED", timeout=60_000)
    expect(page.get_by_test_id("task-error")).to_contain_text("PAY_TO_MISMATCH")
    assert current_task()["purchase"] is None
    check("recipient mismatch is rejected before signing/payment")

    page.get_by_role("button", name="重置 Demo").click()
    page.get_by_label("採購任務").fill("幫我買一份 晨光貿易 的信用報告，預算 0.10 USDC，要開統編發票。超過 0.03 USDC 先問我。")
    page.get_by_role("button", name="執行採購任務 →").click()
    expect(page.get_by_test_id("task-error")).to_contain_text("APPROVAL_REQUIRED", timeout=60_000)
    assert current_task()["purchase"] is None
    page.get_by_role("button", name="核准此筆採購").click()
    # Wait for approval to leave the prior terminal state before reading it.
    page.wait_for_function("() => !document.querySelector('[data-testid=task-error]')?.textContent.includes('APPROVAL_REQUIRED')", timeout=60_000)
    complete_purchase()
    check("manual approval binds the quoted terms before payment")

    page.get_by_role("button", name="重置 Demo").click()
    page.get_by_role("button", name="執行採購任務 →").click()
    complete_purchase()
    check("three independent 0.05 USDC purchases complete")
    page.get_by_text("完整付款與報告證據", exact=True).click()
    expect(page.get_by_text("服務尚未交付，不顯示付費內容。", exact=True)).to_have_count(0)
    page.get_by_text("發票資料", exact=True).click()
    page.get_by_text("完整稽核紀錄", exact=True).click()
    for width in [375, 768, 1280]:
        page.set_viewport_size({"width": width, "height": 900})
        page.screenshot(path=str(output / f"completed-{width}.png"), full_page=True)
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), f"horizontal page overflow at {width}px"
    check("mobile/tablet/desktop evidence panels and layout")
    assert not report["pageErrors"], report["pageErrors"]
    page.get_by_role("button", name="登出", exact=True).click()
    expect(page.get_by_label("登入採購操作台")).to_be_visible()
    assert page.request.get(base + "/api/v1/settings").status == 401
    check("logout removes authenticated API access")
    report["ok"] = True
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({"ok": True, "purchases": len(report["purchases"]), "checks": len(report["checks"]), "output": str(output)}, ensure_ascii=False), flush=True)
    context.close()
    browser.close()
