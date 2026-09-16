import enum
import uuid
from datetime import datetime
from typing import Any, Optional, Union

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    Index,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class ChatMessageRole(str, enum.Enum):
    system = "system"
    user = "user"
    assistant = "assistant"
    tool = "tool"


class AiChatMedia(Base):
    """Hosted image URL for EcoLink assistant chat (Cloudinary, etc.) — owned by user."""

    __tablename__ = "ai_chat_media"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ChatConversation(Base):
    __tablename__ = "ai_chat_conversations"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    agent_id: Mapped[str] = mapped_column(String(64), index=True)
    title: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    messages: Mapped[list["ChatMessage"]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan"
    )


class ChatMessage(Base):
    __tablename__ = "ai_chat_messages"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("ai_chat_conversations.id", ondelete="CASCADE"),
        index=True,
    )
    role: Mapped[ChatMessageRole] = mapped_column()
    content: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Extra text for the model only (e.g. `media_ids:` block); not shown as the user bubble body.
    append_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    tool_calls: Mapped[Optional[Union[dict[str, Any], list[Any]]]] = mapped_column(
        JSONB, nullable=True
    )
    tool_call_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    conversation: Mapped["ChatConversation"] = relationship(back_populates="messages")


class AiMediaContentHash(Base):
    """Corpus of image content hashes for duplicate detection (SHA256 / PHASH)."""

    __tablename__ = "ai_media_content_hashes"
    __table_args__ = (
        UniqueConstraint("media_id", "algorithm", name="uq_ai_media_hash_media_algo"),
        Index("ix_ai_media_content_hashes_algorithm_hash", "algorithm", "hash"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    report_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    report_media_file_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), index=True
    )
    media_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), nullable=True, index=True
    )
    algorithm: Mapped[str] = mapped_column(String(50), nullable=False)
    hash: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class AiMediaOrbFeature(Base):
    """Stored ORB keypoints and descriptors for feature-matching duplicates."""

    __tablename__ = "ai_media_orb_features"
    __table_args__ = (
        UniqueConstraint("media_id", name="uq_ai_media_orb_media"),
        Index("ix_ai_media_orb_features_user_id", "user_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    report_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    report_media_file_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), index=True
    )
    media_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), nullable=True, index=True
    )
    keypoints: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    descriptors: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    keypoint_count: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
