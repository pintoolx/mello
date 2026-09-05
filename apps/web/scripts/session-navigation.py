"""Read-only workspace navigation regression against an isolated local web server.

Start with dummy MELLO_ACCESS_CODE / MELLO_SESSION_SECRET and a local-only
CORE_API_URL. No procurement, policy, invoice, or payment mutations are allowed.

Example (from repository root):
  MELLO_ACCESS_CODE=local-session-test-only MELLO_SESSION_SECRET=local-session-secret-at-least-32-chars \
  WEB_PUBLIC_URL=http://127.0.0.1:4189 CORE_API_URL=http://127.0.0.1:1 \
  python /path/to/webapp-testing/scripts/with_server.py \
    --server "npm run dev --workspace @mello/web -- --hostname 127.0.0.1 --port 4189" \
    --port 4189 -- python apps/web/scripts/session-navigation.py
"""

import json
import os
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


BASE_URL = os.environ.get("MELLO_SESSION_QA_URL", "http://127.0.0.1:4189")
ACCESS_CODE = os.environ.get("MELLO_ACCESS_CODE", "local-session-test-only")
parsed = urlsplit(BASE_URL)
if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost"):
    raise SystemExit("This regression is restricted to an isolated local HTTP server.")

NAVIGATION = [
    ("/app/payments", "付款紀錄"),
    ("/app/invoices", "發票與對帳"),
    ("/app/policy", "採購政策"),
    ("/app/audit", "稽核紀錄"),
    ("/app/settings", "設定"),
    ("/app", "採購申請"),
]

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        for width in (375, 768, 1280):
            context = browser.new_context(viewport={"width": width, "height": 900})
            page = context.new_page()
            page.clock.install()
            requests = []
            violations = []
            script_errors = []
            page.on("pageerror", lambda error: script_errors.append(str(error)))

            def guard(route):
                request = route.request
                target = urlsplit(request.url)
                if target.netloc != parsed.netloc:
                    route.abort()
                    return
                if request.method not in ("GET", "HEAD") and target.path != "/api/session":
                    violations.append(f"{request.method} {target.path}")
                    route.abort()
                    return
                requests.append((request.method, target.path))
                # Read fixtures avoid any dependency on a live backend. Requests
                # without the cookie still reach the real BFF authentication gate.
                if target.path.startswith("/api/v1/") and "mello_session=" in request.headers.get("cookie", ""):
                    route.fulfill(
                        status=503,
                        json={"error": {"message": "隔離測試：後端未連線"}},
                    )
                    return
                route.continue_()

            page.route("**/*", guard)
            page.goto(f"{BASE_URL}/app")
            page.wait_for_load_state("networkidle")
            expect(page.get_by_label("工作區存取碼", exact=True)).to_be_visible()
            assert not any(path.startswith("/api/v1/") for _, path in requests)

            def login():
                page.bring_to_front()
                page.get_by_label("工作區存取碼", exact=True).fill(ACCESS_CODE)
                page.get_by_role("button", name="登入工作區", exact=True).click()
                expect(page.get_by_role("navigation", name="工作區導覽")).to_be_visible()
                # Flush React effects after login even when periodic time is paused.
                page.clock.run_for(100)
                page.wait_for_load_state("networkidle")

            login()
            # Freeze periodic timers while measuring route-induced reads.
            page.clock.pause_at(datetime.now(timezone.utc) + timedelta(seconds=1))
            page.wait_for_load_state("networkidle")
            cookies = {cookie["name"]: cookie for cookie in context.cookies()}
            assert cookies["mello_session"]["httpOnly"] is True
            assert cookies["mello_session"]["sameSite"] == "Strict"
            session_checks = requests.count(("GET", "/api/session"))
            shared_paths = ("/api/v1/settings", "/api/v1/controls", "/api/v1/demo/health")
            shared_reads = {path: requests.count(("GET", path)) for path in shared_paths}
            initial_task_reads = requests.count(("GET", "/api/v1/tasks"))
            page.evaluate("""() => {
                window.sessionScreenFlashes = 0;
                new MutationObserver(() => {
                    if (document.querySelector('.session-screen')) window.sessionScreenFlashes += 1;
                }).observe(document.body, { childList: true, subtree: true });
            }""")

            for pathname, label in NAVIGATION:
                page.get_by_role("navigation", name="工作區導覽").get_by_role("link", name=label, exact=True).click()
                expect(page).to_have_url(f"{BASE_URL}{pathname}")
                page.wait_for_load_state("networkidle")
                expect(page.get_by_role("navigation", name="工作區導覽")).to_be_visible()
                expect(page.get_by_role("link", name=label, exact=True).first).to_have_attribute("aria-current", "page")
                assert requests.count(("GET", "/api/session")) == session_checks
                assert {path: requests.count(("GET", path)) for path in shared_paths} == shared_reads
                assert page.evaluate("window.sessionScreenFlashes") == 0

            # Route-specific lists must still re-fetch when re-entered.
            assert requests.count(("GET", "/api/v1/tasks")) > initial_task_reads, {
                "initial_task_reads": initial_task_reads,
                "after_reentry": requests.count(("GET", "/api/v1/tasks")),
            }

            page.go_back()
            page.wait_for_load_state("networkidle")
            page.go_forward()
            page.wait_for_load_state("networkidle")
            assert requests.count(("GET", "/api/session")) == session_checks
            assert {path: requests.count(("GET", path)) for path in shared_paths} == shared_reads
            assert page.evaluate("window.sessionScreenFlashes") == 0

            # Reload and a second browser tab use the real HTTP-only session.
            page.reload()
            page.wait_for_load_state("networkidle")
            expect(page.get_by_role("navigation", name="工作區導覽")).to_be_visible()
            second_tab = context.new_page()
            second_tab.route("**/*", guard)
            second_tab.goto(f"{BASE_URL}/app/settings")
            second_tab.wait_for_load_state("networkidle")
            expect(second_tab.get_by_role("navigation", name="工作區導覽")).to_be_visible()
            second_tab.close()
            page.bring_to_front()

            # A denied cross-origin logout must not remove the authenticated cookie.
            rejected = context.request.delete(f"{BASE_URL}/api/session", headers={"origin": "https://invalid.example"})
            assert rejected.status == 403
            assert context.request.get(f"{BASE_URL}/api/session").json()["authenticated"] is True

            page.get_by_role("button", name="登出", exact=True).click()
            expect(page.get_by_label("工作區存取碼", exact=True)).to_be_visible()
            assert context.request.get(f"{BASE_URL}/api/v1/settings").status == 401
            page.go_back()
            page.wait_for_load_state("networkidle")
            expect(page.get_by_label("工作區存取碼", exact=True)).to_be_visible()
            expect(page.get_by_role("navigation", name="工作區導覽")).to_have_count(0)
            reads_after_logout = {path: requests.count(("GET", path)) for path in shared_paths}
            page.clock.fast_forward(120_000)
            assert {path: requests.count(("GET", path)) for path in shared_paths} == reads_after_logout

            reads_before_login = {path: requests.count(("GET", path)) for path in shared_paths}
            login()
            # Development Strict Mode may start-and-abort an extra read on mount.
            assert all(requests.count(("GET", path)) > count for path, count in reads_before_login.items()), {
                "before": reads_before_login,
                "after": {path: requests.count(("GET", path)) for path in shared_paths},
                "visibility": page.evaluate("document.visibilityState"),
            }
            context.clear_cookies()
            # Existing useResource focus refresh reaches the real BFF, whose 401
            # must still unmount the workspace under the now-persistent layout.
            page.evaluate("window.dispatchEvent(new Event('focus'))")
            expect(page.get_by_label("工作區存取碼", exact=True)).to_be_visible()
            expect(page.get_by_text("登入已失效，請重新輸入存取碼。既有案件仍保留。", exact=True)).to_be_visible()
            expect(page.get_by_role("navigation", name="工作區導覽")).to_have_count(0)
            page.wait_for_load_state("networkidle")
            reads_after_expiry = {path: requests.count(("GET", path)) for path in shared_paths}
            page.clock.fast_forward(120_000)
            assert {path: requests.count(("GET", path)) for path in shared_paths} == reads_after_expiry
            assert violations == [], violations
            assert script_errors == [], script_errors
            print(json.dumps({"viewport": width, "navigation_session_rechecks": 0, "navigation_shared_resource_rechecks": 0, "route_list_reentry": "fresh GET", "login_flashes": 0, "logout_and_401": "resources stopped", "business_writes": 0}))
            context.close()
    finally:
        browser.close()
