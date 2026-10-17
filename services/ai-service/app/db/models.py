import enum
import uuid
from datetime import date, datetime
from typing import Any, Optional, Union

from sqlalchemy import (
    BigInteger,
    Date,
    DateTime,
    Float,
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
    """Corpus of image pHashes for duplicate detection (PHASH only since specs/006 P06; SHA256 rows removed)."""

    __tablename__ = "ai_media_content_hashes"
    __table_args__ = (
        UniqueConstraint("media_id", "algorithm", name="uq_ai_media_hash_media_algo"),
        Index("ix_ai_media_content_hashes_algorithm_hash", "algorithm", "hash"),
        Index("ix_ai_media_content_hashes_report_created_at", "report_created_at"),
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
    # Signed 64-bit form of `hash`, so Postgres can XOR + bit_count over the whole corpus.
    phash_int: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    latitude: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    longitude: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    report_created_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    category: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class AiMediaOrbFeature(Base):
    """Stored ORB keypoints and descriptors for feature-matching duplicates."""

    __tablename__ = "ai_media_orb_features"
    __table_args__ = (
        UniqueConstraint("media_id", name="uq_ai_media_orb_media"),
        Index("ix_ai_media_orb_features_report_created_at", "report_created_at"),
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
    latitude: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    longitude: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    report_created_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class AiWebDetectionCache(Base):
    """Filtered Vision WEB_DETECTION candidates per pHash (specs/011). No image bytes, no verdict."""

    __tablename__ = "ai_web_detection_cache"
    __table_args__ = (Index("ix_ai_web_detection_cache_expires_at", "expires_at"),)

    phash: Mapped[str] = mapped_column(String(16), primary_key=True)
    candidates: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class AiWebDetectionUsage(Base):
    """Vision calls per day (Asia/Ho_Chi_Minh), for the daily limit of the signal `internet`."""

    __tablename__ = "ai_web_detection_usage"

    day: Mapped[date] = mapped_column(Date, primary_key=True)
    calls: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
