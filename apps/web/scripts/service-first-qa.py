"""Local production UI QA. All API data and mutations are intercepted fixtures."""
import argparse
import json
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--base", default="http://127.0.0.1:3046")
parser.add_argument("--output-dir", help="Evidence parent directory; defaults to a fresh temporary directory")
args = parser.parse_args()
assert urlparse(args.base).hostname == "127.0.0.1"
output = (Path(args.output_dir) if args.output_dir else Path(tempfile.mkdtemp(prefix="mello-service-first-qa-"))) / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
output.mkdir(parents=True, exist_ok=False)
catalog = [
    ("stock-analysis", "stock_analysis", "個股分析", "seller-a", "會飛分析師", False),
    ("macro-analysis", "macro_analysis", "總經分析", "seller-b", "mello資本", True),
    ("crypto-market", "crypto_market", "加密市場資訊", "seller-b", "mello資本", True),
    ("futures-analysis", "futures_analysis", "期貨分析", "seller-a", "會飛分析師", False),
]
services = [{"id": sid, "category": category, "displayName": name, "sellerId": seller,
             "sellerDisplayName": brand, "sellerLegalName": "Legacy legal identity", "active": True,
             "description": name + " Demo 範例；非即時行情或投資建議。", "supportsTwInvoice": invoice,
             "priceAtomic": "50000" if invoice else "40000", "payToAddress": "0x" + "1" * 40,
             "verification": {"status": "UNREVIEWED", "expiresAt": None}} for sid, category, name, seller, brand, invoice in catalog]
settings = {"company": {"legalName": "UI Fixture Corp.", "businessId": "12345675", "email": "fixture@example.test", "defaultCostCenter": "RESEARCH"},
            "policy": {"version": 1, "perTxLimitAtomic": "100000", "dailyLimitAtomic": "1000000", "requireTwInvoice": False,
                       "allowedSellerIds": ["seller-a", "seller-b"], "allowedNetworks": ["eip155:84532"]}, "services": services,
            "discoveryMode": "local_demo"}
tasks = {}
report = {"ok": False, "base": args.base, "viewports": [], "fixtureWrites": [], "unexpected": [], "pageErrors": []}
now = "2026-09-06T00:00:00.000Z"

def fulfill(route, value, status=200):
    route.fulfill(status=status, content_type="application/json", body=json.dumps(value, ensure_ascii=False))

def guard(route):
    request = route.request
    parsed = urlparse(request.url)
    if parsed.netloc != urlparse(args.base).netloc:
        report["unexpected"].append({"method": request.method, "path": parsed.path})
        route.abort()
        return
    path = parsed.path
    if not path.startswith("/api/"):
        route.continue_()
        return
    if request.method == "GET":
        if path == "/api/session": return fulfill(route, {"authenticated": True, "configured": True})
        if path == "/api/v1/settings": return fulfill(route, settings)
        if path == "/api/v1/controls": return fulfill(route, {"paymentsFrozen": False, "updatedAt": None})
        if path == "/api/v1/demo/health": return fulfill(route, {"modes": {"payment": "mock", "agent": "demo"}, "checks": {}})
        if path == "/api/v1/tasks": return fulfill(route, {"items": list(tasks.values()), "total": len(tasks), "limit": 20, "offset": 0})
        task_id = path.rsplit("/", 1)[-1]
        if path.startswith("/api/v1/tasks/") and task_id in tasks: return fulfill(route, tasks[task_id])
    if request.method == "POST" and path == "/api/v1/tasks":
        body = request.post_data_json
        report["fixtureWrites"].append({"path": path, "body": body})
        assert "targetCompanyName" not in body and "Example Co." not in body["prompt"]
        query = body["prompt"].split("\n")[0].removeprefix("搜尋服務：")
        selected = next(item for item in services if item["displayName"] == query)
        task_id = "00000000-0000-4000-8000-" + str(len(tasks) + 1).zfill(12)
        task = {"taskId": task_id, "prompt": body["prompt"], "status": "CREATED", "createdAt": now, "updatedAt": now,
                "purchaseId": None, "decisionSummary": None, "purchase": None, "error": None, "timeline": [], "candidates": [],
                "control": {"requirements": body["requirements"], "selectedService": None},
                "intent": {"serviceCategory": selected["category"], "serviceQuery": query, "maxAmount": {"atomic": "100000"},
                           "requiresTwInvoice": False, "buyerBusinessId": "12345675", "costCenter": "RESEARCH"}}
        tasks[task_id] = task
        return fulfill(route, {"taskId": task_id}, 201)
    if request.method == "POST" and path.endswith("/discover"):
        task = tasks[path.split("/")[-2]]
        report["fixtureWrites"].append({"path": path})
        selected = next(item for item in services if item["category"] == task["intent"]["serviceCategory"])
        wrong = next(item for item in services if item["category"] != selected["category"])
        task["status"] = "WAITING_SELECTION"
        task["updatedAt"] = "2026-09-06T00:00:01.000Z"
        task["candidates"] = [dict(selected, serviceId=selected["id"], eligible=True, matchesRequirements=True,
                                    selectionHash="0x" + "a" * 64, reasonCodes=["CANDIDATE_ELIGIBLE"], verificationStatus="UNREVIEWED"),
                              dict(wrong, serviceId=wrong["id"], eligible=False, matchesRequirements=True,
                                   selectionHash="0x" + "b" * 64, reasonCodes=["CATEGORY_MISMATCH"], verificationStatus="UNREVIEWED")]
        return fulfill(route, {"taskId": task["taskId"], "status": "WAITING_SELECTION"})
    report["unexpected"].append({"method": request.method, "path": path})
    route.abort()

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        for width in (375, 768, 1280):
            context = browser.new_context(viewport={"width": width, "height": 900}, service_workers="block")
            context.route("**/*", guard)
            page = context.new_page()
            page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
            page.goto(args.base + "/app/vendors", wait_until="networkidle")
            expect(page.get_by_role("heading", name="供應商", exact=True)).to_be_visible()
            expect(page.locator(".records-table tbody tr")).to_have_count(4)
            assert page.locator(".records-table th").all_text_contents()[:2] == ["服務", "供應商"]
            for service in services:
                row = page.locator(".records-table tbody tr").filter(has_text=service["displayName"])
                expect(row.locator("td").nth(0)).to_contain_text(service["displayName"])
                expect(row.locator("td").nth(1)).to_have_text(service["sellerDisplayName"])
                expect(row).to_contain_text("尚未審核")
            assert "Legacy legal identity" not in page.locator(".records-table").inner_text()
            page.screenshot(path=str(output / f"vendors-{width}.png"), full_page=True)
            search = page.get_by_role("searchbox")
            search.fill("會飛分析師")
            expect(page.locator(".records-table tbody tr")).to_have_count(2)
            search.fill("不存在的服務")
            expect(page.get_by_role("heading", name="沒有符合條件的供應商")).to_be_visible()
            for service in services:
                page.goto(args.base + "/app/tasks/new", wait_until="networkidle")
                field = page.get_by_role("combobox", name="搜尋服務")
                expect(field).to_be_visible()
                assert page.locator("#target").count() == 0 and "查詢企業名稱" not in page.locator("form").inner_text()
                assert page.locator("#service-search-examples option").count() == 4
                field.fill(service["displayName"])
                page.locator("#requires-invoice").uncheck()
                page.locator("#requires-certification").uncheck()
                expect(page.get_by_role("button", name="建立申請", exact=True)).to_be_enabled()
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                if service["id"] == "macro-analysis": page.screenshot(path=str(output / f"service-search-{width}.png"), full_page=True)
                field.press("Enter")
                expect(page.get_by_role("heading", name=service["displayName"], exact=True)).to_be_visible()
                page.get_by_role("button", name="開始探索", exact=True).click()
                expect(page.get_by_role("heading", name="探索結果 · 選擇服務", exact=True)).to_be_visible()
                expect(page.locator(".survey-option")).to_have_count(1)
                expect(page.locator(".survey-option")).to_contain_text("供應商：" + service["sellerDisplayName"])
                expect(page.locator(".survey-option")).to_contain_text("服務：" + service["displayName"])
                page.get_by_role("radio", name="選用 " + service["displayName"], exact=True).check()
                expect(page.get_by_role("button", name="送出採購並開始付款", exact=True)).to_be_enabled()
                # Do not click purchase; this test never authorizes a payment, even mocked.
                if service["id"] == "crypto-market": page.screenshot(path=str(output / f"search-result-{width}.png"), full_page=True)
            report["viewports"].append({"width": width, "fourQueriesWithoutCompany": True, "wrongCategoryHidden": True, "separateServiceAndSupplier": True})
            context.close()
        assert len(report["fixtureWrites"]) == 24
        assert not report["unexpected"] and not report["pageErrors"]
        report["ok"] = True
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        browser.close()
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"ok": report["ok"], "output": str(output), "fixtureWrites": len(report["fixtureWrites"]), "unexpected": len(report["unexpected"])}))
