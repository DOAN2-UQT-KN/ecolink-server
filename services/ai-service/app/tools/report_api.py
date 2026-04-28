"""HTTP tools for creating reports (incident-service)."""

from __future__ import annotations

import json
from typing import Any

from app.tools.definitions import RegisteredTool, ToolContext
from app.tools.incident_client import incident_request_json


def _clean_str(v: Any) -> str:
    return str(v or "").strip()


async def _create_report(args: dict[str, Any], ctx: ToolContext) -> str:
    # Required inputs
    title = _clean_str(args.get("title"))
    if not title:
        return json.dumps({"error": "title is required"})

    detail_address = _clean_str(args.get("detail_address"))
    if not detail_address:
        return json.dumps({"error": "detail_address is required"})

    image_urls_raw = args.get("image_urls")
    if not isinstance(image_urls_raw, list) or len(image_urls_raw) == 0:
        return json.dumps({"error": "image_urls must be a non-empty array of URLs"})
    image_urls = [_clean_str(u) for u in image_urls_raw if _clean_str(u)]
    if not image_urls:
        return json.dumps({"error": "image_urls must contain at least one non-empty URL"})

    # Optional geo
    latitude = args.get("latitude")
    longitude = args.get("longitude")
    try:
        latitude_f = float(latitude) if latitude is not None else None
    except Exception:
        return json.dumps({"error": "latitude must be a number"})
    try:
        longitude_f = float(longitude) if longitude is not None else None
    except Exception:
        return json.dumps({"error": "longitude must be a number"})

    # Optional classification fields (not all are first-class in incident-service today).
    allowed_waste_types = {"household", "construction", "industrial", "hazardous"}
    allowed_conditions = {"newly-appeared", "long-standing", "reappeared"}
    allowed_pollution = {"odor", "leachate", "smoke-fire"}

    waste_types = args.get("waste_types")
    waste_type = _clean_str(args.get("waste_type"))
    if isinstance(waste_types, list):
        wt = [
            s
            for s in (_clean_str(x) for x in waste_types)
            if s and (s in allowed_waste_types)
        ]
        if wt:
            waste_type = ", ".join(dict.fromkeys(wt))
    else:
        # If caller provided waste_type, only accept if it is composed of allowed tokens.
        if waste_type:
            parts = [p.strip() for p in waste_type.split(",") if p.strip()]
            if parts and all(p in allowed_waste_types for p in parts):
                waste_type = ", ".join(dict.fromkeys(parts))
            else:
                waste_type = ""

    condition = _clean_str(args.get("condition"))
    if condition and condition not in allowed_conditions:
        condition = ""
    pollution_levels = args.get("pollution_levels")
    if isinstance(pollution_levels, list):
        pollution_levels_clean = [
            s
            for s in (_clean_str(x) for x in pollution_levels)
            if s and (s in allowed_pollution)
        ]
    else:
        pollution_levels_clean = []
    size = _clean_str(args.get("size"))

    severity_level = args.get("severity_level")
    if severity_level is None and size in {"1", "2", "3"}:
        severity_level = int(size)

    description = _clean_str(args.get("description"))
    if not description:
        waste_type_vi = {
            "household": "rác sinh hoạt",
            "construction": "rác xây dựng",
            "industrial": "rác công nghiệp",
            "hazardous": "rác nguy hại",
        }
        condition_vi = {
            "newly-appeared": "mới xuất hiện",
            "long-standing": "lâu ngày",
            "reappeared": "tái xuất hiện",
        }
        pollution_vi = {
            "odor": "mùi hôi",
            "leachate": "nước rỉ rác",
            "smoke-fire": "khói/lửa",
        }
        size_vi = {"1": "nhỏ", "2": "vừa", "3": "lớn"}

        extra_bits: list[str] = []
        if waste_type:
            parts = [p.strip() for p in waste_type.split(",") if p.strip()]
            parts_vi = [waste_type_vi.get(p, p) for p in parts]
            extra_bits.append(f"Loại rác: {', '.join(parts_vi)}.")
        if condition:
            extra_bits.append(f"Tình trạng: {condition_vi.get(condition, condition)}.")
        if pollution_levels_clean:
            extra_bits.append(
                "Ảnh hưởng: "
                + ", ".join(pollution_vi.get(p, p) for p in pollution_levels_clean)
                + "."
            )
        if size:
            extra_bits.append(f"Kích thước: {size_vi.get(size, size)}.")

        base = "Mình đã nhận được hình ảnh bạn cung cấp và ghi nhận một điểm rác cần được kiểm tra."
        tail = "Vui lòng xem hiện trường để xác nhận và có hướng xử lý phù hợp."
        description = " ".join([base, *extra_bits, tail]).strip()

    payload: dict[str, Any] = {
        "title": title,
        "description": description,
        "detailAddress": detail_address,
        "imageUrls": image_urls,
    }
    if waste_type:
        payload["wasteType"] = waste_type
    if severity_level is not None:
        try:
            payload["severityLevel"] = int(severity_level)
        except Exception:
            return json.dumps({"error": "severity_level must be an integer (1-5)"})
    if latitude_f is not None:
        payload["latitude"] = latitude_f
    if longitude_f is not None:
        payload["longitude"] = longitude_f

    return await incident_request_json(
        "POST",
        "/api/v1/reports",
        ctx,
        json_body=payload,
    )


create_report_tool = RegisteredTool(
    name="create_report",
    description=(
        "Creates an environmental incident report for the authenticated user. "
        "Requires title, detail_address, and image_urls. Optionally include latitude/longitude, "
        "waste_type or waste_types, severity_level or size. condition/pollution_levels can be provided "
        "and will be included in the description if description is omitted."
    ),
    parameters={
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "Report title"},
            "description": {"type": "string", "description": "Optional description (Vietnamese recommended)"},
            "detail_address": {"type": "string", "description": "Human-readable address (required)"},
            "latitude": {"type": "number", "description": "Optional latitude"},
            "longitude": {"type": "number", "description": "Optional longitude"},
            "image_urls": {
                "type": "array",
                "items": {"type": "string"},
                "minItems": 1,
                "description": "Public image URLs for the report (required)",
            },
            "waste_type": {
                "type": "string",
                "description": "Optional waste type string (incident-service field). If waste_types is provided, this is ignored.",
            },
            "waste_types": {
                "type": "array",
                "items": {
                    "type": "string",
                    "enum": ["household", "construction", "industrial", "hazardous"],
                },
                "description": "Optional list of waste type codes (UI values). Joined into waste_type.",
            },
            "severity_level": {
                "type": "integer",
                "description": "Optional severity level (1-5). If omitted and size is 1/2/3, size is mapped to severity_level.",
            },
            "size": {
                "type": "string",
                "enum": ["1", "2", "3"],
                "description": "Optional size (1=Small,2=Medium,3=Large). Used as severity_level if severity_level omitted.",
            },
            "condition": {
                "type": "string",
                "enum": ["newly-appeared", "long-standing", "reappeared"],
                "description": "Optional condition (newly-appeared|long-standing|reappeared). Included in description if description omitted.",
            },
            "pollution_levels": {
                "type": "array",
                "items": {
                    "type": "string",
                    "enum": ["odor", "leachate", "smoke-fire"],
                },
                "description": "Optional pollution levels (odor|leachate|smoke-fire). Included in description if description omitted.",
            },
        },
        "required": ["title", "detail_address", "image_urls"],
    },
    handler=_create_report,
)

