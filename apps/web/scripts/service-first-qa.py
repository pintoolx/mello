"""Local production UI QA: every API call, upload and payment is an intercepted fixture."""
import argparse
import base64
import hashlib
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
                       "allowedSellerIds": ["seller-a", "seller-b"], "allowedNetworks": ["eip155:84532"]},
            "services": services, "discoveryMode": "local_demo"}
tasks, submissions, attachments, edge_tasks = {}, {}, {}, {}
lose_next_create = False
EXPIRED_DRAFT_KEY = "expired-attachment-fixture-0001"
report = {"ok": False, "base": args.base, "viewports": [], "fixtureWrites": [], "downloads": [],
          "mockSettlements": 0, "unexpected": [], "pageErrors": [], "lostResponseRecovery": False,
          "legacyDraftResume": False, "queuedDraftWaitsAutomatically": False, "expiredAttachmentReset": False}
now = "2026-09-06T00:00:00.000Z"
attachment_bytes = "附件只保存，不解析。個股分析、總經分析、加密市場資訊、期貨分析。\n預算上限：999 USDC。\n<script>window.__ATTACHMENT_PARSED__=true</script>".encode("utf-8")


def fulfill(route, value, status=200):
    route.fulfill(status=status, content_type="application/json", body=json.dumps(value, ensure_ascii=False))


def metadata(item):
    return {key: value for key, value in item.items() if key not in ("requestKey", "clientFileId", "contentBase64")}


def make_task(body):
    match = re.fullmatch(r"採購需求：\n([\s\S]+)\n\n預算上限：0\.1 USDC。\n(要開統編發票|不需要統編發票)，不需要 Mello Registry 認證。", body["prompt"])
    assert match and 0 < len(match[1]) <= 1000
    assert "targetCompanyName" not in body and "Example Co." not in body["prompt"]
    assert "__ATTACHMENT_PARSED__" not in body["prompt"]
    selected = next(item for item in services if item["displayName"] in match[1])
    assert body["requirements"] == {"requiresTwInvoice": selected["supportsTwInvoice"], "requiresRegistryCertification": False}
    wrong = next(item for item in services if item["category"] != selected["category"])
    task_id = "00000000-0000-4000-8000-" + str(len(tasks) + 1).zfill(12)
    for attachment_id in body.get("attachmentIds", []):
        assert attachments[attachment_id]["requestKey"] == body["requestKey"]
    return {"taskId": task_id, "prompt": body["prompt"], "status": "WAITING_SELECTION", "createdAt": now, "updatedAt": now,
            "purchaseId": None, "decisionSummary": "服務比較完成；選用並確認前不會付款。", "purchase": None, "error": None, "timeline": [],
            "candidates": [dict(selected, serviceId=selected["id"], eligible=True, matchesRequirements=True,
                                selectionHash="0x" + "a" * 64, reasonCodes=["CANDIDATE_ELIGIBLE"], verificationStatus="UNREVIEWED"),
                           dict(wrong, serviceId=wrong["id"], eligible=False, matchesRequirements=True,
                                selectionHash="0x" + "b" * 64, reasonCodes=["CATEGORY_MISMATCH"], verificationStatus="UNREVIEWED")],
            "control": {"requestKey": body["requestKey"], "requirements": body["requirements"], "selectedService": None, "discoveryQueued": True,
                        "approvalLimitAtomic": None, "expectedPayTo": None, "pendingTerms": None, "approvedAt": None},
            "intent": {"serviceCategory": selected["category"], "serviceQuery": selected["displayName"], "maxAmount": {"atomic": "100000"},
                       "requiresTwInvoice": selected["supportsTwInvoice"], "buyerBusinessId": "12345675", "costCenter": "RESEARCH"}}


def settle_fixture(task, selection):
    selected = next(item for item in services if item["id"] == selection["serviceId"])
    assert selected["category"] == task["intent"]["serviceCategory"] and selection["selectionHash"] == "0x" + "a" * 64
    if task["purchase"]:
        assert task["control"]["selectedService"] == selection
        return
    assert task["status"] == "WAITING_SELECTION"
    report["mockSettlements"] += 1
    task["status"], task["updatedAt"] = "COMPLETED", "2026-09-06T00:00:02.000Z"
    task["control"]["selectedService"] = selection
    invoice = selected["supportsTwInvoice"]
    task["purchase"] = {"purchaseId": task["taskId"], "taskId": task["taskId"], "status": "COMPLETED", "prompt": task["prompt"],
        "selectedService": selected, "expectedAmountAtomic": selected["priceAtomic"], "actualAmountAtomic": selected["priceAtomic"],
        "modes": {"agent": "demo", "payment": "mock", "invoice": "mock", "anchor": "mock"}, "paymentMode": "mock",
        "createdAt": now, "updatedAt": task["updatedAt"], "network": "eip155:84532", "payToAddress": selected["payToAddress"],
        "payment": {"status": "SETTLED", "transactionHash": None}, "paymentAuthorization": {"paymentId": "fixture-" + task["taskId"], "status": "SETTLED"},
        "delivery": {"status": "DELIVERED", "responseBody": {"reportVersion": "market-v1", "serviceId": selected["id"],
            "serviceCategory": selected["category"], "serviceQuery": selected["displayName"], "provider": selected["sellerId"],
            "title": selected["displayName"], "summary": "預設示範研究內容。", "isDemo": True, "paymentMode": "mock",
            "disclaimer": "模擬研究內容，非即時市場資料，亦非投資建議。"}},
        "invoice": {"status": "ISSUED_DEMO" if invoice else "NOT_REQUIRED", "attemptCount": 1 if invoice else 0,
            "invoiceNumber": "DEMO-INV-UI-" + task["taskId"][-6:] if invoice else None, "lastError": None},
        "reconciliation": {"status": "MATCHED"}, "anchors": [], "explorerLinks": {"payment": None, "anchor": None},
        "availableActions": {"retryInvoice": False, "retryAnchor": False, "reconcilePayment": False}}
    task["purchaseId"] = task["taskId"]
    task["timeline"] = ([{"id": task["taskId"], "eventType": "INVOICE_ISSUED", "sequence": 1, "createdAt": task["updatedAt"],
                           "payload": {"status": "ISSUED_DEMO", "attempt": 1, "provider": "MOCK", "previousStatus": "PENDING"}}] if invoice else [])


def guard(route):
    global lose_next_create
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
        match = re.fullmatch(r"/api/v1/tasks/([^/]+)/attachments(?:/([^/]+))?", path)
        if match:
            if match[1] in edge_tasks and not match[2]: return fulfill(route, {"attachments": []})
            task = tasks[match[1]]
            linked = submissions[task["control"]["requestKey"]]["body"].get("attachmentIds", [])
            if match[2]:
                assert match[2] in linked
                item = attachments[match[2]]
                report["downloads"].append(item["id"])
                return fulfill(route, dict(metadata(item), contentBase64=item["contentBase64"]))
            return fulfill(route, {"attachments": [metadata(attachments[item]) for item in linked]})
        task_id = path.rsplit("/", 1)[-1]
        if path.startswith("/api/v1/tasks/") and task_id in edge_tasks: return fulfill(route, edge_tasks[task_id])
        if path.startswith("/api/v1/tasks/") and task_id in tasks: return fulfill(route, tasks[task_id])
    if request.method == "POST" and path == "/api/v1/attachments":
        body = request.post_data_json
        content = base64.b64decode(body["contentBase64"], validate=True)
        assert len(content) == body["sizeBytes"] and content == attachment_bytes
        report["fixtureWrites"].append({"path": path, "body": body})
        existing = next((item for item in attachments.values() if (item["requestKey"], item["clientFileId"]) == (body["requestKey"], body["clientFileId"])), None)
        if existing: return fulfill(route, metadata(existing))
        attachment_id = "11111111-1111-4111-8111-" + str(len(attachments) + 1).zfill(12)
        item = dict(body, id=attachment_id, sha256=hashlib.sha256(content).hexdigest(), createdAt=now)
        attachments[attachment_id] = item
        return fulfill(route, metadata(item), 201)
    if request.method == "POST" and path == "/api/v1/tasks":
        body = request.post_data_json
        report["fixtureWrites"].append({"path": path, "body": body})
        if body["requestKey"] == EXPIRED_DRAFT_KEY:
            return fulfill(route, {"error": {"code": "ATTACHMENT_EXPIRED", "message": "測試附件已過期，這筆申請未建立。"}}, 409)
        previous = submissions.get(body["requestKey"])
        if previous:
            assert body == previous["body"], "Lost response recovery must preserve the entire original request"
            return fulfill(route, {"taskId": previous["taskId"], "discoveryQueued": False, "deduplicated": True, "requestKey": body["requestKey"]})
        task = make_task(body)
        tasks[task["taskId"]] = task
        submissions[body["requestKey"]] = {"taskId": task["taskId"], "body": body}
        if lose_next_create:
            lose_next_create = False
            route.abort("connectionreset")
            return
        return fulfill(route, {"taskId": task["taskId"], "status": "CREATED", "discoveryQueued": True, "deduplicated": False, "requestKey": body["requestKey"]}, 201)
    if request.method == "POST" and re.fullmatch(r"/api/v1/tasks/[^/]+/select", path):
        report["fixtureWrites"].append({"path": path, "body": request.post_data_json})
        task = tasks[path.split("/")[-2]]
        settle_fixture(task, request.post_data_json)
        return fulfill(route, {"taskId": task["taskId"], "status": "COMPLETED"}, 202)
    # In particular /discover and every real payment endpoint are forbidden.
    report["unexpected"].append({"method": request.method, "path": path})
    route.abort()


def new_request(page, service, file_name):
    page.goto(args.base + "/app/tasks/new", wait_until="networkidle")
    field = page.get_by_role("textbox", name="需求說明")
    expect(field).to_be_visible()
    expect(field).to_have_attribute("maxlength", "1000")
    expect(field).to_have_attribute("required", "")
    assert page.locator("#target, #notes, #service-query").count() == 0
    assert page.locator("form textarea").count() == 1
    field.fill("供內部研究使用，請整理主要風險。")
    writes_before = len(report["fixtureWrites"])
    field.press("End")
    field.press("Enter")
    assert field.input_value().endswith("\n") and len(report["fixtureWrites"]) == writes_before
    field.fill("供內部研究使用。\n需要" + service["displayName"] + "與主要風險摘要。")
    page.locator("#requires-invoice").set_checked(service["supportsTwInvoice"])
    page.locator("#requires-certification").uncheck()
    attach = page.get_by_role("button", name="附加文件", exact=True)
    attach.focus()
    expect(attach).to_be_focused()
    with page.expect_file_chooser() as chooser_info:
        attach.press("Enter")
    chooser = chooser_info.value
    assert chooser.is_multiple()
    chooser.set_files({"name": file_name, "mimeType": "text/plain", "buffer": attachment_bytes})
    expect(page.get_by_role("button", name="移除 " + file_name, exact=True)).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")


def complete_request(page, service, width, file_name):
    expect(page.get_by_role("heading", name=service["displayName"], exact=True)).to_be_visible()
    expect(page.get_by_role("heading", name="探索結果 · 選擇服務", exact=True)).to_be_visible()
    expect(page.locator(".procurement-steps li")).to_have_count(3)
    for index, label in enumerate(("提交需求", "選擇服務", "付款與憑證")):
        expect(page.locator(".procurement-steps li").nth(index)).to_contain_text(label)
    expect(page.locator(".procurement-steps [aria-current='step']")).to_contain_text("選擇服務")
    expect(page.get_by_role("button", name=re.compile(r"^(開始探索|Agent 探索|繼續處理申請)$"))).to_have_count(0)
    expect(page.locator(".survey-option")).to_have_count(1)
    expect(page.locator(".survey-option")).to_contain_text("供應商：" + service["sellerDisplayName"])
    expect(page.locator(".survey-option")).to_contain_text("服務：" + service["displayName"])
    task_id = urlparse(page.url).path.rsplit("/", 1)[-1]
    assert tasks[task_id]["purchase"] is None
    with page.expect_download() as download_info:
        page.get_by_role("button", name="下載 " + file_name, exact=True).click()
    download = download_info.value
    assert download.suggested_filename == file_name
    assert Path(download.path()).read_bytes() == attachment_bytes
    assert not page.evaluate("Boolean(window.__ATTACHMENT_PARSED__)")
    page.get_by_role("radio", name="選用 " + service["displayName"], exact=True).check()
    expect(page.get_by_role("button", name="送出採購並開始付款", exact=True)).to_be_enabled()
    if service["id"] == "crypto-market": page.screenshot(path=str(output / f"search-result-{width}.png"), full_page=True)
    before = report["mockSettlements"]
    page.get_by_role("button", name="送出採購並開始付款", exact=True).click()
    expect(page.locator(".procurement-steps [aria-current='step']")).to_contain_text("付款與憑證")
    expect(page.locator(".survey-option")).to_have_count(0)
    assert report["mockSettlements"] == before + 1
    page.get_by_role("tab", name="付款與對帳", exact=True).click()
    expect(page.get_by_role("heading", name="三方對帳", exact=True)).to_be_visible()
    expect(page.locator("#panel-records")).to_contain_text("模擬結算 · 無實際鏈上付款")
    expect(page.locator("#panel-records")).to_contain_text("僅供測試，不具正式發票效力。")
    expect(page.get_by_role("button", name="重試取得發票", exact=True)).to_have_count(0)
    page.get_by_text("查看交付報告", exact=True).click()
    expect(page.locator(".report-content pre")).to_contain_text('"reportVersion": "market-v1"')
    expect(page.locator(".report-content pre")).not_to_contain_text("__ATTACHMENT_PARSED__")
    if service["supportsTwInvoice"]:
        expect(page.locator("#panel-records")).to_contain_text("DEMO-INV-UI-")
        assert tasks[task_id]["purchase"]["invoice"] == {"status": "ISSUED_DEMO", "attemptCount": 1,
            "invoiceNumber": "DEMO-INV-UI-" + task_id[-6:], "lastError": None}
    if service["id"] == "macro-analysis": page.screenshot(path=str(output / f"completed-{width}.png"), full_page=True)
    page.get_by_role("tab", name="活動紀錄", exact=True).click()
    invoice_events = page.locator(".audit-events li").filter(has_text="INVOICE_ISSUED")
    expect(invoice_events).to_have_count(1 if service["supportsTwInvoice"] else 0)
    if service["supportsTwInvoice"]:
        invoice_events.get_by_text("查看紀錄內容", exact=True).click()
        expect(invoice_events.locator("pre")).to_contain_text('"attempt": 1')
        expect(invoice_events.locator("pre")).to_contain_text('"previousStatus": "PENDING"')
    expect(page.locator("#panel-activity")).not_to_contain_text("FAILED_RETRYABLE")


def check_draft_recovery_edges(page):
    """Read-only draft states plus one explicitly failed mock create; no new payment."""
    before = (len(tasks), len(attachments), report["mockSettlements"], len(report["fixtureWrites"]))
    for index, queued in enumerate((False, True)):
        body = {"prompt": "採購需求：\n總經分析\n\n預算上限：0.1 USDC。\n要開統編發票，不需要 Mello Registry 認證。",
                "requestKey": "legacy-draft-fixture-" + str(index),
                "requirements": {"requiresTwInvoice": True, "requiresRegistryCertification": False}}
        task = make_task(body)
        task_id = "99999999-9999-4999-8999-" + str(index + 1).zfill(12)
        task.update(taskId=task_id, status="CREATED", candidates=[], intent=None)
        task["control"]["discoveryQueued"] = queued
        edge_tasks[task_id] = task
        page.goto(args.base + "/app/tasks/" + task_id, wait_until="networkidle")
        expect(page.locator(".procurement-steps li")).to_have_count(3)
        expect(page.locator(".procurement-steps [aria-current='step']")).to_contain_text("提交需求")
        resume = page.get_by_role("button", name="繼續處理申請", exact=True)
        if queued:
            expect(resume).to_have_count(0)
            expect(page.get_by_text("申請已受理，正在尋找符合需求的服務。結果會自動顯示，選用並確認前不會付款。", exact=True)).to_be_visible()
            report["queuedDraftWaitsAutomatically"] = True
        else:
            expect(resume).to_be_visible()
            expect(resume).to_be_enabled()
            resume.focus()
            expect(resume).to_be_focused()
            report["legacyDraftResume"] = True
    assert before == (len(tasks), len(attachments), report["mockSettlements"], len(report["fixtureWrites"]))

    description = "請提供總經分析。\n重點：保留多行原文。\n\n預算上限：999 USDC。\n此為引用，並非本次設定。"
    pending = {"prompt": "採購需求：\n" + description + "\n\n預算上限：0.075123 USDC。\n不需要統編發票，不需要 Mello Registry 認證。",
               "requestKey": EXPIRED_DRAFT_KEY, "attachmentIds": ["88888888-8888-4888-8888-888888888888"],
               "requirements": {"requiresTwInvoice": False, "requiresRegistryCertification": False},
               "approvalLimitAtomic": "30001", "expectedPayTo": "0x" + "2" * 40}
    page.evaluate("(pending) => localStorage.setItem('mello:pending-request', JSON.stringify(pending))", pending)
    page.goto(args.base + "/app/tasks/new", wait_until="networkidle")
    expect(page.get_by_text("有一筆建立結果待確認的申請", exact=True)).to_be_visible()
    expect(page.get_by_role("textbox", name="需求說明")).to_be_disabled()
    expect(page.get_by_role("button", name="重新附檔", exact=True)).to_have_count(0)
    assert len(report["fixtureWrites"]) == before[3]
    page.get_by_role("button", name="找回原申請", exact=True).click()
    expect(page.get_by_text("測試附件已過期，這筆申請未建立。", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name="重新附檔", exact=True)).to_be_enabled()
    assert page.evaluate("JSON.parse(localStorage.getItem('mello:pending-request'))") == pending
    assert (len(tasks), len(attachments), report["mockSettlements"]) == before[:3]
    assert report["fixtureWrites"][before[3]:] == [{"path": "/api/v1/tasks", "body": pending}]

    page.get_by_role("button", name="重新附檔", exact=True).click()
    field = page.get_by_role("textbox", name="需求說明")
    expect(field).to_be_enabled()
    expect(field).to_have_value(description)
    expect(page.locator("#budget")).to_have_value("0.075123")
    expect(page.locator("#requires-invoice")).not_to_be_checked()
    expect(page.locator("#requires-certification")).not_to_be_checked()
    page.get_by_text("付款前控制（選填）", exact=True).click()
    expect(page.locator("#approval-limit")).to_have_value("0.030001")
    expect(page.locator("#expected-pay-to")).to_have_value(pending["expectedPayTo"])
    expect(page.locator(".attachment-list li")).to_have_count(0)
    expect(page.get_by_role("button", name="找回原申請", exact=True)).to_have_count(0)
    expect(page.get_by_role("button", name="重新附檔", exact=True)).to_have_count(0)
    expect(page.get_by_role("button", name="建立申請", exact=True)).to_be_enabled()
    assert page.evaluate("localStorage.getItem('mello:pending-request')") is None
    assert len(report["fixtureWrites"]) == before[3] + 1
    assert (len(tasks), len(attachments), report["mockSettlements"]) == before[:3]
    report["expiredAttachmentReset"] = True
    page.screenshot(path=str(output / "expired-draft-recovered.png"), full_page=True)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        for width in (375, 768, 1280):
            context = browser.new_context(viewport={"width": width, "height": 900}, service_workers="block", accept_downloads=True)
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
            page.goto(args.base + "/app/tasks/new", wait_until="networkidle")
            writes_before = len(report["fixtureWrites"])
            for file, error in [({"name": "oversized.txt", "mimeType": "text/plain", "buffer": b"a" * (2 * 1024 * 1024 + 1)}, "不超過 2 MB"),
                                ({"name": "blocked.exe", "mimeType": "application/octet-stream", "buffer": b"MZ"}, "文件格式須為")]:
                page.locator("#requirement-files").set_input_files(file)
                expect(page.locator("#attachment-error")).to_contain_text(error)
                expect(page.locator(".attachment-list li")).to_have_count(0)
            assert len(report["fixtureWrites"]) == writes_before
            for service in services:
                file_name = f"request-{width}-{service['id']}.txt"
                new_request(page, service, file_name)
                if service["id"] == "macro-analysis": page.screenshot(path=str(output / f"service-search-{width}.png"), full_page=True)
                page.get_by_role("button", name="建立申請", exact=True).click()
                complete_request(page, service, width, file_name)
            report["viewports"].append({"width": width, "fourQueriesWithoutCompany": True, "wrongCategoryHidden": True,
                "separateServiceAndSupplier": True, "threeStepsAutomaticDiscovery": True, "firstAttemptInvoices": True,
                "storedAttachmentByteRoundTrip": True, "invalidAttachmentsRejectedBeforeApi": True})
            if width == 1280:
                service, file_name = services[1], "lost-response-request.txt"
                new_request(page, service, file_name)
                writes_before, tasks_before, settlements_before = len(report["fixtureWrites"]), len(tasks), report["mockSettlements"]
                lose_next_create = True
                page.get_by_role("button", name="建立申請", exact=True).click()
                expect(page.get_by_text("有一筆建立結果待確認的申請", exact=True)).to_be_visible()
                expect(page.get_by_text("暫時無法連線。建立申請時若回應遺失，請用原請求找回，不要另建付款。", exact=True)).to_be_visible()
                expect(page.get_by_role("button", name="重新附檔", exact=True)).to_have_count(0)
                assert len(tasks) == tasks_before + 1 and report["mockSettlements"] == settlements_before
                page.reload(wait_until="networkidle")
                expect(page.get_by_role("button", name="重新附檔", exact=True)).to_have_count(0)
                page.get_by_role("button", name="找回原申請", exact=True).click()
                expect(page.get_by_role("heading", name="探索結果 · 選擇服務", exact=True)).to_be_visible()
                recovered_writes = report["fixtureWrites"][writes_before:]
                uploads = [item for item in recovered_writes if item["path"] == "/api/v1/attachments"]
                creates = [item for item in recovered_writes if item["path"] == "/api/v1/tasks"]
                assert len(uploads) == 1 and len(creates) == 2 and creates[0]["body"] == creates[1]["body"]
                assert len(creates[0]["body"]["attachmentIds"]) == 1
                assert len(tasks) == tasks_before + 1 and report["mockSettlements"] == settlements_before
                complete_request(page, service, "recovery", file_name)
                report["lostResponseRecovery"] = True
                check_draft_recovery_edges(page)
            context.close()
        assert len(tasks) == report["mockSettlements"] == len(attachments) == len(report["downloads"]) == 13
        assert not report["unexpected"] and not report["pageErrors"]
        assert all(task["status"] == "COMPLETED" for task in tasks.values())
        report["ok"] = True
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        browser.close()
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"ok": report["ok"], "output": str(output), "fixtureWrites": len(report["fixtureWrites"]),
                          "mockSettlements": report["mockSettlements"], "unexpected": len(report["unexpected"])}))
