"""Local-only UI regression; Bazaar response states below use browser fixtures.

First runs the existing real local BFF/API/mock-payment workspace regression.
Then checks Bazaar UI state handling. This does not prove live seller indexing.
"""
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright

base = os.environ["MELLO_E2E_URL"].rstrip("/")
assert urlparse(base).hostname in ("localhost", "127.0.0.1"), "Local tests only"
subprocess.run([sys.executable, str(Path(__file__).with_name("workspace-e2e.py"))], check=True)
output = Path(os.environ["MELLO_E2E_OUTPUT"])
report = {"fixtureDiscovery": True, "checks": [], "errors": []}
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    page.on("pageerror", lambda err: report["errors"].append(str(err)))
    page.goto(base + "/app", wait_until="networkidle")
    page.get_by_label("工作區存取碼").fill(os.environ["MELLO_ACCESS_CODE"])
    page.get_by_role("button", name="登入工作區", exact=True).click()
    expect(page.get_by_role("heading", name="登入採購工作區")).not_to_be_visible()
    page.goto(base + "/app/policy", wait_until="networkidle")
    expect(page.get_by_role("heading", name="Bazaar 服務發現")).to_be_visible()
    expect(page.get_by_text("尚未審核", exact=True).first).to_be_visible()
    report["checks"].append("existing service list does not claim seeded sellers are verified")
    button = page.get_by_role("button", name="查詢 Bazaar", exact=True)
    expect(button).to_be_visible()
    page.route("**/api/v1/registry/discovery", lambda route: route.fulfill(status=503, json={"error": {"message": "Bazaar 暫時無法查詢；未切換至本地服務。"}}))
    button.click()
    expect(page.get_by_text("Bazaar 暫時無法查詢；未切換至本地服務。", exact=True)).to_be_visible()
    expect(button).to_be_enabled()
    report["checks"].append("discovery failure is recoverable and has no local purchasing fallback")
    page.unroute("**/api/v1/registry/discovery")
    empty = {"fetchedAt": "2026-09-05T00:00:00Z", "partialResults": False, "discoveredResourceCount": 0,
             "unregisteredResourceCount": 0, "assessments": []}
    pending = []
    page.route("**/api/v1/registry/discovery", lambda route: pending.append(route))
    button.click()
    expect(page.get_by_role("button", name="查詢中…", exact=True)).to_be_disabled()
    expect(page.get_by_text("正在查詢公共目錄，認證與白名單維持原狀。", exact=True)).to_be_visible()
    assert len(pending) == 1
    pending[0].fulfill(json=empty)
    expect(page.get_by_text("Bazaar 尚未找到符合的服務。", exact=False)).to_be_visible()
    report["checks"].append("loading prevents duplicate queries; empty catalog explains indexing")
    page.unroute("**/api/v1/registry/discovery")
    found = {**empty, "partialResults": True, "discoveredResourceCount": 2, "unregisteredResourceCount": 1,
             "assessments": [{"serviceId": "credit-report-b", "listed": True, "verification": {"status": "VERIFIED"}, "reasonCodes": []}]}
    page.route("**/api/v1/registry/discovery", lambda route: route.fulfill(json=found))
    button.click()
    expect(page.get_by_text("人工範圍審核通過", exact=True)).to_be_visible()
    expect(page.get_by_text("結果不完整", exact=False)).to_be_visible()
    report["checks"].append("listing, manual review and incomplete results are distinct")
    for width in (375, 768, 1280):
        page.set_viewport_size({"width": width, "height": 900})
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "page horizontal overflow"
        page.screenshot(path=str(output / f"bazaar-policy-{width}.png"), full_page=True)
    report["checks"].append("policy UI fits mobile, tablet and desktop without redesign")
    page.keyboard.press("Tab")
    button.focus()
    assert button.evaluate("element => document.activeElement === element")
    focus = button.evaluate("element => ({outline:getComputedStyle(element).outlineStyle,shadow:getComputedStyle(element).boxShadow,height:element.getBoundingClientRect().height})")
    assert focus["outline"] != "none" or focus["shadow"] != "none", "visible keyboard focus required"
    assert focus["height"] >= 40, "touch target height"
    button.press("Enter")
    expect(button).to_be_enabled()
    report["checks"].append("keyboard activation, visible focus and touch target")
    # Registry mutations stay outside the shared-code browser BFF.
    res = context.request.post(base + "/api/v1/registry/services/credit-report-b/verify", data={}, headers={"origin": base})
    assert res.status == 404
    report["checks"].append("shared-code session cannot issue registry certifications")
    assert not report["errors"], report["errors"]
    context.close()
    browser.close()
(output / "bazaar-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
