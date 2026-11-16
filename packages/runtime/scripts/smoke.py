"""Owned HTTP/browser/API checks for a built runtime; no external targets or downloads."""

import argparse
import json
import os
import socket
import subprocess
import threading
import time
import urllib.request
import urllib.error
import platform
import statistics
import hashlib
import tempfile
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

root = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser()
parser.add_argument("--home", required=True)
parser.add_argument("--bundle", default=str(root / ".artifacts/v2/runtime"))
parser.add_argument("--source", action="store_true")
parser.add_argument("--output", required=True)
parser.add_argument("--resources", action="store_true")
parser.add_argument("--observability", action="store_true")
args = parser.parse_args()
slow_started = threading.Event()
Path(args.output).unlink(missing_ok=True)


class Fixture(BaseHTTPRequestHandler):
    visits = 0

    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path in ("/", "/slow"):
            Fixture.visits += 1
        if self.path == "/slow":
            slow_started.set()
            time.sleep(0.3)
        body = b'<!doctype html><html><head><title>Owned fixture</title></head><body><article><h1>TRAWL native fixture</h1><p>Verified page content for portable runtime integration.</p></article><script>document.documentElement.dataset.loaded="yes"</script></body></html>'
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        output = json.dumps(
            {"received": body.decode(), "contentType": self.headers.get("Content-Type")}
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(output)))
        self.end_headers()
        self.wfile.write(output)


fixture = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
threading.Thread(target=fixture.serve_forever, daemon=True).start()
with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
base = f"http://127.0.0.1:{port}"
target = f"http://127.0.0.1:{fixture.server_port}/"
bundle = Path(args.bundle).resolve()
home = Path(args.home).resolve()
resources = bundle
browser = home / "browser"
env = {
    **os.environ,
    "PORT": str(port),
    "HOST": "127.0.0.1",
    "SESSION_CACHE_DRIVER": "memory",
    "BROWSER_GEOIP_IP": "8.8.8.8",
    "CAMOUFOX_INSTALL_DIR": str(browser),
    "POWSOLVE_LIB": str(
        bundle
        / (
            "libpowsolve.dll"
            if os.name == "nt"
            else "libpowsolve.dylib"
            if platform.system() == "Darwin"
            else "libpowsolve.so"
        )
    ),
    "WAFMEOW_PATH": str(bundle / ("trawl-waf.exe" if os.name == "nt" else "trawl-waf")),
    "METRICS_DB_PATH": ":memory:",
    "BROWSER_SHUTDOWN_DRAIN_MS": "2000" if not args.resources else "0",
    "METRICS_DASHBOARD_ENABLED": "true",
    "METRICS_DASHBOARD_TOKEN": "a" * 64,
    "OBSERVABILITY_ENABLED": "false",
    "BROWSER_INSPECTION_ENABLED": "false",
    "HISTORY_CAPTURE_MODE": "none",
}
capture_data = None
if args.observability or args.resources:
    capture_data = tempfile.TemporaryDirectory(
        prefix="trawl-native-captures-", dir=Path(args.output).resolve().parent
    )
    env["METRICS_DB_PATH"] = str(Path(capture_data.name) / "metrics.sqlite")
if args.observability:
    env.update(
        OBSERVABILITY_ENABLED="true",
        BROWSER_INSPECTION_ENABLED="true",
        HISTORY_CAPTURE_MODE="both",
    )
if args.source:
    setup = subprocess.check_output(
        [
            "bun",
            "--no-env-file",
            "-e",
            'import {readConfig,runtimePaths} from "./packages/runtime/src/index"; import {resolveEnvironment} from "./packages/config/src/index"; console.log(JSON.stringify(resolveEnvironment((await readConfig(runtimePaths())).env,process.env).values))',
        ],
        cwd=root,
        env={**os.environ, "TRAWL_HOME": str(home)},
        text=True,
    )
    env = {
        **os.environ,
        **json.loads(setup),
        **{
            key: value
            for key, value in env.items()
            if key not in os.environ or value != os.environ[key]
        },
    }
command = (
    ["bun", "--no-env-file", str(root / "apps/api/src/index.ts")]
    if args.source
    else [
        str(bundle / ("trawl-server.exe" if os.name == "nt" else "trawl-server")),
        "serve",
        "--watch-parent",
        "--home",
        str(home),
    ]
)
if not args.source:
    probe = subprocess.run(
        [
            str(bundle / ("trawl-server.exe" if os.name == "nt" else "trawl-server")),
            "--manage",
        ],
        input=json.dumps({"action": "status", "home": str(home)}),
        text=True,
        capture_output=True,
        timeout=10,
    )
    if probe.returncode != 0 or json.loads(probe.stdout).get("result", {}).get(
        "running"
    ):
        raise RuntimeError(
            "Refusing to use a home with a running instance or unavailable control"
        )
records = []
started = time.monotonic()
log = Path(args.output).with_suffix(".server.log")
logfile = log.open("w")
time_file = Path(args.output).with_suffix(".time.txt")
if args.resources:
    if os.name == "nt":
        raise RuntimeError("Resource sampler requires POSIX ps/time")
    command = ["/usr/bin/time", "-p", "-o", str(time_file), *command]
process = subprocess.Popen(
    command,
    cwd=root if args.source else Path(args.output).parent,
    env=env,
    stdin=subprocess.PIPE,
    stdout=logfile,
    stderr=logfile,
)
samples = []
sampling = True


# Sum resident pages for the owned tree; shared pages can be counted more than once.
def sample():
    try:
        rows = [
            list(map(int, line.split()))
            for line in subprocess.check_output(
                ["ps", "-axo", "pid=,ppid=,rss="], text=True
            ).splitlines()
            if line.strip()
        ]
        owned = {process.pid}
        for _ in range(10):
            descendants = {pid for pid, parent, rss in rows if parent in owned}
            if descendants <= owned:
                break
            owned |= descendants
        tree = [
            (pid, rss)
            for pid, parent, rss in rows
            if pid in owned and pid != process.pid
        ]
        return {
            "rssMiB": round(sum(rss for _, rss in tree) / 1024, 2),
            "processes": len(tree),
            "pids": [pid for pid, _ in tree],
        }
    except (OSError, subprocess.SubprocessError):
        return None


def monitor():
    while sampling:
        measured = sample()
        if measured:
            samples.append(measured)
        time.sleep(0.5)


if args.resources:
    threading.Thread(target=monitor, daemon=True).start()


def request(path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        base + path,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + "a" * 64,
        },
    )
    start = time.monotonic()
    with urllib.request.urlopen(req, timeout=65) as response:
        result = json.load(response)
    records.append(
        {
            "operation": path,
            "wallMs": round((time.monotonic() - start) * 1000, 2),
            "totalMs": result.get("totalMs"),
        }
    )
    return result


def check_observability(request_id, session_id):
    capabilities = request("/capabilities")
    assert all(
        capabilities.get(feature)
        for feature in ("settings", "requests", "logs", "captures", "browserInspection")
    )
    settings = request("/settings")
    assert settings["readOnly"] is True
    assert all(item["value"] is None for item in settings["settings"] if item["secret"])
    for path in ("/settings", "/logs", "/requests", "/browser/pages"):
        try:
            urllib.request.urlopen(base + path, timeout=5).close()
        except urllib.error.HTTPError as error:
            assert error.code == 401, (path, error.code)
        else:
            raise AssertionError("Unauthenticated access: " + path)

    assert request("/requests/" + request_id)["id"] == request_id
    deadline = time.monotonic() + 5
    while True:
        manifest = request("/requests/" + request_id + "/captures")
        if all(item["state"] != "pending" for item in manifest["artifacts"]):
            break
        assert time.monotonic() < deadline, "Capture writer did not finish"
        time.sleep(0.05)
    assert {item["kind"] for item in manifest["artifacts"]} == {"html", "screenshot"}
    visits = Fixture.visits
    observed = request("/browser/pages")["pages"]
    current = next(item for item in observed if item.get("sessionId") == session_id)
    assert current["state"] == "session-idle" and current["display"] == "headless"

    def binary(path, limit):
        req = urllib.request.Request(base + path, headers={"Authorization": "Bearer " + "a" * 64})
        with urllib.request.urlopen(req, timeout=15) as response:
            assert response.headers.get("Cache-Control") == "no-store"
            content = response.read(limit + 1)
        assert 0 < len(content) <= limit
        return content

    preview = binary("/browser/pages/" + current["id"] + "/preview", 1024 * 1024)
    assert preview.startswith(b"\xff\xd8")
    for artifact in manifest["artifacts"]:
        assert artifact["state"] == "ready", artifact
        content = binary("/requests/" + request_id + "/captures/" + artifact["kind"], 2 * 1024 * 1024)
        assert len(content) == artifact["bytes"]
        assert hashlib.sha256(content).hexdigest() == artifact["sha256"]
        if artifact["kind"] == "html":
            assert b"TRAWL native fixture" in content
        else:
            assert content.startswith(b"\xff\xd8")
    assert Fixture.visits == visits, "History/preview caused another target navigation"

    for path in ("/requests/events", "/logs/events"):
        req = urllib.request.Request(base + path, headers={"Authorization": "Bearer " + "a" * 64})
        with urllib.request.urlopen(req, timeout=5) as response:
            assert response.headers.get_content_type() == "text/event-stream"
            frame = []
            while len(frame) < 8:
                line = response.readline(1024)
                if line == b"\n":
                    break
                frame.append(line)
            assert any(line.startswith(b"event: ") for line in frame)
    assert request("/logs")["coverage"] == "structured-application-logs-since-start"


try:
    for _ in range(200):
        if process.poll() is not None:
            raise RuntimeError("Server exited during startup; see private log")
        try:
            if request("/health")["status"] == "ok":
                break
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(0.2)
    else:
        raise RuntimeError("Server did not become ready")
    startup = round((time.monotonic() - started) * 1000, 2)
    records.clear()
    idle = []
    if args.resources:
        for _ in range(5):
            time.sleep(0.5)
            measured = sample()
            if measured:
                idle.append(measured)
    first = request("/scrape", {"url": target})
    assert "TRAWL native fixture" in first["html"]
    page = request("/scrape", {"url": target, "skipHttp": True, "screenshot": True})
    assert 'data-loaded="yes"' in page["html"] and len(page["screenshot"]) > 100
    posted = request(
        "/scrape",
        {
            "url": target,
            "method": "POST",
            "headers": {"content-type": "application/json"},
            "body": '{"owned":true}',
        },
    )
    assert "owned" in posted["html"]
    read = request("/read", {"url": target})
    assert "TRAWL native fixture" in read["text"]
    extracted = request(
        "/extract", {"url": target, "fields": {"heading": {"selector": "h1"}}}
    )
    assert extracted["items"][0]["heading"] == "TRAWL native fixture"
    session = request("/sessions", {"keepPage": True})
    request("/sessions/" + session["id"] + "/scrape", {"url": target, "skipHttp": True})
    evaluated = request(
        "/sessions/" + session["id"] + "/eval", {"expression": "document.title"}
    )
    assert evaluated["value"] == "Owned fixture"
    if args.observability:
        check_observability(page["requestId"], session["id"])
    req = urllib.request.Request(base + "/sessions/" + session["id"], method="DELETE")
    urllib.request.urlopen(req, timeout=10).close()
    if args.observability:
        assert request("/browser/pages")["pages"] == []
    for _ in range(2):
        legacy = request(
            "/v1", {"cmd": "request.get", "url": target, "maxTimeout": 60000}
        )
        assert (
            legacy["status"] == "ok"
            and "TRAWL native fixture" in legacy["solution"]["response"]
        )
    metrics = request("/dashboard/metrics?minutes=60")
    assert metrics["requests"] >= 8
    if not args.source and not args.resources:
        drained = {}

        def slow_request():
            drained["result"] = request("/scrape", {"url": target + "slow"})

        pending = threading.Thread(target=slow_request, daemon=True)
        pending.start()
        assert slow_started.wait(10), "Owned slow request did not start"
        process.stdin.close()
        pending.join(10)
        assert "TRAWL native fixture" in drained.get("result", {}).get("html", ""), (
            "Parent EOF interrupted an accepted request"
        )
        assert process.wait(timeout=40) == 0, (
            "Parent EOF did not stop the native server gracefully"
        )
    report = {
        "mode": "source" if args.source else "bundle",
        "platform": platform.system(),
        "arch": platform.machine(),
        "startupMs": startup,
        "checks": len(records),
        "observability": args.observability,
        "requests": records,
    }
    if args.resources:
        report["resources"] = {
            "sampleIntervalMs": 500,
            "idleMedianTreeRssMiB": statistics.median(row["rssMiB"] for row in idle),
            "peakSampledTreeRssMiB": max(row["rssMiB"] for row in samples),
            "idleProcessCount": max(row["processes"] for row in idle),
            "peakProcessCount": max(row["processes"] for row in samples),
        }
        pids = ",".join(str(pid) for pid in idle[-1]["pids"])
        threads = subprocess.check_output(
            [
                "ps",
                "-M" if platform.system() == "Darwin" else "-L",
                "-p",
                pids,
                "-o",
                "pid=",
            ],
            text=True,
        ).splitlines()
        report["resources"]["idleThreads"] = len(threads)
        descriptors = subprocess.run(
            ["lsof", "-nP", "-a", "-p", pids, "-F", "pf"],
            text=True,
            capture_output=True,
        )
        report["resources"]["idleDescriptors"] = sum(
            1
            for line in descriptors.stdout.splitlines()
            if len(line) > 1 and line[0] == "f" and line[1].isdigit()
        )
    Path(args.output).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))
finally:
    if not args.source:
        # The parent pipe belongs to this child; never stop another instance by home.
        if process.stdin and not process.stdin.closed:
            process.stdin.close()
    elif not args.resources:
        process.terminate()
    # POSIX time forwards neither signal nor stdin; stop the managed API process through its own PID.
    if args.resources and args.source:
        for row in sample().get("pids", []) if sample() else []:
            try:
                if row in [
                    int(line.split()[0])
                    for line in subprocess.check_output(
                        ["ps", "-axo", "pid=,ppid="], text=True
                    ).splitlines()
                    if line.split() and int(line.split()[1]) == process.pid
                ]:
                    os.kill(row, 15)
            except ProcessLookupError:
                pass
    try:
        process.wait(timeout=40)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        raise
    sampling = False
    if args.resources and Path(args.output).exists() and time_file.exists():
        report = json.loads(Path(args.output).read_text())
        report["resources"]["commandTiming"] = time_file.read_text().strip()
        capture_files = list((Path(capture_data.name) / "captures").glob("*")) if capture_data else []
        report["resources"]["captureFileBytes"] = sum(
            path.stat().st_size for path in capture_files if path.suffix == ".capture"
        )
        report["resources"]["captureIndexAndJournalBytes"] = sum(
            path.stat().st_size for path in capture_files if path.name.startswith("index.sqlite")
        )
        Path(args.output).write_text(json.dumps(report, indent=2) + "\n")
    logfile.close()
    fixture.shutdown()
    if capture_data is not None:
        capture_data.cleanup()
