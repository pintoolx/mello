"""Exercise automatic GET refresh using local Playwright fixtures and fake time.

Use the same isolated dummy-session server as session-navigation.py.
Business mutations and non-local requests are blocked by the browser harness.
"""

import json
import os
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


BASE_URL = os.environ.get("MELLO_SESSION_QA_URL", "http://127.0.0.1:4189")
ACCESS_CODE = os.environ.get("MELLO_ACCESS_CODE", "local-session-test-only")
parsed = urlsplit(BASE_URL)
if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost"):
    raise SystemExit("This regression is restricted to an isolated local HTTP server.")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        counts = {}
        mutations = []
        errors = []
        pending = []
        hold_tasks = False
        fail_tasks = False
        version = 1
        company_name = "隔離測試公司"
        session_stage = "error"
        session_reads = []
        session_writes = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.clock.install()

        def task_list():
            return {
                "items": [{
                    "taskId": "00000000-0000-4000-8000-000000000001",
                    "prompt": f"自動更新版本 {version}",
                    "status": "COMPLETED",
                    "createdAt": "2026-09-06T00:00:00.000Z",
                    "updatedAt": "2026-09-06T00:00:00.000Z",
                    "purchaseId": None,
                }],
                "total": 1, "limit": 20, "offset": 0,
            }

        def guard(route):
            request = route.request
            target = urlsplit(request.url)
            if target.netloc != parsed.netloc:
                route.abort()
                return
            if request.method not in ("GET", "HEAD") and target.path != "/api/session":
                mutations.append(f"{request.method} {target.path}")
                route.abort()
                return
            if target.path == "/api/session":
                if request.method == "GET":
                    session_reads.append(session_stage)
                    if session_stage == "error":
                        route.fulfill(status=503, json={"error": {"message": "隔離登入讀取暫時失敗"}})
                        return
                    if session_stage == "unconfigured":
                        route.fulfill(json={"configured": False, "authenticated": False})
                        return
                else:
                    session_writes.append(request.method)
            if target.path.startswith("/api/v1/"):
                counts[target.path] = counts.get(target.path, 0) + 1
                if target.path == "/api/v1/tasks":
                    if hold_tasks:
                        pending.append(route)
                    elif fail_tasks:
                        route.fulfill(status=503, json={"error": {"message": "隔離讀取暫時失敗"}})
                    else:
                        route.fulfill(json=task_list())
                elif target.path == "/api/v1/settings":
                    route.fulfill(json={"company": {
                        "legalName": company_name, "businessId": "12345678",
                        "defaultCostCenter": "TEST", "email": "test@example.invalid",
                    }, "policy": None, "services": []})
                elif target.path == "/api/v1/controls":
                    route.fulfill(json={"paymentsFrozen": False, "updatedAt": None})
                elif target.path == "/api/v1/demo/health":
                    route.fulfill(json={"modes": {"payment": "mock", "invoice": "mock"}})
                else:
                    route.fulfill(status=503, json={"error": {"message": "未使用的隔離資源"}})
                return
            route.continue_()

        page.route("**/*", guard)
        page.goto(f"{BASE_URL}/app")
        page.wait_for_load_state("networkidle")
        expect(page.get_by_text("隔離登入讀取暫時失敗", exact=True)).to_be_visible()
        expect(page.get_by_label("工作區存取碼", exact=True)).to_have_count(0)
        initial_session_reads = len(session_reads)
        session_stage = "unconfigured"
        page.clock.fast_forward(15_100)
        expect(page.get_by_text("尚未設定登入環境", exact=True)).to_be_visible()
        assert len(session_reads) == initial_session_reads + 1
        assert session_writes == []
        session_stage = "ready"
        page.clock.fast_forward(15_100)
        expect(page.get_by_label("工作區存取碼", exact=True)).to_be_visible()
        assert len(session_reads) == initial_session_reads + 2
        assert session_writes == []
        page.get_by_label("工作區存取碼", exact=True).fill(ACCESS_CODE)
        page.get_by_role("button", name="登入工作區", exact=True).click()
        expect(page.get_by_text("自動更新版本 1", exact=True)).to_be_visible()
        page.wait_for_load_state("networkidle")
        authenticated_session_reads = len(session_reads)
        task_reads = counts["/api/v1/tasks"]
        health_reads = counts["/api/v1/demo/health"]

        version = 2
        page.clock.fast_forward(15_100)
        expect(page.get_by_text("自動更新版本 2", exact=True)).to_be_visible()
        assert counts["/api/v1/tasks"] == task_reads + 1
        assert counts["/api/v1/demo/health"] == health_reads
        page.clock.fast_forward(45_100)
        page.wait_for_load_state("networkidle")
        assert counts["/api/v1/demo/health"] == health_reads + 1

        # Hidden/offline pages retain data without issuing periodic requests.
        page.evaluate("""() => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
            document.dispatchEvent(new Event('visibilitychange'));
        }""")
        reads_before_pause = dict(counts)
        page.clock.fast_forward(120_000)
        assert counts == reads_before_pause
        page.evaluate("""() => {
            Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
            Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
            document.dispatchEvent(new Event('visibilitychange'));
            window.dispatchEvent(new Event('offline'));
        }""")
        page.clock.fast_forward(120_000)
        assert counts == reads_before_pause
        version = 3
        page.evaluate("""() => {
            Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
            window.dispatchEvent(new Event('online'));
        }""")
        expect(page.get_by_text("自動更新版本 3", exact=True)).to_be_visible()
        page.wait_for_load_state("networkidle")

        # A focus storm during a held request must never overlap or flash loading.
        hold_tasks = True
        before_focus = counts["/api/v1/tasks"]
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        page.wait_for_timeout(100)
        assert len(pending) == 1
        page.evaluate("() => { for (let i = 0; i < 6; i++) window.dispatchEvent(new Event('focus')); }")
        page.wait_for_timeout(100)
        assert counts["/api/v1/tasks"] == before_focus + 1
        expect(page.get_by_text("自動更新版本 3", exact=True)).to_be_visible()
        expect(page.get_by_text("正在讀取採購申請…", exact=True)).to_have_count(0)
        version = 4
        hold_tasks = False
        pending.pop().fulfill(json=task_list())
        expect(page.get_by_text("自動更新版本 4", exact=True)).to_be_visible()

        # Failure keeps the last good row, then recovers without a retry button.
        fail_tasks = True
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(page.get_by_text("隔離讀取暫時失敗", exact=True)).to_be_visible()
        expect(page.get_by_text("自動更新版本 4", exact=True)).to_be_visible()
        reads_after_failure = counts["/api/v1/tasks"]
        page.clock.fast_forward(5_000)
        assert counts["/api/v1/tasks"] == reads_after_failure
        fail_tasks = False
        version = 5
        page.clock.fast_forward(10_100)
        expect(page.get_by_text("自動更新版本 5", exact=True)).to_be_visible()
        expect(page.get_by_text("隔離讀取暫時失敗", exact=True)).to_have_count(0)

        # Settings background reads must not replace a person's unsaved draft.
        page.wait_for_load_state("networkidle")
        shared_paths = ("/api/v1/settings", "/api/v1/controls", "/api/v1/demo/health")
        reads_before_navigation = {path: counts[path] for path in shared_paths}
        page.get_by_role("navigation", name="工作區導覽").get_by_role("link", name="設定", exact=True).click()
        expect(page.locator("#company-name")).to_have_value(company_name)
        page.wait_for_load_state("networkidle")
        assert {path: counts[path] for path in shared_paths} == reads_before_navigation
        page.locator("#company-name").fill("正在編輯，不能被背景更新清空")
        company_name = "伺服器背景更新的新公司名稱"
        settings_before_refresh = counts["/api/v1/settings"]
        page.clock.fast_forward(15_100)
        expect(page.locator(".workspace-organization")).to_contain_text(company_name)
        expect(page.locator("#company-name")).to_have_value("正在編輯，不能被背景更新清空")
        expect(page.get_by_text("有尚未儲存的變更", exact=True)).to_be_visible()
        assert counts["/api/v1/settings"] == settings_before_refresh + 1
        assert len(session_reads) == authenticated_session_reads
        assert session_writes == ["POST"]
        assert mutations == [], mutations
        assert errors == [], errors
        print(json.dumps({
            "regular_refresh_ms": 15_000,
            "health_refresh_ms": 60_000,
            "hidden_and_offline": "paused",
            "focus_storm": "single-flight",
            "background_loading_flash": False,
            "error_recovery": "automatic",
            "session_get_error_and_unconfigured": "automatic recovery",
            "authenticated_session_rechecks": 0,
            "navigation_shared_resource_rechecks": 0,
            "settings_draft": "preserved",
            "business_writes": 0,
        }))
    finally:
        browser.close()
