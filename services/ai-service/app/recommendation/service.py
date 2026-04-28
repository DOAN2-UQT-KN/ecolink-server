from __future__ import annotations

import json
from typing import Any

from app.config import settings
from app.chat.thinking_strip import strip_thinking
from app.llm.openai_chat import build_client


SYSTEM_PROMPT = """You are an assistant helping volunteers prepare for a cleanup task.
You receive:
- image URLs (context)
- detected waste objects with labels, confidences, and bounding boxes

Write the recommendation in Vietnamese **as Markdown**.
Use short sections and bullet points. Include:

## Nên mang theo
- ...

## Cảnh báo an toàn
- ...

## Cách thu gom & phân loại
- ...

## Gợi ý thêm
- ...

If detections are uncertain, still provide a sensible general checklist.
Return ONLY Markdown. Do not wrap in JSON.
Never include hidden reasoning or any <think>...</think> / `think` blocks.
"""


def _compact_detection_payload(detections: list[dict[str, Any]]) -> str:
    # Keep prompt small: just key info.
    return json.dumps(detections, ensure_ascii=False)


async def generate_recommendation(
    *,
    image_urls: list[str],
    detections: list[dict[str, Any]],
) -> str:
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured")

    client = build_client()
    model = settings.openai_chat_model

    user_payload = {
        "image_urls": image_urls,
        "detections": detections,
        "notes": "detections items are per-image; each item may include boxes[]",
    }

    r = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": _compact_detection_payload([user_payload]),
            },
        ],
        temperature=0.4,
    )

    content = (r.choices[0].message.content or "").strip()
    content = strip_thinking(content)
    if not content:
        raise RuntimeError("LLM returned empty recommendation")
    return content

