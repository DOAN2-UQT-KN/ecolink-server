from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/ecolink"
    jwt_secret: str = ""
    # Shared secret for service-to-service calls hitting `/internal/v1/...`.
    # Callers must send it in the `x-internal-api-key` header.
    internal_ai_api_key: str = ""
    openai_api_key: str = ""
    openai_base_url: Optional[str] = None
    openai_chat_model: str = "gpt-4o-mini"
    auto_create_db_tables: bool = True
    cors_origin: str = "*"
    incident_api_base_url: str = "http://localhost:3001"

    # SQS (REPORT_SUBMITTED → verification pipeline worker)
    sqs_ai_analysis_queue_url: str = ""
    aws_region: str = "us-east-1"
    aws_sqs_endpoint: Optional[str] = None
    aws_access_key_id: str = "test"
    aws_secret_access_key: str = "test"

    # ORB feature matching (duplicate cascade, after SHA-256 / pHash miss).
    orb_ratio_threshold: float = 0.75
    orb_min_good_matches: int = 8
    orb_min_inlier_count: int = 15
    orb_min_inlier_ratio: float = 0.30
    orb_ransac_reproj_threshold: float = 5.0


settings = Settings()
