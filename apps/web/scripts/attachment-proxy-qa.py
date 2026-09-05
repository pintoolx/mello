"""Real local Next BFF auth/limits checks against a loopback-only fixture upstream.

Run Web on 3046 with the local fixture env described in docs/service-first-catalog.md.
Never contacts deployed services or uses a real workspace credential.
"""
import base64
import hashlib
import hmac
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3046"
SECRET = "local-attachment-proxy-session-fixture-only"
API_KEY = "local-attachment-proxy-api-fixture-only"
TASK_ID = "ce3316b0-53c8-4bfb-9f81-0c2eb587cf01"
FILE_ID = "1033b1cd-e0c7-466e-beb4-a226f72c5b85"
calls = []
stored = {}

class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, value, status=200):
        encoded = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_POST(self):
        assert self.headers.get("x-mello-api-key") == API_KEY
        calls.append(self.path)
        assert self.path == "/api/v1/attachments"
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        content = base64.b64decode(body["contentBase64"])
        assert len(content) == body["sizeBytes"]
        stored.update(id=FILE_ID, fileName=body["fileName"], mediaType=body["mediaType"],
                      sizeBytes=len(content), sha256=hashlib.sha256(content).hexdigest(),
                      createdAt="2026-09-06T00:00:00.000Z", contentBase64=body["contentBase64"])
        self.reply({key: value for key, value in stored.items() if key != "contentBase64"}, 201)

    def do_GET(self):
        assert self.headers.get("x-mello-api-key") == API_KEY
        calls.append(self.path)
        if self.path == f"/api/v1/tasks/{TASK_ID}/attachments":
            self.reply({"attachments": [{key: value for key, value in stored.items() if key != "contentBase64"}]})
        elif self.path == f"/api/v1/tasks/{TASK_ID}/attachments/{FILE_ID}":
            self.reply(stored)
        else:
            self.reply({}, 404)

def b64url(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")

server = ThreadingHTTPServer(("127.0.0.1", 3047), Fixture)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    payload = b64url(json.dumps({"exp": int(time.time() * 1000) + 600_000, "nonce": "local-fixture"}).encode())
    token = payload + "." + b64url(hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).digest())
    data = "需求附件，完整保存但不解析。".encode() * 4000
    body = {"requestKey": TASK_ID, "clientFileId": FILE_ID, "fileName": "需求.txt", "mediaType": "text/plain",
            "sizeBytes": len(data), "contentBase64": base64.b64encode(data).decode()}
    with sync_playwright() as playwright:
        request = playwright.request.new_context(base_url=BASE)
        assert request.post("/api/v1/attachments", data=body).status == 401
        request.dispose()
        request = playwright.request.new_context(base_url=BASE, extra_http_headers={"Cookie": "mello_session=" + token, "Origin": BASE})
        assert request.post("/api/v1/attachments", data=body, headers={"Origin": "https://untrusted.example"}).status == 403
        assert request.post("/api/v1/tasks", data={"prompt": "x" * 70000}).status == 413
        assert request.post("/api/v1/attachments", data={"contentBase64": "x" * (3 * 1024 * 1024)}).status == 413
        assert request.post("/api/v1/attachments/private", data={}).status == 404
        assert calls == [], calls
        upload = request.post("/api/v1/attachments", data=body)
        assert upload.status == 201, upload.text()
        assert upload.json()["sha256"] == hashlib.sha256(data).hexdigest()
        listing = request.get(f"/api/v1/tasks/{TASK_ID}/attachments")
        assert listing.status == 200 and "contentBase64" not in listing.text()
        download = request.get(f"/api/v1/tasks/{TASK_ID}/attachments/{FILE_ID}")
        assert download.status == 200
        assert download.headers["cache-control"] == "no-store"
        assert download.headers["x-content-type-options"] == "nosniff"
        assert base64.b64decode(download.json()["contentBase64"]) == data
        assert len(calls) == 3, calls
        request.dispose()
    print(json.dumps({"ok": True, "authAndOrigin": True, "boundedUpload": True, "downloadBytes": len(data), "upstreamCalls": len(calls)}))
finally:
    server.shutdown()
    server.server_close()
