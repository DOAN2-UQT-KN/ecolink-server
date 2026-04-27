from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/ecolink"
    jwt_secret: str = ""
    openai_api_key: str = ""
    openai_base_url: Optional[str] = None
    openai_chat_model: str = "gpt-4o-mini"
    auto_create_db_tables: bool = True
    cors_origin: str = "*"
    incident_api_base_url: str = "http://localhost:3001"


settings = Settings()
