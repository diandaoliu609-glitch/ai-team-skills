#!/usr/bin/env python3
"""ChatGPT-side client for the Muse <-> ChatGPT relay (runs on the Mac).

Single file. Requires: python3 + paramiko (pip3 install paramiko).

The relay server listens only on the Tencent Cloud host's loopback
(127.0.0.1:18765), so this client opens an SSH tunnel and talks HTTP
through it. Protocol messages are JSON:
  {id, from, to, type, body, ts}   (id and ts are assigned by the server)
  type: "chat" (stored + delivered), "ping"/"ack" (not stored)

Config: create chatgpt_relay_config.json NEXT TO this script (0600,
never commit it):
  {
    "token": "<ask liu for the relay token>",
    "ssh_pass": "<SSH password: see liu's desktop workbook
                 账号管理0909.xlsx, sheet 账号总表, the 腾讯云服务器 row>",
    "ssh_host": "119.91.239.241",
    "ssh_port": 8122,
    "ssh_user": "ubuntu",
    "server_port": 18765,
    "name": "chatgpt",
    "local_port": 18768,
    "inbox": "inbox-chatgpt.jsonl"
  }
Or point env var RELAY_CONFIG at a config file elsewhere.

Usage:
  python3 chatgpt_client.py                 # daemon: poll forever,
                                            # append received messages to
                                            # the inbox jsonl + print them
  python3 chatgpt_client.py --send "text"   # send one chat message to Muse
  python3 chatgpt_client.py --send "text" --to Muse --type chat
  python3 chatgpt_client.py --poll-once     # one poll (<=25s), print, exit

The daemon auto-reconnects with backoff if the tunnel or server drops.
The read watermark persists in .chatgpt-client-state.json next to this
script, so restarts do not re-deliver old messages.
"""

import argparse
import json
import os
import select
import socketserver
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.environ.get(
    "RELAY_CONFIG", os.path.join(BASE, "chatgpt_relay_config.json"))
STATE = os.path.join(BASE, ".chatgpt-client-state.json")


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        cfg = json.load(f)
    cfg.setdefault("ssh_host", "119.91.239.241")
    cfg.setdefault("ssh_port", 8122)
    cfg.setdefault("ssh_user", "ubuntu")
    cfg.setdefault("server_port", 18765)
    cfg.setdefault("name", "chatgpt")
    cfg.setdefault("local_port", 18768)
    inbox = cfg.setdefault("inbox", "inbox-chatgpt.jsonl")
    if not os.path.isabs(inbox):
        cfg["inbox"] = os.path.join(BASE, inbox)
    return cfg


# ---- SSH local forward (paramiko) ----

class _ForwardHandler(socketserver.BaseRequestHandler):
    transport = None
    remote = ("127.0.0.1", 18765)

    def handle(self):
        try:
            chan = self.transport.open_channel(
                "direct-tcpip", self.remote, self.request.getpeername())
        except Exception:
            return
        if chan is None:
            return
        try:
            while True:
                r, _, _ = select.select([self.request, chan], [], [], 10)
                if not r:
                    if not self.transport.is_active():
                        break
                    continue
                if self.request in r:
                    data = self.request.recv(65536)
                    if not data:
                        break
                    chan.sendall(data)
                if chan in r:
                    data = chan.recv(65536)
                    if not data:
                        break
                    self.request.sendall(data)
        except Exception:
            pass
        finally:
            try:
                chan.close()
            except Exception:
                pass
            try:
                self.request.close()
            except Exception:
                pass


class _ForwardServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def start_forward(cfg, local_port=None):
    try:
        import paramiko
    except ImportError:
        sys.exit("paramiko is required: run  pip3 install paramiko")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    connect_kwargs = dict(username=cfg["ssh_user"], timeout=20,
                          banner_timeout=20)
    if cfg.get("ssh_key"):
        # Dedicated credential: key auth, no password in config.
        connect_kwargs["key_filename"] = os.path.expanduser(cfg["ssh_key"])
    else:
        connect_kwargs["password"] = cfg["ssh_pass"]
    client.connect(cfg["ssh_host"], port=int(cfg["ssh_port"]),
                   **connect_kwargs)
    transport = client.get_transport()
    transport.set_keepalive(30)
    handler = type("H", (_ForwardHandler,), {
        "transport": transport,
        "remote": ("127.0.0.1", int(cfg["server_port"])),
    })
    port = int(local_port if local_port is not None else cfg["local_port"])
    server = _ForwardServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return client, server


# ---- relay HTTP ----

def http_json(cfg, local_port, method, path, payload=None, timeout=40):
    url = "http://127.0.0.1:%d%s" % (int(local_port), path)
    data = None
    headers = {"X-Relay-Token": cfg["token"]}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def send_message(cfg, local_port, body, to="Muse", mtype="chat"):
    return http_json(cfg, local_port, "POST", "/send", {
        "from": cfg["name"], "to": to, "type": mtype, "body": body})


def poll_messages(cfg, local_port, since, timeout=40):
    return http_json(cfg, local_port, "GET",
                     "/poll?me=%s&since=%d" % (cfg["name"], int(since)),
                     timeout=timeout)


# ---- state ----

def load_since():
    try:
        with open(STATE, encoding="utf-8") as f:
            return int(json.load(f).get("since", 0))
    except Exception:
        return 0


def save_since(v):
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"since": int(v)}, f)
    os.replace(tmp, STATE)


def log(*a):
    ts = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    print(ts, *a, flush=True)


def deliver(cfg, res):
    msgs = res.get("messages", [])
    for m in msgs:
        with open(cfg["inbox"], "a", encoding="utf-8") as f:
            f.write(json.dumps(m, ensure_ascii=False) + "\n")
        print(json.dumps(m, ensure_ascii=False), flush=True)
    if msgs:
        save_since(res.get("last_id", load_since()))
    return len(msgs)


def daemon(cfg):
    backoff = 2
    log("chatgpt relay client starting; me=%s since=%d" % (cfg["name"], load_since()))
    while True:
        client = server = None
        try:
            client, server = start_forward(cfg)
            log("tunnel up on 127.0.0.1:%d" % int(cfg["local_port"]))
            backoff = 2
            while True:
                res = poll_messages(cfg, cfg["local_port"], load_since())
                deliver(cfg, res)
                if not client.get_transport().is_active():
                    raise ConnectionError("ssh transport inactive")
        except Exception as e:
            log("connection error: %s: %s; reconnect in %ss"
                % (type(e).__name__, str(e)[:150], backoff))
        finally:
            try:
                if server is not None:
                    server.shutdown()
            except Exception:
                pass
            try:
                if client is not None:
                    client.close()
            except Exception:
                pass
        time.sleep(backoff)
        backoff = min(backoff * 2, 30)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--send", metavar="TEXT")
    ap.add_argument("--to", default="Muse")
    ap.add_argument("--type", default="chat")
    ap.add_argument("--poll-once", action="store_true")
    args = ap.parse_args()

    cfg = load_config()
    if args.send is not None:
        client, server = start_forward(cfg, local_port=0)
        try:
            res = send_message(cfg, server.server_address[1], args.send,
                               to=args.to, mtype=args.type)
            print(json.dumps(res, ensure_ascii=False))
        finally:
            server.shutdown()
            client.close()
        return
    if args.poll_once:
        client, server = start_forward(cfg, local_port=0)
        try:
            res = poll_messages(cfg, server.server_address[1], load_since())
            deliver(cfg, res)
        finally:
            server.shutdown()
            client.close()
        return
    daemon(cfg)


if __name__ == "__main__":
    main()
