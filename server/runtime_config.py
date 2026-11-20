"""Server-only deployment settings. Never copied into the browser bundle."""
from __future__ import annotations

import json
import os
import secrets
import hmac
import re
import threading
import time
from collections import deque
from contextlib import contextmanager
from http.cookies import CookieError, SimpleCookie
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_BASE_URL = "https://ai.ctaigw.cn/v1"
DEFAULT_MODEL = "deepseek-v4-flash-0731-new"


def judge_mode() -> bool:
    return os.environ.get("ZHAI_JUDGE_MODE") == "1"


class JudgeAccess:
    """Issue browser workspaces and bound spending on the shared model account."""

    cookie_name = "zhai_judge"

    def __init__(self, root: Path):
        # main() holds the exclusive data_lock throughout the service lifetime.
        path = root / ".judge-cookie-key"
        if not path.exists():
            temporary = path.with_suffix(".tmp")
            temporary.unlink(missing_ok=True)
            with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as out:
                out.write(secrets.token_bytes(32))
                out.flush()
                os.fsync(out.fileno())
            temporary.replace(path)
        self.key = path.read_bytes()
        if len(self.key) != 32:
            raise ValueError("匿名会话签名配置损坏")
        self.root = root / "visitors"
        self.lock = threading.Lock()
        self.requests: deque[tuple[float, Path]] = deque()
        self.active = 0

    def browser(self, header: str) -> tuple[Path, str | None]:
        cookie = SimpleCookie()
        try:
            cookie.load(header)
        except CookieError:
            pass
        item = cookie.get(self.cookie_name)
        token = item.value if item else ""
        nonce, _, supplied = token.partition(".")
        if re.fullmatch(r"[a-f0-9]{48}", nonce):
            expected = hmac.digest(self.key, nonce.encode(), "sha256").hex()
            if hmac.compare_digest(supplied.encode(), expected.encode()):
                return self.root / nonce, None
        nonce = secrets.token_hex(24)
        signature = hmac.digest(self.key, nonce.encode(), "sha256").hex()
        secure = "; Secure" if os.environ.get("ZHAI_COOKIE_SECURE", "1") != "0" else ""
        token = f"{self.cookie_name}={nonce}.{signature}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax{secure}"
        return self.root / nonce, token

    @contextmanager
    def model_request(self, workspace: Path):
        with self.lock:
            now = time.monotonic()
            while self.requests and self.requests[0][0] <= now - 60:
                self.requests.popleft()
            if self.active >= 4 or len(self.requests) >= 60 or sum(owner == workspace for _, owner in self.requests) >= 20:
                raise ValueError("当前模型请求较多，请稍后再试")
            self.requests.append((now, workspace))
            self.active += 1
        try:
            yield
        finally:
            with self.lock:
                self.active -= 1


def load_config(root: Path) -> None:
    path = Path(os.environ.get("ZHAI_CONFIG_FILE", str(root / "private-config.json")))
    if path.is_file():
        values = json.loads(path.read_text(encoding="utf-8-sig"))
        allowed = {"ZHAI_LLM_BASE_URL", "ZHAI_LLM_MODEL", "ZHAI_LLM_NAME", "ZHAI_LLM_API_KEY", "ZHAI_ACCESS_USER", "ZHAI_ACCESS_PASSWORD"}
        for name, value in values.items():
            if name not in allowed or not isinstance(value, str):
                raise ValueError("服务器配置包含不支持的字段")
            os.environ.setdefault(name, value)
    os.environ.setdefault("ZHAI_LLM_BASE_URL", DEFAULT_BASE_URL)
    os.environ.setdefault("ZHAI_LLM_MODEL", DEFAULT_MODEL)
    os.environ.setdefault("ZHAI_LLM_NAME", "单位算力 · DeepSeek")


def model_settings(payload: dict) -> tuple[str, str, str]:
    default_url = os.environ.get("ZHAI_LLM_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    url = str(payload.get("baseUrl") or default_url).rstrip("/")
    supplied_key = str(payload.get("apiKey") or "").strip()
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("模型服务地址必须是有效的 HTTPS 地址")
    if judge_mode():
        model = os.environ.get("ZHAI_LLM_MODEL", DEFAULT_MODEL)
        if url != default_url or supplied_key or (payload.get("model") and payload["model"] != model):
            raise ValueError("评委版使用部署方配置的模型服务")
        return default_url, os.environ.get("ZHAI_LLM_API_KEY", ""), model
    # A changed endpoint must never receive the institution's server-side key.
    if not supplied_key and url != default_url:
        raise ValueError("使用自定义接口时，请同时填写你自己的 API Key；单位密钥只用于预设算力地址")
    key = supplied_key or os.environ.get("ZHAI_LLM_API_KEY", "")
    model = str(payload.get("model") or os.environ.get("ZHAI_LLM_MODEL", DEFAULT_MODEL))
    return url, key, model


def safe_error(exc: Exception) -> str:
    message = str(exc)
    for name in ("ZHAI_LLM_API_KEY", "ZHAI_ACCESS_PASSWORD"):
        value = os.environ.get(name)
        if value:
            message = message.replace(value, "[已隐藏]")
    return message
