from __future__ import annotations

import json
from typing import Any, Optional

from app.chat.thinking_strip import strip_thinking
from app.config import settings
from app.llm.openai_chat import build_client

SYSTEM_PROMPT = """Bạn viết nội dung đăng Facebook cho một chiến dịch tình nguyện môi trường (EcoLink) vừa hoàn thành.
Yêu cầu:
- Tiếng Việt, giọng ấm, ngắn gọn (tối đa khoảng 900 ký tự), phù hợp mạng xã hội.
- **Bắt buộc có một đoạn rõ ràng vinh danh / tri ân các tình nguyện viên** đã tham gia (không chỉ nói chung chung). JSON có `volunteers`: mỗi phần tử gồm `name` và có thể có `email`. **Chỉ dùng tên (`name`) trong nội dung đăng công khai**; `email` chỉ để bạn nắm ngữ cảnh nội bộ — **tuyệt đối không** chép địa chỉ email hay dữ liệu nhạy cảm vào bài đăng Facebook. Nếu nhiều hơn ~8 người thì nhắc vài tên tiêu biểu + “cùng các bạn đồng hành” / số người còn lại. Nếu không có `volunteers` nhưng `volunteer_count` > 0, cảm ơn theo số người. **Nếu `volunteer_count` >= 1 hoặc `volunteers` không rỗng, không được viết rằng không ai tham gia / “chưa có anh em”.** Nếu `volunteer_count` = 0 và `volunteers` rỗng, ghi nhận chiến dịch đã hoàn thành, lời mời đồng hành lần sau — tránh ngữ điệu trách người đọc.
- Nhắc tên chiến dịch (`campaign_title`), tinh thần bảo vệ môi trường; có thể 2–5 câu, emoji nhẹ (1–3) nếu hợp.
- KHÔNG dùng Markdown (không #, không **), KHÔNG checklist dài.
- Chỉ trả về nội dung bài đăng, không giải thích, không tiêu đề kiểu "Bài đăng".
"""


async def generate_campaign_facebook_caption(
    *,
    campaign_title: str,
    volunteer_count: int,
    completed_at: str,
    volunteers: list[dict[str, Any]],
    banner_url: Optional[str] = None,
    description: Optional[str] = None,
) -> str:
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured")

    client = build_client()
    model = settings.openai_chat_model

    payload: dict[str, Any] = {
        "campaign_title": campaign_title,
        "volunteer_count": volunteer_count,
        "volunteers": volunteers,
        "completed_at": completed_at,
        "banner_url": banner_url,
        "description_excerpt": (description or "")[:4000],
    }

    r = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": json.dumps(payload, ensure_ascii=False),
            },
        ],
        temperature=0.55,
    )

    content = (r.choices[0].message.content or "").strip()
    content = strip_thinking(content)
    if not content:
        raise RuntimeError("LLM returned empty caption")
    return content
