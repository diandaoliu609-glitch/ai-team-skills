"""在完全隔离的本地假数据页面上用真实 Chrome 验证 Dashboard 严格 CSP。

仅验证视觉呈现，不作为 R3 数据真实性证据；禁止连接生产 8787 或调用模型。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1] / "dashboard"
PROBE_JS = r"""
window.addEventListener("securitypolicyviolation", event => {
  window.__cspViolations = (window.__cspViolations || []).concat(event.violatedDirective);
});
setTimeout(() => {
  const checks = {};
  try {
    const track = document.querySelector(".plain-guide-track");
    const snapshot = document.querySelector(".plain-guide-progress-snapshot");
    checks.staticProgress = !!snapshot && track.clientWidth > 0 &&
      Math.abs(snapshot.getBoundingClientRect().width / track.clientWidth - 0.6111) < 0.02;
    document.getElementById("detail-panel").hidden = false;
    renderComponents({ demand: 65, momentum: 80, supply_gap: 50 });
    const rect = document.querySelector(".component-fill");
    checks.dynamicBar = !!rect && rect.getAttribute("width") === "65" && rect.getBBox().width === 65 &&
      getComputedStyle(rect).fill !== "none";
    renderHistory([{ scores: { rank: 25 } }, { scores: { rank: 85 } }]);
    const line = document.querySelector(".history-line");
    const dot = document.querySelector(".history-dot");
    checks.historyLine = !!line && getComputedStyle(line).stroke === getComputedStyle(rect).fill;
    checks.historyDot = !!dot && getComputedStyle(dot).fill !== "none" &&
      getComputedStyle(dot).fill !== getComputedStyle(line).stroke;
    checks.noStyleCspViolation = !(window.__cspViolations || []).some(
      value => value.startsWith("style-src"));
  } catch (error) {
    checks.exception = String(error).slice(0, 120);
  }
  const result = document.createElement("pre");
  result.id = "__radar_csp_probe";
  result.textContent = JSON.stringify(checks);
  document.body.append(result);
}, 500);
"""


class Handler(BaseHTTPRequestHandler):
    requests: list[tuple[str, str]] = []

    def log_message(self, *_args: object) -> None:
        pass

    def _respond(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "connect-src 'self'; img-src 'self' data:; object-src 'none'",
        )
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        self.requests.append(("GET", path))
        if path == "/":
            html = (ROOT / "index.html").read_text(encoding="utf-8")
            html = html.replace(
                "</body>", '<script src="/__probe.js" defer></script></body>'
            )
            return self._respond(200, html.encode(), "text/html; charset=utf-8")
        if path in ("/styles.css", "/app.js", "/i18n.js"):
            mime = "text/css" if path.endswith(".css") else "text/javascript"
            return self._respond(200, (ROOT / path[1:]).read_bytes(), mime)
        if path == "/__probe.js":
            return self._respond(200, PROBE_JS.encode(), "text/javascript")
        if path == "/v1/workspaces":
            payload = {"items": []}
        elif path == "/v1/providers":
            payload = {"items": []}
        elif path == "/v1/opportunities":
            payload = {"items": [], "run": None}
        else:
            return self._respond(404, b"{}", "application/json")
        return self._respond(200, json.dumps(payload).encode(), "application/json")

    def do_POST(self) -> None:
        self.requests.append(("POST", urlsplit(self.path).path))
        self._respond(403, b'{"error":"offline fixture rejects writes"}', "application/json")


def main() -> None:
    chrome = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    if not chrome.is_file():
        raise SystemExit("BLOCKED: local Chrome missing; no browser acceptance claimed")
    Handler.requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="radar-csp-chrome-") as profile:
            args = [
                str(chrome), "--headless=new", "--disable-gpu",
                "--no-first-run", "--disable-background-networking",
                "--disable-sync", "--disable-extensions",
                "--disable-component-update", "--disable-default-apps",
                "--no-default-browser-check",
                "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
                "--user-data-dir=" + profile,
                "--virtual-time-budget=3500", "--dump-dom",
                f"http://127.0.0.1:{server.server_port}/",
            ]
            result = subprocess.run(args, capture_output=True, text=True, timeout=25)
        if result.returncode:
            raise AssertionError("Chrome exited with code " + str(result.returncode))
        match = re.search(
            r'<pre id="__radar_csp_probe">([^<]+)</pre>', result.stdout
        )
        if not match:
            raise AssertionError("Chrome probe did not finish; browser PASS not claimed")
        checks = json.loads(match.group(1).replace("&quot;", '"'))
        forbidden = [(method, path) for method, path in Handler.requests
                     if method != "GET" or path.startswith("/v1/lite/")]
        if forbidden:
            raise AssertionError("Forbidden browser requests: " + repr(forbidden))
        if not checks or not all(value is True for value in checks.values()):
            raise AssertionError("Browser CSP checks failed: " + repr(checks))
        print(f"CHROME_CSP_OFFLINE_PASS {len(checks)}/{len(checks)} "
              f"requests={len(Handler.requests)} writes=0 "
              "fixture=synthetic-ui-only R3=not-verified")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
