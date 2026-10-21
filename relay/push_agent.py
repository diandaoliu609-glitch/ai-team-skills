#!/usr/bin/env python3
"""Server-side WeChat push worker for the Muse<->ChatGPT relay.

Polls the relay (127.0.0.1:18765) for type=push_job messages addressed to
"push_agent", executes the WeChat draft push LOCALLY on this server (its
egress IP is the whitelisted one), and posts the result back as
type=push_result to the original sender.

Credentials (appid/secret) are NEVER part of the job body. They live in
~/push_agent/accounts.json (0600, never committed to git) on this server,
looked up by account name, and exist only in memory. Uploaded files under
/tmp/push_agent_* are removed after each job. Completed job_ids are tracked
in done.jsonl so a restart does not duplicate drafts.

Protocol note for other agents (ChatGPT): submit a job by POSTing to the
relay /send:
    {"from": <your name>, "to": "push_agent", "type": "push_job",
     "body": {"job_id": "<unique>", "kind": "newspic"|"article",
              "account": "<friendly name>", "title": "...",
              # newspic:
              "content": "<caption>", "images": [{"name": "pic1.jpg", "data": "<base64>"}],
              # article:
              "author": "...", "digest": "...", "html": "<article html>",
              "cover": {"name": "cover.jpg", "data": "<base64>"},
              "images": [{"name": "body1.jpg", "data": "<base64>"}]}}
Then poll /poll?me=<your name>&since=<msg_id> for type=push_result with a
matching body.job_id.
"""

import base64
import json
import mimetypes
import os
import shutil
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.abspath(__file__))
RELAY = "http://127.0.0.1:18765"
WORKROOT = "/tmp/push_agent"
DONELOG = os.path.join(BASE, "done.jsonl")
ACCOUNTS_PATH = os.path.expanduser("~/push_agent/accounts.json")

with open(os.path.join(BASE, "config.json"), encoding="utf-8") as f:
    TOKEN = json.load(f)["token"]

with open(ACCOUNTS_PATH, encoding="utf-8") as f:
    ACCOUNTS = json.load(f)  # {"account name": {"appid": ..., "secret": ...}}, 0600 on disk


def log(*a):
    ts = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    print(ts, *a, flush=True)


def relay_get(path, timeout=40):
    req = urllib.request.Request(RELAY + path, headers={"X-Relay-Token": TOKEN}, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def relay_send(to, mtype, body, sender="push_agent"):
    payload = json.dumps({"from": sender, "to": to, "type": mtype, "body": body},
                         ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(RELAY + "/send", data=payload,
                                 headers={"X-Relay-Token": TOKEN,
                                          "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


# ---------------- WeChat API (runs on this whitelisted server, stdlib only) ----------------

API = "https://api.weixin.qq.com/cgi-bin"


def api_get(path, params, timeout=30):
    url = API + path + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


def api_post_json(path, params, payload, timeout=30):
    url = API + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, data=json.dumps(payload, ensure_ascii=False).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def api_post_multipart(path, params, file_path, filename, timeout=60):
    boundary = "----pushagent1234"
    ctype = mimetypes.guess_type(file_path)[0] or "image/jpeg"
    with open(file_path, "rb") as f:
        file_bytes = f.read()
    body = (
        ("--" + boundary + "\r\n").encode()
        + ('Content-Disposition: form-data; name="media"; filename="%s"\r\n' % filename).encode()
        + ("Content-Type: %s\r\n\r\n" % ctype).encode()
        + file_bytes
        + ("\r\n--" + boundary + "--\r\n").encode()
    )
    url = API + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, data=body,
                                 headers={"Content-Type": "multipart/form-data; boundary=" + boundary})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def wechat_push(job, workdir, appid, secret):
    """Execute one push job. Returns {"ok", "media_id"} or {"ok": False, "errcode", "errmsg"}."""
    tok = api_get("/token", {"grant_type": "client_credential", "appid": appid, "secret": secret})
    if "access_token" not in tok:
        return {"ok": False, "errcode": tok.get("errcode", -1),
                "errmsg": "get token failed: " + str(tok.get("errmsg"))}
    token = tok["access_token"]

    def upload_image(path, fname):
        up = api_post_multipart("/material/add_material",
                                {"access_token": token, "type": "image"}, path, fname)
        return up

    kind = job["kind"]
    if kind == "newspic":
        image_list = []
        for i, img in enumerate(job.get("images", []), start=1):
            up = upload_image(os.path.join(workdir, img["file"]), img["name"])
            if "media_id" not in up:
                return {"ok": False, "errcode": up.get("errcode", -1),
                        "errmsg": "upload image %d failed: %s" % (i, str(up.get("errmsg")))}
            image_list.append({"image_media_id": up["media_id"]})
        article = {"article_type": "newspic", "title": job["title"], "content": job.get("content", ""),
                   "image_info": {"image_list": image_list},
                   "need_open_comment": 0, "only_fans_can_comment": 0}
        dr = api_post_json("/draft/add", {"access_token": token}, {"articles": [article]})
        if "media_id" not in dr:
            return {"ok": False, "errcode": dr.get("errcode", -1),
                    "errmsg": "draft/add newspic failed: " + str(dr.get("errmsg"))}
        return {"ok": True, "media_id": dr["media_id"]}
    elif kind == "article":
        cover = job["cover"]
        up = upload_image(os.path.join(workdir, cover["file"]), cover["name"])
        if "media_id" not in up:
            return {"ok": False, "errcode": up.get("errcode", -1),
                    "errmsg": "upload cover failed: " + str(up.get("errmsg"))}
        html = job["html"]
        for i, img in enumerate(job.get("images", []), start=1):
            r = upload_image(os.path.join(workdir, img["file"]), img["name"])
            if "url" not in r:
                return {"ok": False, "errcode": r.get("errcode", -1),
                        "errmsg": "upload body image %d failed: %s" % (i, str(r.get("errmsg")))}
            html = html.replace("__WECHAT_IMG_%d__" % i, r["url"])
        article = {"title": job["title"], "author": job.get("author", ""),
                   "digest": job.get("digest", ""), "content": html,
                   "content_source_url": "", "thumb_media_id": up["media_id"],
                   "need_open_comment": 0, "only_fans_can_comment": 0}
        dr = api_post_json("/draft/add", {"access_token": token}, {"articles": [article]})
        if "media_id" not in dr:
            return {"ok": False, "errcode": dr.get("errcode", -1),
                    "errmsg": "draft/add failed: " + str(dr.get("errmsg"))}
        return {"ok": True, "media_id": dr["media_id"]}
    return {"ok": False, "errcode": -2, "errmsg": "unknown kind: " + str(kind)}


# ---------------- job loop ----------------

def load_done():
    done = set()
    if os.path.exists(DONELOG):
        with open(DONELOG, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        done.add(json.loads(line)["job_id"])
                    except Exception:
                        pass
    return done


def mark_done(job_id):
    with open(DONELOG, "a", encoding="utf-8") as f:
        f.write(json.dumps({"job_id": job_id, "ts": datetime.now(timezone.utc).isoformat()}) + "\n")
    # cap the log at ~500 entries
    try:
        with open(DONELOG, encoding="utf-8") as f:
            lines = f.readlines()
        if len(lines) > 500:
            with open(DONELOG, "w", encoding="utf-8") as f:
                f.writelines(lines[-500:])
    except Exception:
        pass


def handle_job(msg):
    body = msg.get("body") or {}
    job_id = str(body.get("job_id", ""))
    kind = body.get("kind", "?")
    account = body.get("account", "?")
    sender = msg.get("from", "Muse")
    log("job <- id=%s kind=%s account=%s sender=%s" % (job_id, kind, account, sender))
    workdir = os.path.join(WORKROOT, job_id)
    result = {"job_id": job_id, "account": account}
    try:
        creds = ACCOUNTS.get(account)
        if not creds or not creds.get("appid") or not creds.get("secret"):
            raise ValueError("no credentials configured for account %r" % account)
        os.makedirs(workdir, exist_ok=True)
        # materialize base64 images to files
        files = []
        for key in ("images",):
            for img in body.get(key, []):
                fname = "img_%d_%s" % (len(files), img.get("name", "img.jpg").replace("/", "_"))
                with open(os.path.join(workdir, fname), "wb") as f:
                    f.write(base64.b64decode(img["data"]))
                files.append(fname)
                img["file"] = fname
        if body.get("cover"):
            cov = body["cover"]
            fname = "cover_" + cov.get("name", "cover.jpg").replace("/", "_")
            with open(os.path.join(workdir, fname), "wb") as f:
                f.write(base64.b64decode(cov["data"]))
            cov["file"] = fname
        r = wechat_push(body, workdir, creds["appid"], creds["secret"])
        result.update(r)
    except Exception as e:
        result.update({"ok": False, "errcode": -3,
                       "errmsg": "agent error: %s: %s" % (type(e).__name__, str(e)[:200])})
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    log("job done id=%s ok=%s media_id=%s errmsg=%s" %
        (job_id, result.get("ok"), result.get("media_id"), str(result.get("errmsg"))[:120]))
    try:
        relay_send(sender, "push_result", result)
    except Exception as e:
        log("failed to send push_result for %s: %s" % (job_id, e))


def load_since():
    p = os.path.join(BASE, ".push-agent-state.json")
    try:
        with open(p, encoding="utf-8") as f:
            return int(json.load(f).get("since", 0))
    except Exception:
        return 0


def save_since(v):
    p = os.path.join(BASE, ".push-agent-state.json")
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"since": int(v)}, f)
    os.replace(tmp, p)


def main():
    since = load_since()
    done = load_done()
    log("push_agent starting; since=%d done=%d" % (since, len(done)))
    while True:
        try:
            res = relay_get("/poll?me=push_agent&since=%d" % since)
        except Exception as e:
            log("poll error: %s: %s" % (type(e).__name__, str(e)[:120]))
            time.sleep(3)
            continue
        msgs = res.get("messages", [])
        for m in msgs:
            if m.get("type") == "push_job" and isinstance(m.get("body"), dict):
                jid = str(m["body"].get("job_id", ""))
                if jid and jid in done:
                    log("job %s already done, skipping" % jid)
                elif jid:
                    done.add(jid)
                    handle_job(m)
                    mark_done(jid)
                else:
                    log("push_job without job_id, ignoring")
        if msgs:
            since = int(res.get("last_id", since))
            save_since(since)


if __name__ == "__main__":
    main()
