"""Recheck an updated live UI using an existing successful payment journal.

No task creation, approval, retry, freeze, reset, or payment is permitted.
Only login/logout session writes are allowed; API reads retain existing records.
"""
import hashlib
import json
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

base = os.environ["WEB_PUBLIC_URL"].rstrip("/")
docs = os.environ["MELLO_E2E_DOCS_URL"].rstrip("/")
assert base.startswith("https://") and docs.startswith("https://")
original = json.loads(Path(os.environ.get("MELLO_LIVE_JOURNAL", "/tmp/mello-workspace-live/report.json")).read_text())
assert original["ok"] and original["live"] and len(original["purchases"]) == 2
output = Path(os.environ.get("MELLO_READONLY_OUTPUT", "/tmp/mello-workspace-readonly"))
output.mkdir(parents=True, exist_ok=True)
repo = Path(__file__).resolve().parents[3]
report = {"ok": False, "readOnly": True, "checks": [], "pageErrors": [], "blockedWrites": []}

with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    expect.set_options(timeout=15000)
    page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))

    def guard(route):
        request = route.request
        session_write = request.url == base + "/api/session" and request.method in ("POST", "DELETE")
        if request.method not in ("GET", "HEAD", "OPTIONS") and not session_write:
            report["blockedWrites"].append({"method": request.method, "url": request.url})
            route.abort("blockedbyclient")
        else:
            route.continue_()

    page.route("**/api/**", guard)

    def get(path):
        response = context.request.get(base + "/api/v1" + path)
        assert response.ok, (path, response.status)
        return response.json()

    def check(name):
        report["checks"].append(name)
        print(name, flush=True)

    def capture(name, width):
        page.set_viewport_size({"width": width, "height": 900})
        page.wait_for_timeout(150)
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), (name, width)
        page.screenshot(path=str(output / f"{name}-{width}.png"), full_page=True)

    try:
        page.goto(base + "/app", wait_until="networkidle")
        expect(page.get_by_role("heading", name="登入採購工作區")).to_be_visible()
        capture("login", 1280)
        page.get_by_label("工作區存取碼").fill(os.environ["MELLO_ACCESS_CODE"])
        page.get_by_role("button", name="登入工作區", exact=True).click()
        expect(page.get_by_role("heading", name="採購申請", exact=True)).to_be_visible()
        assert page.locator(".workspace-product").count() == 0
        health = get("/demo/health")
        assert health["status"] == "ok"
        assert health["checks"]["contract"]["details"]["address"].lower() == original["registry"].lower()
        before = get("/purchases?limit=1")["total"]
        assert before == original["initialPurchaseCount"] + 2
        assert get("/controls")["paymentsFrozen"] is False
        check("updated header, session login, BFF health and retained purchase count")

        for app, origin in (("web", base), ("docs", docs)):
            for filename in ("favicon.ico", "icon.png", "icon.svg", "apple-icon.png"):
                response = context.request.get(origin + "/" + filename)
                assert response.status == 200, (app, filename, response.status)
                expected = (repo / "apps" / app / "src" / "app" / filename).read_bytes()
                assert hashlib.sha256(response.body()).digest() == hashlib.sha256(expected).digest(), (app, filename)
        check("all eight deployed icon files exactly match the merged source")

        for item in original["purchases"]:
            current = get("/purchases/" + item["purchaseId"])
            assert current["status"] == "COMPLETED"
            assert current["payment"]["transactionHash"] == item["paymentHash"]
            assert current["invoice"]["status"] == "ISSUED_DEMO"
            assert current["reconciliation"]["status"] == "MATCHED"
            page.goto(base + "/app/tasks/" + item["taskId"], wait_until="networkidle")
            expect(page.get_by_text("已完成", exact=True)).to_be_visible()
            page.get_by_role("tab", name="付款與對帳", exact=True).click()
            expect(page.get_by_role("link", name=item["paymentHash"] + " ↗", exact=True)).to_have_attribute("href", "https://sepolia.basescan.org/tx/" + item["paymentHash"])
            for width in (375, 768, 1280):
                capture("existing-" + item["taskId"], width)
        check("both original paid cases still render Demo invoices, reconciliation and real transaction links")

        for width in (375, 768, 1280):
            page.set_viewport_size({"width": width, "height": 900})
            for path in ("/app", "/app/tasks/new", "/app/payments", "/app/invoices", "/app/policy", "/app/audit"):
                page.goto(base + path, wait_until="networkidle")
                capture(path.replace("/", "-"), width)
                assert page.get_by_role("heading", level=1).count() == 1
                assert not page.locator("video").count()
                assert not page.evaluate("[...document.querySelectorAll('nav a')].some(a => a.origin !== location.origin)")
            for slug in ("", "purchase-guide", "policy", "records", "architecture", "implementation"):
                page.goto(docs + "/" + slug, wait_until="networkidle")
                capture("docs-" + (slug or "overview"), width)
                assert page.locator(".document h1").count() == 1
                assert not page.evaluate("[...document.querySelectorAll('a')].some(a => a.origin !== location.origin || a.pathname.startsWith('/app'))")
        check("workspace and independent docs remain responsive at 375/768/1280")

        assert get("/purchases?limit=1")["total"] == before
        assert get("/controls")["paymentsFrozen"] is False
        page.goto(base + "/app", wait_until="networkidle")
        page.get_by_role("button", name="登出", exact=True).click()
        expect(page.get_by_role("heading", name="登入採購工作區")).to_be_visible()
        assert context.request.get(base + "/api/v1/settings").status == 401
        assert not report["pageErrors"] and not report["blockedWrites"]
        check("logout rejects access; no purchase or payment mutation occurred")
        report.update({"ok": True, "purchaseCountBefore": before, "purchaseCountAfter": before})
    finally:
        if not report["ok"]:
            page.screenshot(path=str(output / "failure.png"), full_page=True)
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        browser.close()

print(json.dumps({"ok": report["ok"], "readOnly": True, "checks": len(report["checks"]), "output": str(output)}))
