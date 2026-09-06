#!/usr/bin/env python3

import asyncio
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import websockets


ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB_ROOT = ROOT / "web"
DATABASE_PATH = ROOT / "content" / "database.json"
COSMETICS_PATH = ROOT / "content" / "cosmetics.json"
CHROME_BIN = os.environ.get("CHROME_BIN", "google-chrome")
DEBUG_PORT = 9223


class StaticHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def log_message(self, format, *args):
        pass


def load_json(path):
    return json.loads(path.read_text())


def wait_for_debug_port():
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json/version", timeout=1) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError("smoke-test: Chrome DevTools endpoint did not start in time.")


def get_browser_ws_url():
    with urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json/version", timeout=5) as response:
        payload = json.loads(response.read().decode("utf-8"))
    ws_url = payload.get("webSocketDebuggerUrl")
    if not ws_url:
        raise RuntimeError("smoke-test: missing browser WebSocket debugger URL.")
    return ws_url


def wait_for_target_ws_url(target_id):
    deadline = time.time() + 5
    while time.time() < deadline:
        with urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json/list", timeout=5) as response:
            targets = json.loads(response.read().decode("utf-8"))
        for target in targets:
            if target.get("id") == target_id and target.get("webSocketDebuggerUrl"):
                return target["webSocketDebuggerUrl"]
        time.sleep(0.1)
    raise RuntimeError(f"smoke-test: missing target WebSocket debugger URL for {target_id}.")


async def cdp_send(ws, method, params=None, message_id=1):
    await ws.send(json.dumps({"id": message_id, "method": method, "params": params or {}}))
    while True:
        raw = await ws.recv()
        payload = json.loads(raw)
        if payload.get("id") == message_id:
            return payload


async def cdp_wait_for_method(ws, method, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.time()))
        payload = json.loads(raw)
        if payload.get("method") == method:
            return payload
    raise RuntimeError(f"smoke-test: timed out waiting for CDP event {method}.")


async def evaluate_page(ws):
    script = """
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 3200));
        const root = document.querySelector('[data-smoke-ready]');
        const profile = document.querySelector('[data-smoke-profile]');
        return {
          smokeReady: Boolean(root),
          smokeView: root ? root.getAttribute('data-smoke-view') : '',
          smokeTarget: Boolean(document.querySelector('[data-smoke-target="true"]')),
          smokeProfile: profile ? profile.getAttribute('data-smoke-profile') : '',
          text: document.body ? document.body.innerText : '',
        };
      })();
    """
    response = await cdp_send(
        ws,
        "Runtime.evaluate",
        {
            "expression": script,
            "awaitPromise": True,
            "returnByValue": True,
        },
        message_id=3,
    )
    if "result" not in response or "result" not in response.get("result", {}):
        raise RuntimeError(f"smoke-test: unexpected Runtime.evaluate response: {json.dumps(response)}")
    return response["result"]["result"]["value"]


async def run_scenario(base_url, scenario):
    params = urllib.parse.urlencode({k: v for k, v in scenario["params"].items() if v})
    url = f"{base_url}/index.html"
    if params:
        url = f"{url}?{params}"
    browser_ws_url = get_browser_ws_url()
    async with websockets.connect(browser_ws_url, max_size=None) as browser_ws:
        create_response = await cdp_send(
            browser_ws,
            "Target.createTarget",
            {"url": "about:blank"},
            message_id=1,
        )
        target_id = create_response["result"]["targetId"]
        target_ws_url = wait_for_target_ws_url(target_id)
        async with websockets.connect(target_ws_url, max_size=None) as target_ws:
            await cdp_send(target_ws, "Page.enable", message_id=2)
            await cdp_send(target_ws, "Runtime.enable", message_id=3)
            await cdp_send(target_ws, "Page.navigate", {"url": url}, message_id=4)
            await cdp_wait_for_method(target_ws, "Page.loadEventFired")
            state = await evaluate_page(target_ws)
            if scenario["label"] == "boot" and not state.get("smokeReady"):
                print(f"smoke-test: boot debug state {json.dumps(state)}")
        await cdp_send(browser_ws, "Target.closeTarget", {"targetId": target_id}, message_id=5)
    scenario["check"](state)
    print(f"smoke-test: passed {scenario['label']}")


def main():
    database = load_json(DATABASE_PATH)
    cosmetics = load_json(COSMETICS_PATH)
    killer = database["killers"][0]
    addon = next(entry for entry in database["addons"] if entry.get("role") == "killer")
    offering = next(entry for entry in database["offerings"] if not entry.get("retired"))
    cosmetic = next(
        entry
        for entry in (cosmetics.get("characterSwaps", []) + cosmetics.get("fullSets", []))
        if entry.get("status") == "ready" and entry.get("baseCharacterType") == "Survivor"
    )

    scenarios = [
        {
            "label": "boot",
            "params": {},
            "check": lambda state: (
                state["smokeReady"] or (_ for _ in ()).throw(RuntimeError("boot: website did not mount")),
                state["smokeView"] == "home" or (_ for _ in ()).throw(RuntimeError(f"boot: expected home, found {state['smokeView']}")),
                "Something went wrong" not in state["text"] or (_ for _ in ()).throw(RuntimeError("boot: error boundary rendered")),
            ),
        },
        {
            "label": "settings",
            "params": {"view": "settings"},
            "check": lambda state: (
                state["smokeView"] == "settings" or (_ for _ in ()).throw(RuntimeError(f"settings: expected settings, found {state['smokeView']}")),
                "Website preferences" in state["text"] or (_ for _ in ()).throw(RuntimeError("settings: missing expected text")),
            ),
        },
        {
            "label": "worldle",
            "params": {"view": "worldle"},
            "check": lambda state: (
                state["smokeView"] == "worldle" or (_ for _ in ()).throw(RuntimeError(f"worldle: expected worldle, found {state['smokeView']}")),
                "Test your DBD knowledge" in state["text"] or (_ for _ in ()).throw(RuntimeError("worldle: missing expected text")),
            ),
        },
        {
            "label": "items-target",
            "params": {"view": "items", "mode": "killer", "search": addon["name"], "targetType": "addon", "targetId": addon["id"]},
            "check": lambda state: (
                state["smokeView"] == "items" or (_ for _ in ()).throw(RuntimeError(f"items-target: expected items, found {state['smokeView']}")),
                state["smokeTarget"] or (_ for _ in ()).throw(RuntimeError("items-target: target highlight missing")),
            ),
        },
        {
            "label": "offerings-target",
            "params": {"view": "offerings", "search": offering["name"], "targetType": "offering", "targetId": offering["id"]},
            "check": lambda state: (
                state["smokeView"] == "offerings" or (_ for _ in ()).throw(RuntimeError(f"offerings-target: expected offerings, found {state['smokeView']}")),
                state["smokeTarget"] or (_ for _ in ()).throw(RuntimeError("offerings-target: target highlight missing")),
            ),
        },
        {
            "label": "killer-profile",
            "params": {"view": "killers", "profileId": killer["id"]},
            "check": lambda state: (
                state["smokeView"] == "killers" or (_ for _ in ()).throw(RuntimeError(f"killer-profile: expected killers, found {state['smokeView']}")),
                state["smokeProfile"] == killer["id"] or (_ for _ in ()).throw(RuntimeError("killer-profile: modal did not open")),
            ),
        },
        {
            "label": "survivor-profile-cosmetic",
            "params": {"view": "survivors", "profileId": cosmetic["baseCharacterId"], "cosmeticId": cosmetic["id"]},
            "check": lambda state: (
                state["smokeView"] == "survivors" or (_ for _ in ()).throw(RuntimeError(f"survivor-profile-cosmetic: expected survivors, found {state['smokeView']}")),
                state["smokeProfile"] == cosmetic["baseCharacterId"] or (_ for _ in ()).throw(RuntimeError("survivor-profile-cosmetic: profile modal missing")),
                state["smokeTarget"] or (_ for _ in ()).throw(RuntimeError("survivor-profile-cosmetic: focused cosmetic missing")),
            ),
        },
        {
            "label": "cosmetics-browser",
            "params": {"view": "cosmetics", "tab": "fullSets"},
            "check": lambda state: (
                state["smokeView"] == "cosmetics" or (_ for _ in ()).throw(RuntimeError(f"cosmetics-browser: expected cosmetics, found {state['smokeView']}")),
                ("Cosmetics" in state["text"] or "Legendary Characters" in state["text"]) or (_ for _ in ()).throw(RuntimeError("cosmetics-browser: missing title")),
            ),
        },
    ]

    server = ThreadingHTTPServer(("127.0.0.1", 0), StaticHandler)
    base_url = f"http://127.0.0.1:{server.server_address[1]}"
    server_thread = Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    user_data_dir = tempfile.mkdtemp(prefix="entity-wiki-smoke-")
    chrome = subprocess.Popen([
        CHROME_BIN,
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        f"--remote-debugging-port={DEBUG_PORT}",
        f"--user-data-dir={user_data_dir}",
        "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        wait_for_debug_port()
        for scenario in scenarios:
            asyncio.run(run_scenario(base_url, scenario))
        print(f"smoke-test: passed {len(scenarios)} scenarios")
    finally:
        server.shutdown()
        server.server_close()
        chrome.terminate()
        try:
            chrome.wait(timeout=5)
        except subprocess.TimeoutExpired:
            chrome.kill()
        shutil.rmtree(user_data_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
