"""Thin wrapper around the OpenAI Chat Completions API (streaming + tools)."""

from typing import Any

from openai import AsyncOpenAI

from app.config import settings


def build_client() -> AsyncOpenAI:
    kwargs: dict[str, Any] = {"api_key": settings.openai_api_key}
    if settings.openai_base_url:
        kwargs["base_url"] = settings.openai_base_url
    return AsyncOpenAI(**kwargs)
