from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from typing import Any, Optional

from openai.types.chat import ChatCompletionMessageParam
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.prompts import system_prompt_for_agent
from app.chat.media_fetch import fetch_chat_media_url_map
from app.chat.user_message_media import (
    format_append_text_for_media_ids,
    parse_media_ids_from_append_text,
    parse_user_message_media_ids,
)
from app.chat.sse import format_sse
from app.chat.thinking_strip import ThinkingStreamFilter, strip_thinking
from app.config import settings
from app.db.models import ChatMessage, ChatMessageRole
from app.llm.openai_chat import build_client
from app.repositories.chat import ChatRepository
from app.tools.registry import find_tool, openai_tools_for_agent


async def build_openai_messages_from_rows(
    system_text: str,
    rows: list[ChatMessage],
    session: AsyncSession,
    user_id: uuid.UUID,
) -> list[ChatCompletionMessageParam]:
    out: list[ChatCompletionMessageParam] = [
        {"role": "system", "content": system_text},
    ]
    for m in rows:
        if m.role == ChatMessageRole.user:
            append_raw = getattr(m, "append_text", None)
            mids = parse_media_ids_from_append_text(
                append_raw if isinstance(append_raw, str) else None
            )
            base = (m.content or "").strip()
            if not mids:
                base_legacy, mids_legacy = parse_user_message_media_ids(m.content)
                if mids_legacy:
                    base, mids = base_legacy.strip(), mids_legacy
            if not mids:
                out.append({"role": "user", "content": m.content or ""})
                continue
            url_map = await fetch_chat_media_url_map(session, user_id, mids)
            hint = (
                "[User attached image(s). media_id values: "
                + ", ".join(mids)
                + ". Use list_chat_media_by_ids for URLs/metadata if needed.]\n\n"
            )
            user_lines = base if base else "(No text; images only.)"
            append_blk = (
                str(append_raw).strip()
                if isinstance(append_raw, str) and str(append_raw).strip()
                else ""
            )
            agent_ctx = (
                f"\n\n[Attachment metadata for agent]\n{append_blk}"
                if append_blk
                else ""
            )
            text_part = (hint + user_lines + agent_ctx).strip()
            parts: list[dict[str, Any]] = [{"type": "text", "text": text_part}]
            for mid in mids:
                u = url_map.get(mid)
                if u:
                    parts.append({"type": "image_url", "image_url": {"url": u}})
            out.append({"role": "user", "content": parts})  # type: ignore[arg-type]
        elif m.role == ChatMessageRole.assistant:
            item: dict[str, Any] = {"role": "assistant"}
            if m.content:
                item["content"] = m.content
            if m.tool_calls is not None:
                item["tool_calls"] = m.tool_calls
            out.append(item)  # type: ignore[arg-type]
        elif m.role == ChatMessageRole.tool:
            out.append(
                {
                    "role": "tool",
                    "tool_call_id": m.tool_call_id or "",
                    "content": m.content or "",
                }
            )
    return out


async def stream_chat_turn(
    repo: ChatRepository,
    user_id: uuid.UUID,
    conversation_id: uuid.UUID,
    user_text: str,
    access_token: str,
    media_ids: Optional[list[str]] = None,
) -> AsyncIterator[str]:
    conv = await repo.get_conversation_for_user(
        conversation_id, user_id, load_messages=False
    )
    if conv is None:
        yield format_sse("error", {"message": "Conversation not found"})
        return

    if not settings.openai_api_key:
        yield format_sse("error", {"message": "OPENAI_API_KEY is not configured"})
        return

    agent_id = conv.agent_id
    tools = openai_tools_for_agent(agent_id)
    client = build_client()
    model = settings.openai_chat_model

    append = format_append_text_for_media_ids(media_ids) or None
    await repo.add_user_message(conv.id, user_text.strip(), append)

    conv = await repo.get_conversation_for_user(
        conversation_id, user_id, load_messages=True
    )
    if conv is None:
        yield format_sse("error", {"message": "Conversation not found"})
        return

    rows = sorted(conv.messages, key=lambda m: m.created_at)
    system_text = system_prompt_for_agent(agent_id)
    api_messages = await build_openai_messages_from_rows(
        system_text, rows, repo.session, user_id
    )

    max_rounds = 8
    for _ in range(max_rounds):
        tool_calls_acc: dict[int, dict[str, Any]] = {}
        content_buf: list[str] = []
        think_filter = ThinkingStreamFilter()
        finish_reason: Optional[str] = None

        kwargs: dict[str, Any] = {
            "model": model,
            "messages": api_messages,
            "stream": True,
        }
        if tools:
            kwargs["tools"] = tools

        stream = await client.chat.completions.create(**kwargs)

        async for chunk in stream:
            ch = chunk.choices[0]
            if ch.finish_reason:
                finish_reason = ch.finish_reason
            delta = ch.delta
            if delta and delta.content:
                piece = delta.content
                content_buf.append(piece)
                filtered = think_filter.feed(piece)
                if filtered:
                    yield format_sse("token", {"text": filtered})
            if delta and delta.tool_calls:
                for tc in delta.tool_calls:
                    idx = tc.index
                    slot = tool_calls_acc.setdefault(
                        idx,
                        {
                            "id": "",
                            "type": "function",
                            "function": {"name": "", "arguments": ""},
                        },
                    )
                    if tc.id:
                        slot["id"] = tc.id
                    if tc.function:
                        if tc.function.name:
                            slot["function"]["name"] = tc.function.name
                        if tc.function.arguments:
                            slot["function"]["arguments"] += tc.function.arguments

        tail_text = think_filter.flush()
        if tail_text:
            yield format_sse("token", {"text": tail_text})

        raw_assistant = "".join(content_buf)
        assistant_content = strip_thinking(raw_assistant) or None
        ordered_calls = [
            tool_calls_acc[i]
            for i in sorted(tool_calls_acc.keys())
            if tool_calls_acc[i].get("id")
        ]

        if finish_reason == "tool_calls" and ordered_calls:
            tool_calls_json: list[dict[str, Any]] = []
            for c in ordered_calls:
                tool_calls_json.append(
                    {
                        "id": c["id"],
                        "type": "function",
                        "function": {
                            "name": c["function"]["name"],
                            "arguments": c["function"]["arguments"],
                        },
                    }
                )
            await repo.add_assistant_with_tool_calls(
                conv.id, assistant_content, tool_calls_json
            )

            asst_api: dict[str, Any] = {
                "role": "assistant",
                "tool_calls": tool_calls_json,
            }
            if assistant_content:
                asst_api["content"] = assistant_content
            else:
                asst_api["content"] = None
            api_messages.append(asst_api)  # type: ignore[arg-type]

            ctx: dict[str, Any] = {
                "chat_repo": repo,
                "user_id": str(user_id),
                "access_token": access_token,
            }

            for call in tool_calls_json:
                fn = call["function"]
                name = fn["name"]
                raw_args = fn.get("arguments") or "{}"
                try:
                    args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                except json.JSONDecodeError:
                    args = {}

                yield format_sse("tool_start", {"tool_call_id": call["id"], "name": name})

                tool = find_tool(agent_id, name)
                if tool is None:
                    result = json.dumps({"error": f"Unknown tool: {name}"})
                else:
                    try:
                        result = await tool.handler(args, ctx)
                    except Exception as e:  # noqa: BLE001
                        result = json.dumps({"error": str(e)})

                yield format_sse(
                    "tool_end",
                    {
                        "tool_call_id": call["id"],
                        "name": name,
                        "result_preview": result[:500],
                    },
                )

                await repo.add_tool_result(conv.id, call["id"], result)
                api_messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call["id"],
                        "content": result,
                    }
                )

            await repo.commit()
            continue

        msg_id = await repo.add_assistant_final(conv.id, assistant_content)
        yield format_sse("done", {"message_id": str(msg_id)})
        return

    yield format_sse("error", {"message": "Too many tool rounds; aborting."})
