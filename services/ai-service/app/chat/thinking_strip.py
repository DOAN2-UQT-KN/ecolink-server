"""Remove model-internal "thinking" blocks from streamed or stored assistant text."""

from __future__ import annotations

import re

_BQ = "\u0060"  # backtick — some models emit ``think`` fences
_LT, _GT, _SL = "\u003c", "\u003e", "\u002f"

# Opening tags seen from various providers / training artifacts
_THINK_PATTERNS: tuple[str, ...] = (
    f"{_BQ}{_BQ}think{_BQ}{_BQ}",
    f"{_BQ}think{_BQ}",  # `think` … `think` (single backticks)
    f"{_LT}think{_GT}",
    f"{_LT}thinking{_GT}",
    f"{_LT}thought{_GT}",
    f"{_LT}\x72\x65\x64\x61\x63\x74\x65\x64\x5f\x74\x68\x69\x6e\x6b\x69\x6e\x67{_GT}",
)

# Closing tags (fence style often mirrors open; XML uses explicit close)
_THINK_END: tuple[str, ...] = (
    f"{_BQ}{_BQ}think{_BQ}{_BQ}",
    f"{_BQ}think{_BQ}",
    f"{_LT}{_SL}think{_GT}",
    f"{_LT}{_SL}thinking{_GT}",
    f"{_LT}{_SL}thought{_GT}",
    f"{_LT}{_SL}\x72\x65\x64\x61\x63\x74\x65\x64\x5f\x74\x68\x69\x6e\x6b\x69\x6e\x67{_GT}",
)

# Combined regex: any supported think block (non-greedy body)
_THINK_BLOCK_RE = re.compile(
    "(?:" + "|".join(re.escape(p) for p in _THINK_PATTERNS) + r").*?(?:" + "|".join(re.escape(p) for p in _THINK_END) + r")",
    re.DOTALL | re.IGNORECASE,
)


def strip_thinking(text: str) -> str:
    """Remove complete thinking blocks; collapse excessive blank lines."""
    if not text:
        return text
    cleaned = _THINK_BLOCK_RE.sub("", text)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


class ThinkingStreamFilter:
    """
    Incrementally strip thinking blocks from streamed chunks so users never see
    raw reasoning tags. Handles chunk boundaries that split tags.
    """

    def __init__(self) -> None:
        self._buf = ""
        self._in_think = False

    def feed(self, piece: str) -> str:
        self._buf += piece
        out: list[str] = []
        while True:
            if self._in_think:
                end_idx = _find_think_end(self._buf)
                if end_idx < 0:
                    return "".join(out)
                self._buf = self._buf[end_idx:]
                self._in_think = False
                continue

            start_idx = _find_think_start(self._buf)
            if start_idx < 0:
                emit, keep = _safe_emit_prefix(self._buf)
                self._buf = keep
                if emit:
                    out.append(emit)
                return "".join(out)

            before = self._buf[:start_idx]
            self._buf = self._buf[start_idx:]
            after_open = _consume_think_open(self._buf)
            if after_open is None:
                # Incomplete opening tag — hold everything from first '<' onward
                lt = before.rfind("<")
                if lt >= 0:
                    out.append(before[:lt])
                    self._buf = before[lt:] + self._buf
                else:
                    out.append(before)
                return "".join(out)

            self._buf = after_open
            self._in_think = True
            if before:
                out.append(before)

    def flush(self) -> str:
        """Emit any remaining safe text (drops incomplete think opener tail)."""
        if self._in_think:
            self._buf = ""
            self._in_think = False
            return ""
        emit, _keep = _safe_emit_prefix(self._buf)
        self._buf = ""
        return emit


def _safe_emit_prefix(s: str) -> tuple[str, str]:
    """Emit a prefix of *s* that cannot be the start of a think-tag; keep the rest."""
    if not s:
        return "", ""
    max_keep = max(len(p) for p in _THINK_PATTERNS) - 1
    max_keep = max(max_keep, 0)
    for k in range(min(max_keep, len(s)), 0, -1):
        suffix = s[-k:]
        if any(p.startswith(suffix) for p in _THINK_PATTERNS):
            return s[:-k], s[-k:]
    return s, ""


def _find_think_start(buf: str) -> int:
    best = -1
    for p in _THINK_PATTERNS:
        i = buf.find(p)
        if i >= 0 and (best < 0 or i < best):
            best = i
    return best


def _find_think_end(buf: str) -> int:
    best = -1
    best_len = 0
    for p in _THINK_END:
        i = buf.find(p)
        if i >= 0 and (best < 0 or i < best or (i == best and len(p) > best_len)):
            best = i
            best_len = len(p)
    if best < 0:
        return -1
    return best + best_len


def _consume_think_open(buf: str) -> str | None:
    """If buf starts with a full opening tag, return text after it; else None."""
    for p in _THINK_PATTERNS:
        if buf.startswith(p):
            return buf[len(p) :]
    return None
