from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.recommendation.service import generate_recommendation


router = APIRouter(tags=["recommendations"])


class DetectionBox(BaseModel):
    label: str
    class_id: int
    confidence: float
    bbox: dict[str, float]


class DetectionResult(BaseModel):
    source_url: str
    detections: Optional[int] = None
    predicted_url: Optional[str] = None
    boxes: list[DetectionBox] = Field(default_factory=list)


class RecommendationRequest(BaseModel):
    image_urls: list[str] = Field(..., min_length=1)
    results: list[DetectionResult] = Field(default_factory=list)


class RecommendationResponse(BaseModel):
    recommendation: str


@router.post("/report", response_model=RecommendationResponse)
async def recommend_for_report(payload: RecommendationRequest) -> Any:
    try:
        rec = await generate_recommendation(
            image_urls=payload.image_urls,
            detections=[r.model_dump() for r in payload.results],
        )
        return {"recommendation": rec}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

