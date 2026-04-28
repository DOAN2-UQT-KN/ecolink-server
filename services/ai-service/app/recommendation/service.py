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
Make it clean, easy to scan on mobile, and actionable.

Output format requirements:
- Use these exact top-level sections, in this order.
- Use bullet lists with consistent style. Prefer checklists: "- [ ] item".
- Keep lines short. Avoid long paragraphs.
- If detections are uncertain or missing, say so briefly and still provide a sensible general checklist.
- Return ONLY Markdown. Do not wrap in JSON.
- Never include hidden reasoning or any <think>...</think> / `think` blocks.

Use this template:

## Tóm tắt nhanh
- **Khu vực**: (suy đoán ngắn gọn từ ảnh nếu có, nếu không ghi "Chưa rõ")
- **Mức độ rủi ro**: Thấp / Trung bình / Cao (chọn 1) — 1 câu lý do
- **Ưu tiên**: 2–4 gạch đầu dòng (việc quan trọng nhất trước)

## Dựa trên phát hiện (nếu có)
- Liệt kê 3–8 loại rác nổi bật theo dạng: "**nhãn** (độ tin cậy ~xx%) — gợi ý xử lý 1 dòng"
- Nếu không chắc, ghi: "Phát hiện chưa chắc chắn; dưới đây là checklist chung."

## Nên mang theo
### Bắt buộc
- [ ] ...
### Nên có
- [ ] ...
### Tuỳ chọn
- [ ] ...

## Cảnh báo an toàn
- [ ] ...

## Cách thu gom & phân loại
### Cách nhặt & đóng gói
- [ ] ...
### Phân loại nhanh
- **Tái chế**: ...
- **Không tái chế / rác thải thường**: ...
- **Nguy hại** (pin, kim tiêm, hoá chất, vật sắc nhọn): ...

## Gợi ý thêm
- [ ] ...
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

