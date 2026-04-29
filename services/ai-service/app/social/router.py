from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.social.service import generate_campaign_facebook_caption

router = APIRouter(tags=["social"])


class VolunteerRef(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str = Field(min_length=1, max_length=120)
    email: Optional[str] = Field(None, max_length=320)

    @field_validator("name", mode="before")
    @classmethod
    def strip_name(cls, v: object) -> str:
        if not isinstance(v, str):
            raise ValueError("name must be a string")
        return v.strip()

    @field_validator("email", mode="before")
    @classmethod
    def norm_email(cls, v: object) -> Optional[str]:
        if v is None or v == "":
            return None
        if not isinstance(v, str):
            raise ValueError("email must be a string")
        s = v.strip().lower()
        return s if s else None


class CampaignFacebookCaptionRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    campaign_title: str = Field(alias="campaignTitle", min_length=1, max_length=500)
    volunteer_count: int = Field(alias="volunteerCount", ge=0)
    completed_at: str = Field(alias="completedAt", min_length=1, max_length=80)
    banner_url: Optional[str] = Field(None, alias="bannerUrl", max_length=2048)
    campaign_description: Optional[str] = Field(
        None, alias="description", max_length=8000
    )
    volunteers: list[VolunteerRef] = Field(
        default_factory=list, alias="volunteers", max_length=80
    )

    @field_validator("banner_url")
    @classmethod
    def banner_if_set(cls, v: Optional[str]) -> Optional[str]:
        if v is None or v == "":
            return None
        s = v.strip()
        if not s.startswith(("https://", "http://")):
            raise ValueError("bannerUrl must be an http(s) URL when provided")
        return s


class CampaignFacebookCaptionResponse(BaseModel):
    caption: str


@router.post("/campaign-facebook-caption", response_model=CampaignFacebookCaptionResponse)
async def campaign_facebook_caption(payload: CampaignFacebookCaptionRequest) -> Any:
    try:
        vol_dump = [
            {"name": v.name, "email": v.email} for v in payload.volunteers
        ]
        caption = await generate_campaign_facebook_caption(
            campaign_title=payload.campaign_title,
            volunteer_count=payload.volunteer_count,
            completed_at=payload.completed_at,
            volunteers=vol_dump,
            banner_url=payload.banner_url,
            description=payload.campaign_description,
        )
        return {"caption": caption}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
