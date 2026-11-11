"""Compare default /v1 request.get workflows using isolated Docker containers."""

import argparse
import hashlib
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
FLARESOLVERR = "ghcr.io/flaresolverr/flaresolverr@sha256:91c0774e7d634f8b55a69d5027fa13a7fcad9b59b420efb286364fc8236634f1"
BYPARR = "ghcr.io/thephaseless/byparr@sha256:deee7a375152218eadd4ee571ce2073e1a7cc2d320f3492947b1cd9d87c4f0d4"
WALL_TITLE = re.compile(
    r"<title>\s*(?:Just a moment|Attention Required|Access Denied|"
    r"Making sure you.{0,16}not a bot|Checking your browser|Security Check|Security \||DDoS-Guard)", re.I
)


def docker(*args):
    return subprocess.check_output(["docker", *args], stderr=subprocess.STDOUT).decode().strip()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def journal(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line] if path.exists() else []


def request(base, payload=None, timeout=85):
    req = urllib.request.Request(
        base + ("/v1" if payload else "/"),
        json.dumps(payload).encode() if payload else None,
        {"Content-Type": "application/json"},
    )
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            status, body = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, body = error.code, error.read()
    try:
        data = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        data = {}
    return status, data, round((time.monotonic() - start) * 1000)


def state(name):
    data = json.loads(docker("inspect", name))[0]
    return {"id": data["Id"], "startedAt": data["State"]["StartedAt"], "restarts": data["RestartCount"]}


def destination_matches(target, data):
    try:
        expected = urlparse(target["url"])
        actual = urlparse(data.get("solution", {}).get("url", ""))
        paths = target.get("expectedPaths", [expected.path])
        return (actual.scheme == expected.scheme
                and actual.hostname == expected.hostname
                and actual.port == expected.port
                and actual.path.rstrip("/") in [path.rstrip("/") for path in paths])
    except ValueError:
        return False


def verify(target, status, data):
    html = data.get("solution", {}).get("response", "")
    visible = re.sub(r"<(?:script|style)\b[^>]*>[\s\S]*?</(?:script|style)>", "", html, flags=re.I)
    marker = bool(re.search(target["expected"], visible, re.I | re.S))
    wall = bool(WALL_TITLE.search(visible) or re.search(r'id=["\']challenge-form["\']|_cf_chl_opt', html, re.I))
    return (status == 200 and data.get("status") == "ok"
            and data.get("solution", {}).get("status") == 200
            and marker and not wall and destination_matches(target, data))


class WidgetEvidence(HTMLParser):
    def __init__(self):
        super().__init__()
        self.fields = 0
        self.tokens = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "input" and attrs.get("name") == "cf-turnstile-response":
            self.fields += 1
            self.tokens += len(attrs.get("value") or "") > 10


def widget_evidence(html):
    evidence = WidgetEvidence()
    evidence.feed(html)
    return {"turnstileFields": evidence.fields, "turnstileTokens": evidence.tokens}


def measure(folder, base, target, product, round_number, mode, attempt, redis_folder, session=None, timeout_ms=60000):
    before = journal(folder / "samples.jsonl")[-1]
    redis_before = journal(redis_folder / "samples.jsonl")[-1]
    if time.time() * 1000 - before["t"] > 1500:
        raise RuntimeError("Resource observer stopped")
    payload = {"cmd": "request.get", "url": target["url"], "maxTimeout": timeout_ms}
    if session:
        payload["session"] = session
    start = time.time() * 1000
    host_load = list(os.getloadavg())
    transport = None
    try:
        status, data, elapsed = request(base, payload)
    except (OSError, TimeoutError) as error:
        status, data, elapsed = 0, {}, round(time.time() * 1000 - start)
        transport = type(error).__name__
    end = time.time() * 1000
    time.sleep(0.3)
    samples = journal(folder / "samples.jsonl")
    after = samples[-1]
    redis_after = journal(redis_folder / "samples.jsonl")[-1]
    if end - after["t"] > 1500:
        raise RuntimeError("Resource observer stopped")
    window = [s for s in samples if start - 250 <= s["t"] <= end + 300]
    row = {
        "product": product, "round": round_number, "mode": mode,
        "site": target["id"], "attempt": attempt, "clientMs": elapsed,
        "apiStatus": status, "verified": verify(target, status, data),
        "destinationVerified": destination_matches(target, data),
        "widgets": widget_evidence(data.get("solution", {}).get("response", "")),
        "cpuSeconds": round(after["cpu"] - before["cpu"], 6),
        "oomKills": after["oomKills"] - before["oomKills"],
        "peak": {k: max(s[k] for s in window) for k in
                 ["memory", "working", "anon", "processes", "threads", "fds", "pids"]},
        "transportError": transport,
        "hostLoadBefore": host_load,
        "hostLoadAfter": list(os.getloadavg()),
    }
    if product == "trawl":
        redis_window = [s for s in journal(redis_folder / "samples.jsonl") if start - 250 <= s["t"] <= end + 300]
        row["redisCpuSeconds"] = round(redis_after["cpu"] - redis_before["cpu"], 6)
        row["redisPeakMemory"] = max(s["memory"] for s in redis_window)
        row["redisPeakWorking"] = max(s["working"] for s in redis_window)
    # Never export response bodies, cookies, tokens or provider error messages.
    print(json.dumps(row), flush=True)
    if row["oomKills"] or row["peak"]["memory"] > 4 * 1024**3:
        raise RuntimeError("Stopping the benchmark after OOM or excessive memory usage")
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trawl-image", required=True, help="Locally built image to measure")
    parser.add_argument("--output", required=True, type=Path, help="New private output directory")
    parser.add_argument("--rounds", type=int, default=2)
    parser.add_argument("--targets", type=Path, default=HERE / "targets.json")
    parser.add_argument("--products", nargs="+", choices=["trawl", "flaresolverr", "byparr"],
                        default=["trawl", "flaresolverr", "byparr"])
    parser.add_argument("--session-products", nargs="*", choices=["trawl", "flaresolverr"], default=["flaresolverr"])
    parser.add_argument("--timeout-ms", type=int, default=60000)
    args = parser.parse_args()
    if args.rounds < 1:
        parser.error("--rounds must be positive")
    if args.timeout_ms < 1000 or args.timeout_ms > 60000:
        parser.error("--timeout-ms must be between 1000 and 60000")
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    targets = json.loads(args.targets.read_text())
    images = {product: image for product, image in
              {"trawl": args.trawl_image, "flaresolverr": FLARESOLVERR, "byparr": BYPARR}.items()
              if product in args.products or product == "trawl"}
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    prefix = "trawl-compare-" + stamp
    redis = prefix + "-redis"
    owned = []
    rows = []
    live = {name: state(name) for name in ["Trawl", "Prowlarr"]
            if subprocess.run(["docker", "inspect", name], capture_output=True).returncode == 0}
    result = {
        "method": {
            "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "host": "Apple Silicon / OrbStack", "platform": "linux/arm64",
            "endpoint": "/v1", "maxTimeoutMs": args.timeout_ms, "rounds": args.rounds,
            "requestsPerSitePerRound": 3, "memoryLimit": None, "shmMiB": 1024,
            "cpuQuota": None, "samplingMs": 250,
            "trawlProfile": {"pool": 1, "headful": 0, "blockAds": False,
                             "contentProcesses": 1, "hardwareConcurrency": 4},
            "cache": "Redis for TRAWL; cleared before each site",
            "cpuAndMemoryScope": "Application container; TRAWL Redis costs are also recorded separately",
            "sessions": {"products": args.session_products, "sites": [site["id"] for site in targets[:2]]},
            "sources": {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest()
                        for name in ["run.py", "observer.ts"]},
            "targetFileSha256": hashlib.sha256(args.targets.read_bytes()).hexdigest(),
        },
        "products": {}, "sites": targets, "requests": rows,
    }
    try:
        docker("network", "create", prefix); owned.append(("network", prefix))
        for product, image in images.items():
            info = json.loads(docker("image", "inspect", image))[0]
            result["products"][product] = {"imageId": info["Id"], "reference": image,
                                          "imageBytes": info["Size"], "architecture": info["Architecture"]}
            if info["Architecture"] != "arm64":
                raise RuntimeError("Native arm64 images are required")
        docker("run", "-d", "--name", redis, "--network", prefix, "redis:8")
        owned.append(("container", redis))
        for _ in range(30):
            try:
                if docker("exec", redis, "redis-cli", "ping") == "PONG":
                    break
            except subprocess.CalledProcessError:
                pass
            time.sleep(0.2)
        else:
            raise RuntimeError("Redis did not become ready")
        redis_folder = root / "redis"; redis_folder.mkdir()
        redis_observer = redis + "-observer"
        docker("run", "-d", "--name", redis_observer, "--pid", "container:" + redis,
               "--cap-add", "SYS_PTRACE", "--memory", "256m", "--entrypoint", "bun",
               "-v", str(redis_folder) + ":/bench", "-v", str(HERE / "observer.ts") + ":/observer.ts:ro",
               images["trawl"], "/observer.ts")
        owned.append(("container", redis_observer)); time.sleep(1)
        if not journal(redis_folder / "samples.jsonl"):
            raise RuntimeError("Redis observer did not start")
        for round_number in range(1, args.rounds + 1):
            order = ["trawl", "flaresolverr", "byparr"] if round_number % 2 else ["byparr", "flaresolverr", "trawl"]
            for product in [product for product in order if product in args.products]:
                folder = root / f"{round_number}-{product}"; folder.mkdir()
                name = f"{prefix}-{round_number}-{product}"
                observer = name + "-observer"
                env = {"LOG_LEVEL": "info"}
                if product == "trawl":
                    env.update({"SESSION_CACHE_DRIVER": "redis", "REDIS_URL": f"redis://{redis}:6379",
                                "BROWSER_POOL_SIZE": "1", "BROWSER_HEADFUL_POOL_SIZE": "0",
                                "BROWSER_BLOCK_ADS": "false", "BROWSER_MAX_CONTENT_PROCESSES": "1",
                                "BROWSER_HARDWARE_CONCURRENCY": "4", "MCP_ENABLED": "true",
                                "METRICS_DASHBOARD_ENABLED": "true", "METRICS_DB_PATH": "/tmp/benchmark.sqlite"})
                command = ["run", "-d", "--name", name, "--network", prefix,
                           "--shm-size", "1g", "-p", "127.0.0.1::8191"]
                for key, value in env.items():
                    command += ["-e", key + "=" + value]
                command += [images[product]]
                docker(*command); owned.append(("container", name))
                info = json.loads(docker("inspect", name))[0]
                if info["HostConfig"]["Memory"] != 0 or info["HostConfig"]["ShmSize"] != 1024**3:
                    raise RuntimeError("Container resource settings differ from the benchmark plan")
                base = "http://127.0.0.1:" + info["NetworkSettings"]["Ports"]["8191/tcp"][0]["HostPort"]
                for _ in range(120):
                    try:
                        status, _, _ = request(base, timeout=2)
                        if status == 200:
                            break
                    except (OSError, TimeoutError):
                        pass
                    time.sleep(0.5)
                else:
                    raise RuntimeError(product + " did not become ready")
                if product == "trawl":
                    for _ in range(120):
                        try:
                            with urllib.request.urlopen(base + "/health", timeout=5) as response:
                                if json.load(response).get("pool", {}).get("available") == 1:
                                    break
                        except (OSError, TimeoutError):
                            pass
                        time.sleep(0.5)
                    else:
                        raise RuntimeError("TRAWL browser did not become ready")
                docker("run", "-d", "--name", observer, "--pid", "container:" + name,
                       "--cap-add", "SYS_PTRACE", "--memory", "256m", "--entrypoint", "bun",
                       "-v", str(folder) + ":/bench", "-v", str(HERE / "observer.ts") + ":/observer.ts:ro",
                       images["trawl"], "/observer.ts")
                owned.append(("container", observer)); time.sleep(1)
                if not journal(folder / "samples.jsonl"):
                    raise RuntimeError("Observer did not start")
                print(json.dumps({"started": product, "round": round_number,
                                  "loadAverage": os.getloadavg()}), flush=True)
                for target in targets:
                    docker("exec", redis, "redis-cli", "FLUSHDB")
                    for attempt in [1, 2, 3]:
                        rows.append(measure(folder, base, target, product, round_number, "default", attempt,
                                            redis_folder, timeout_ms=args.timeout_ms))
                        save(root / "results.json", result)
                if product in args.session_products:
                    for target in targets[:2]:
                        session = "benchmark-" + target["id"]
                        status, data, setup = request(base, {"cmd": "sessions.create", "session": session})
                        if status != 200 or data.get("status") != "ok":
                            raise RuntimeError(product + " session creation failed")
                        result.setdefault("sessionSetupMs", []).append({"product": product, "round": round_number,
                                                                       "site": target["id"], "ms": setup})
                        try:
                            for attempt in [1, 2, 3]:
                                rows.append(measure(folder, base, target, product, round_number, "session", attempt,
                                                    redis_folder, session, args.timeout_ms))
                                save(root / "results.json", result)
                        finally:
                            request(base, {"cmd": "sessions.destroy", "session": session})
                (folder / "runtime.log").write_text(docker("logs", name))
                docker("rm", "-f", observer); owned.remove(("container", observer))
                docker("rm", "-f", name); owned.remove(("container", name))
        result["completed"] = True
    finally:
        for kind, name in reversed(owned):
            subprocess.run(["docker", "rm", "-f", name] if kind == "container" else
                           ["docker", "network", "rm", name], capture_output=True)
        result["liveServicesUnchanged"] = all(state(name) == previous for name, previous in live.items())
        save(root / "results.json", result)


if __name__ == "__main__":
    main()
