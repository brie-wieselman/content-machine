"""Anthropic API transport for orchestrator agents — Python stdlib only.

STREAMING IS MANDATORY here, not an optimization: many networks (corporate
proxies, some home routers, certain HTTP/2 middleboxes) kill any HTTP
response that has sent zero bytes for ~60 seconds. A long generation
through a non-streaming call sits silent for the whole generation and WILL
flap on such a network. This module always requests stream=True and
reassembles the SSE events into the classic message shape, so the
connection is never idle while the model thinks.

Credentials: reads ANTHROPIC_API_KEY from the environment first, then from
the repo-root .env file (the same secrets file the node agents use).
Model: "claude-sonnet-5" by default; override with the ANTHROPIC_MODEL env
var. Mock mode: if ORCH_MOCK=1, generate() returns a canned deterministic
response and never touches the network.
"""
import json
import os
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = os.path.join(ROOT, ".env")
API_URL = "https://api.anthropic.com/v1/messages"
DEFAULT_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5")


def api_key():
    k = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if k:
        return k
    try:
        with open(ENV_FILE) as f:
            for line in f:
                if line.strip().startswith("ANTHROPIC_API_KEY="):
                    return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return ""


def generate(system, user, max_tokens=4000, model=None, timeout=300):
    """Return the assistant's text. Raises RuntimeError on failure."""
    if os.environ.get("ORCH_MOCK") == "1":
        return "[MOCK GENERATION] " + user[:200]
    key = api_key()
    if not key:
        raise RuntimeError("no ANTHROPIC_API_KEY in env or " + ENV_FILE)
    body = json.dumps({
        "model": model or DEFAULT_MODEL,
        "max_tokens": max_tokens,
        "stream": True,
        "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        "messages": [{"role": "user", "content": user}],
    }).encode()
    req = urllib.request.Request(API_URL, data=body, method="POST", headers={
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    })
    text_parts = []
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        for raw in resp:  # SSE lines stream as they arrive — connection never idles
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            try:
                ev = json.loads(line[5:].strip())
            except ValueError:
                continue
            if ev.get("type") == "content_block_delta" and ev.get("delta", {}).get("type") == "text_delta":
                text_parts.append(ev["delta"]["text"])
            elif ev.get("type") == "error":
                raise RuntimeError("API error event: %s" % ev.get("error"))
    out = "".join(text_parts).strip()
    if not out:
        raise RuntimeError("empty generation (streamed no text deltas)")
    return out
