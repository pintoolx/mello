"""Authenticated workspace regression. Mock by default; explicitly gated Base Sepolia live mode.

Requires Python Playwright + Chromium, both built sites, MELLO_ACCESS_CODE, and
MOCK_INVOICE_FAIL_ONCE=true. Default: isolated local mock stack. Live mode needs
an explicitly approved HTTPS deployment and verified Base Sepolia registry;
it retains a crash journal and refuses a blind restart. Keeps all created records.
"""
import argparse
import json
import os
import re
import time
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument("--live", action="store_true", help="Two 0.05 Test USDC purchases on the approved Base Sepolia deployment")
args = parser.parse_args()
base = os.environ.get("MELLO_E2E_URL", "http://127.0.0.1:3400").rstrip("/")
docs = os.environ.get("MELLO_E2E_DOCS_URL", "http://127.0.0.1:4174").rstrip("/")
registry = os.environ.get("MELLO_E2E_REGISTRY_ADDRESS", "")
if args.live:
    assert os.environ.get("MELLO_TESTNET_PAYMENT_APPROVED") == "true", "Live mode needs approval for at most 0.10 Test USDC"
    assert base == os.environ.get("WEB_PUBLIC_URL", "").rstrip("/"), "Live origin must match the approved deployment"
    assert all(urlparse(url).scheme == "https" for url in (base, docs)), "Live sites must use HTTPS"
    assert re.fullmatch(r"0x[\da-fA-F]{40}", registry), "Set the verified Base Sepolia registry address"
else:
    for url in (base, docs):
        assert urlparse(url).hostname in ("localhost", "127.0.0.1", "::1"), "Local mock regression only"
code = os.environ["MELLO_ACCESS_CODE"]
output = Path(os.environ.get("MELLO_E2E_OUTPUT", "/tmp/mello-workspace-live" if args.live else "/tmp/mello-workspace-merge"))
if args.live and (output / "report.json").exists():
    raise RuntimeError("Existing live journal found. Inspect and resume its task IDs; never blindly restart paid acceptance.")
output.mkdir(parents=True, exist_ok=True)
report = {"live": args.live, "registry": registry if args.live else None, "checks": [], "tasks": [], "purchases": [], "createRequests": [], "pageErrors": [], "ok": False}

def checkpoint():
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")

checkpoint()

with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    def record_create(request):
        if request.method == "POST" and request.url == base + "/api/v1/tasks":
            # Persist the request key before receiving the create response. No cookies or secrets.
            report["createRequests"].append(request.post_data_json)
            checkpoint()
    page.on("request", record_create)
    page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
    expect.set_options(timeout=15000)

    def check(name):
        report["checks"].append(name)
        checkpoint()
        print(name, flush=True)

    def request(path, method="GET", data=None, status=None):
        response = context.request.fetch(base + "/api/v1" + path, method=method, data=data, headers={"origin": base})
        assert response.status == status if status else response.ok, (path, response.status)
        return response.json()

    def task(task_id):
        return request("/tasks/" + task_id)

    def wait_task(task_id, statuses):
        deadline = time.monotonic() + (240 if args.live else 70)
        while time.monotonic() < deadline:
            current = task(task_id)
            if current["status"] in statuses:
                return current
            page.wait_for_timeout(300)
        raise AssertionError("Task did not reach expected state: " + task_id)

    def screenshot(name, width=1280):
        page.set_viewport_size({"width": width, "height": 900})
        page.wait_for_timeout(150)
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), (name, width, "horizontal overflow")
        page.screenshot(path=str(output / f"{name}-{width}.png"), full_page=True)

    def open_form(budget=None, approval="", pay_to=""):
        budget = budget or ("0.05" if args.live else "0.10")
        page.goto(base + "/app/tasks/new", wait_until="networkidle")
        expect(page.get_by_label("查詢企業名稱")).to_be_visible()
        page.get_by_label("查詢企業名稱").fill("晨光貿易")
        page.get_by_label("預算上限", exact=False).fill(budget)
        if approval or pay_to:
            page.get_by_text("付款前控制（選填）", exact=True).click()
        if approval:
            page.get_by_label("人工核准門檻（USDC）").fill(approval)
        if pay_to:
            page.get_by_label("限定收款地址", exact=True).fill(pay_to)

    def create():
        page.get_by_role("button", name="建立申請", exact=True).click()
        page.wait_for_url(re.compile(r"/app/tasks/[\da-f-]{36}$"))
        task_id = page.url.rsplit("/", 1)[1]
        current = task(task_id)
        assert current["status"] == "CREATED" and current["purchase"] is None
        report["tasks"].append(task_id)
        checkpoint()
        return task_id

    def run(task_id):
        page.get_by_role("button", name="送出採購", exact=True).click()
        return wait_task(task_id, {"COMPLETED", "ACTION_REQUIRED", "REJECTED", "FAILED"})

    def finish_invoice(task_id):
        current = wait_task(task_id, {"ACTION_REQUIRED", "COMPLETED", "FAILED"})
        assert current["status"] == "ACTION_REQUIRED", "Set MOCK_INVOICE_FAIL_ONCE=true for this regression"
        purchase = current["purchase"]
        assert purchase["payment"]["status"] == "SETTLED"
        assert purchase["availableActions"]["retryInvoice"]
        before = (purchase["purchaseId"], purchase["paymentAuthorization"]["paymentId"], purchase["payment"]["transactionHash"])
        page.get_by_role("tab", name="付款與對帳", exact=True).click()
        page.get_by_role("button", name="重試取得發票", exact=True).click()
        done = wait_task(task_id, {"COMPLETED"})
        after = done["purchase"]
        assert before == (after["purchaseId"], after["paymentAuthorization"]["paymentId"], after["payment"]["transactionHash"])
        assert after["invoice"]["status"] == "ISSUED_DEMO"
        assert after["reconciliation"]["status"] == "MATCHED"
        assert after["expectedAmountAtomic"] == "50000"
        assert {a["kind"] for a in after["anchors"] if a["status"] == "CONFIRMED"} >= {"AUTHORIZE", "FINALIZE"}
        if args.live:
            assert after["modes"]["payment"] == "x402" and after["modes"]["anchor"] == "onchain"
            assert after["network"] == "eip155:84532"
            assert after["token"]["address"].lower() == "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
            assert re.fullmatch(r"0x[\da-fA-F]{64}", after["payment"]["transactionHash"])
            assert after["explorerLinks"]["payment"] == "https://sepolia.basescan.org"
            expect(page.get_by_role("link", name=after["payment"]["transactionHash"] + " ↗", exact=True)).to_have_attribute("href", "https://sepolia.basescan.org/tx/" + after["payment"]["transactionHash"])
        report["purchases"].append({"taskId": task_id, "purchaseId": after["purchaseId"], "paymentHash": after["payment"]["transactionHash"], "amountAtomic": after["expectedAmountAtomic"], "anchors": after["anchors"]})
        assert len(report["purchases"]) <= 2
        checkpoint()
        expect(page.get_by_text("已完成", exact=True)).to_be_visible()
        return done

    try:
        request("/settings", status=401)
        request("/tasks", "POST", {"prompt": "anonymous must fail"}, status=401)
        page.goto(base + "/", wait_until="networkidle")
        expect(page.get_by_role("heading", name="登入採購工作區")).to_be_visible()
        assert urlparse(page.url).path == "/app"
        for width in (375, 768, 1280):
            screenshot("login", width)
        page.get_by_label("工作區存取碼").fill("wrong-access-code")
        page.get_by_role("button", name="登入工作區", exact=True).click()
        expect(page.locator(".error-message[role=alert]")).to_contain_text("存取碼不正確")
        page.get_by_label("工作區存取碼").fill(code)
        page.get_by_role("button", name="登入工作區", exact=True).click()
        expect(page.get_by_role("heading", name="採購申請", exact=True)).to_be_visible()
        health = request("/demo/health")
        expected_modes = {"payment": "x402" if args.live else "mock", "anchor": "onchain" if args.live else "mock", "agent": "demo", "invoice": "mock"}
        assert all(health["modes"][key] == mode for key, mode in expected_modes.items()), "Unexpected backend modes"
        settings = request("/settings")
        if args.live:
            assert health["status"] == "ok", "All live dependencies must be healthy before spending"
            assert health["modes"]["offchainAuthorizationFallbackEnabled"] is False
            assert health["checks"]["baseRpc"]["details"] == {"chainId": 84532, "loopback": False}
            assert health["checks"]["contract"]["details"]["address"].lower() == registry.lower()
            assert health["checks"]["invoice"]["details"]["failOnceEnabled"] is True
            assert int(health["checks"]["buyerWallet"]["details"]["usdcBalanceAtomic"]) >= 100000
            assert settings["policy"]["allowedNetworks"] == ["eip155:84532"]
            invoicing = [service for service in settings["services"] if service["supportsTwInvoice"]]
            assert len(invoicing) == 1 and invoicing[0]["id"] == "credit-report-b" and invoicing[0]["priceAtomic"] == "50000"
        assert request("/controls")["paymentsFrozen"] is False, "Start with an unfrozen isolated API"
        cookie = next(item for item in context.cookies() if item["name"] == "mello_session")
        assert cookie["httpOnly"] and cookie["sameSite"] == "Strict"
        if args.live:
            assert cookie["secure"]
        assert context.request.put(base + "/api/v1/controls", data={"paymentsFrozen": True}, headers={"origin": "https://untrusted.example"}).status == 403
        request("/demo/reset", "POST", {}, status=404)
        check("login, HttpOnly session, anonymous rejection, CSRF and reset allowlist")
        initial_purchases = request("/purchases?limit=1")["total"]
        report["initialPurchaseCount"] = initial_purchases
        checkpoint()

        open_form()
        first_id = create()
        check("create persists a draft without running or paying")
        run(first_id)
        first = finish_invoice(first_id)
        check("invoice retry completes with the same purchase and payment")
        for width in (375, 768, 1280):
            screenshot("records", width)
        page.reload(wait_until="networkidle")
        assert task(first_id)["purchaseId"] == first["purchaseId"]
        expect(page.get_by_text("已完成", exact=True)).to_be_visible()
        replay = {"prompt": first["prompt"], "requestKey": first["control"]["requestKey"]}
        duplicate = request("/tasks", "POST", replay, status=200)
        assert duplicate["deduplicated"] and duplicate["taskId"] == first_id
        request("/tasks", "POST", {**replay, "prompt": "different content"}, status=409)
        request(f"/tasks/{first_id}/run", "POST", status=200)
        assert task(first_id)["purchaseId"] == first["purchaseId"]
        check("reload and request-key replay preserve one purchase; conflicts reject")

        page.goto(base + "/app/policy", wait_until="networkidle")
        page.get_by_role("button", name="凍結新付款", exact=True).click()
        expect(page.get_by_role("button", name="解除新付款凍結", exact=True)).to_be_enabled()
        page.reload(wait_until="networkidle")
        assert request("/controls")["paymentsFrozen"] is True
        request("/tasks", "POST", {"prompt": "must not create", "requestKey": str(uuid4())}, status=409)
        page.goto(base + "/app/tasks/new", wait_until="networkidle")
        expect(page.get_by_role("button", name="建立申請", exact=True)).to_be_disabled()
        page.goto(base + "/app/policy", wait_until="networkidle")
        page.get_by_role("button", name="解除新付款凍結", exact=True).click()
        expect(page.get_by_role("button", name="凍結新付款", exact=True)).to_be_enabled()
        check("freeze persists across reload and rejects new requests server-side")

        open_form(budget="0.03", approval="0")
        captured = {}

        def lose_create_response(route):
            if route.request.method != "POST":
                route.continue_()
                return
            response = route.fetch()
            assert response.status == 201
            captured.update(response.json())
            route.abort("failed")

        page.route(base + "/api/v1/tasks", lose_create_response)
        page.get_by_role("button", name="建立申請", exact=True).click()
        expect(page.get_by_role("button", name="找回原申請", exact=True)).to_be_enabled()
        page.unroute(base + "/api/v1/tasks", lose_create_response)
        assert captured.get("taskId")
        report["tasks"].append(captured["taskId"])
        checkpoint()
        count = request("/tasks?limit=1")["total"]
        page.reload(wait_until="networkidle")
        expect(page.get_by_role("button", name="建立申請", exact=True)).to_be_disabled()
        page.get_by_role("button", name="找回原申請", exact=True).click()
        page.wait_for_url(base + "/app/tasks/" + captured["taskId"])
        assert request("/tasks?limit=1")["total"] == count
        assert task(captured["taskId"])["status"] == "CREATED"
        denied = run(captured["taskId"])
        assert denied["status"] == "REJECTED" and denied["purchase"] is None
        check("lost create response recovers after reload without a second task; low budget rejects")

        open_form(approval="0", pay_to="0x0000000000000000000000000000000000000001")
        mismatch_id = create()
        mismatch = run(mismatch_id)
        assert mismatch["status"] == "REJECTED" and mismatch["purchase"] is None
        assert "PAY_TO_MISMATCH" in mismatch["error"]["message"]
        check("recipient constraint rejects before purchase/signing")

        open_form(approval="0.03")
        approval_id = create()
        approval = run(approval_id)
        assert approval["status"] == "ACTION_REQUIRED" and approval["purchase"] is None
        assert approval["error"]["code"] == "APPROVAL_REQUIRED"
        expect(page.get_by_role("heading", name="確認付款報價", exact=True)).to_be_visible()
        for width in (375, 768, 1280):
            screenshot("approval", width)
        page.get_by_role("button", name="核准此報價並繼續", exact=True).click()
        # Approval can initially return the old ACTION_REQUIRED revision; wait for a purchase.
        deadline = time.monotonic() + (240 if args.live else 70)
        while task(approval_id)["purchase"] is None and time.monotonic() < deadline:
            page.wait_for_timeout(300)
        finish_invoice(approval_id)
        assert request("/purchases?limit=1")["total"] == initial_purchases + 2
        check("manual threshold pauses before payment, then approval resumes exactly one purchase")

        for width in (375, 768, 1280):
            for path in ("/app", "/app/tasks/new", "/app/payments", "/app/invoices", "/app/policy", "/app/audit"):
                page.goto(base + path, wait_until="networkidle")
                screenshot(path.replace("/", "-"), width)
                assert page.get_by_role("heading", level=1).count() == 1
                assert not page.locator("video").count()
                assert not page.evaluate("[...document.querySelectorAll('nav a')].some(a => a.origin !== location.origin)")
            for slug in ("", "purchase-guide", "policy", "records", "architecture", "implementation"):
                page.goto(docs + "/" + slug, wait_until="networkidle")
                screenshot("docs-" + (slug or "overview"), width)
                assert page.locator(".document h1").count() == 1
                assert not page.evaluate("[...document.querySelectorAll('a')].some(a => a.origin !== location.origin || a.pathname.startsWith('/app'))")
        check("workspace and independent docs routes render at 375/768/1280 without overflow")

        page.goto(base + "/app/tasks/" + first_id, wait_until="networkidle")
        expect(page.get_by_role("button", name="重新整理", exact=True)).to_be_visible()
        context.clear_cookies()
        # Use the app's focus refresh: a pending session request or automatic
        # focus refresh can otherwise remove the button before click dispatch.
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(page.get_by_role("heading", name="登入採購工作區", exact=True)).to_be_visible()
        page.get_by_label("工作區存取碼").fill(code)
        page.get_by_role("button", name="登入工作區", exact=True).click()
        expect(page.get_by_text("已完成", exact=True)).to_be_visible()
        assert page.url.endswith(first_id)
        page.get_by_role("button", name="登出", exact=True).click()
        expect(page.get_by_role("heading", name="登入採購工作區", exact=True)).to_be_visible()
        request("/settings", status=401)
        check("session expiry returns to login and restores the deep-linked case; logout revokes access")
        assert not report["pageErrors"], report["pageErrors"]
        report["ok"] = True
    finally:
        if not report["ok"]:
            page.screenshot(path=str(output / "failure.png"), full_page=True)
        checkpoint()
        browser.close()

print(json.dumps({"ok": report["ok"], "checks": len(report["checks"]), "output": str(output)}, ensure_ascii=False))
