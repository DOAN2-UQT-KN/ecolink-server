"""Chat persistence — ORM access via SQLAlchemy models, no raw SQL in callers."""

from __future__ import annotations

import uuid
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.models import ChatConversation, ChatMessage, ChatMessageRole


class ChatRepository:
    """All chat DB operations for this request go through one session-bound repository."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    @property
    def session(self) -> AsyncSession:
        """Escape hatch for tools that need low-level session access."""
        return self._session

    async def get_conversation_for_user(
        self,
        conversation_id: uuid.UUID,
        user_id: uuid.UUID,
        *,
        load_messages: bool = False,
    ) -> Optional[ChatConversation]:
        q = select(ChatConversation).where(
            ChatConversation.id == conversation_id,
            ChatConversation.user_id == user_id,
        )
        if load_messages:
            q = q.options(selectinload(ChatConversation.messages))
        res = await self._session.execute(q)
        return res.scalar_one_or_none()

    async def create_conversation(
        self,
        user_id: uuid.UUID,
        agent_id: str,
        title: Optional[str],
    ) -> ChatConversation:
        conv = ChatConversation(user_id=user_id, agent_id=agent_id, title=title)
        self._session.add(conv)
        await self._session.commit()
        await self._session.refresh(conv)
        return conv

    async def list_messages_for_user(
        self,
        conversation_id: uuid.UUID,
        user_id: uuid.UUID,
    ) -> Optional[list[ChatMessage]]:
        conv = await self.get_conversation_for_user(conversation_id, user_id)
        if conv is None:
            return None
        res = await self._session.execute(
            select(ChatMessage)
            .where(ChatMessage.conversation_id == conversation_id)
            .order_by(ChatMessage.created_at.asc())
        )
        return list(res.scalars().all())

    async def add_user_message(
        self,
        conversation_id: uuid.UUID,
        content: str,
        append_text: Optional[str] = None,
    ) -> None:
        self._session.add(
            ChatMessage(
                conversation_id=conversation_id,
                role=ChatMessageRole.user,
                content=content,
                append_text=append_text,
            )
        )
        await self._session.commit()

    async def add_assistant_with_tool_calls(
        self,
        conversation_id: uuid.UUID,
        content: Optional[str],
        tool_calls: list[dict[str, Any]],
    ) -> None:
        self._session.add(
            ChatMessage(
                conversation_id=conversation_id,
                role=ChatMessageRole.assistant,
                content=content,
                tool_calls=tool_calls,
            )
        )
        await self._session.commit()

    async def add_tool_result(
        self,
        conversation_id: uuid.UUID,
        tool_call_id: str,
        content: str,
    ) -> None:
        self._session.add(
            ChatMessage(
                conversation_id=conversation_id,
                role=ChatMessageRole.tool,
                content=content,
                tool_call_id=tool_call_id,
            )
        )

    async def commit(self) -> None:
        await self._session.commit()

    async def add_assistant_final(
        self,
        conversation_id: uuid.UUID,
        content: Optional[str],
    ) -> uuid.UUID:
        msg = ChatMessage(
            conversation_id=conversation_id,
            role=ChatMessageRole.assistant,
            content=content,
            tool_calls=None,
        )
        self._session.add(msg)
        await self._session.commit()
        await self._session.refresh(msg)
        return msg.id
