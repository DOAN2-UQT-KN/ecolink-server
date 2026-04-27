"""Single assistant + per-agent tool lists (only `ecolink_assistant` today)."""

from typing import Final, Optional

from app.tools.definitions import RegisteredTool, echo_tool, platform_faq_tool
from app.tools.organization_api import create_organization_tool, list_organizations_tool
from app.tools.chat_media_api import list_chat_media_by_ids_tool
from app.tools.report_media_api import list_report_media_files_by_ids_tool

REGISTERED_AGENT_IDS: Final[tuple[str, ...]] = ("ecolink_assistant",)

# Older conversations may still store these ids in the database.
_LEGACY_AGENT_IDS: Final[dict[str, str]] = {
    "ecolink_support": "ecolink_assistant",
    "campaign_helper": "ecolink_assistant",
}


def resolve_agent_id(agent_id: str) -> str:
    return _LEGACY_AGENT_IDS.get(agent_id, agent_id)


AGENT_TOOLS: dict[str, list[RegisteredTool]] = {
    "ecolink_assistant": [
        platform_faq_tool,
        create_organization_tool,
        list_organizations_tool,
        list_report_media_files_by_ids_tool,
        list_chat_media_by_ids_tool,
        echo_tool,
    ],
}


def tools_for_agent(agent_id: str) -> list[RegisteredTool]:
    return list(AGENT_TOOLS.get(resolve_agent_id(agent_id), ()))


def openai_tools_for_agent(agent_id: str) -> list[dict]:
    return [t.openai_schema() for t in tools_for_agent(agent_id)]


def tool_catalog() -> list[dict]:
    return [
        {
            "agent_id": aid,
            "tools": [{"name": t.name, "description": t.description} for t in tools],
        }
        for aid, tools in AGENT_TOOLS.items()
    ]


def find_tool(agent_id: str, name: str) -> Optional[RegisteredTool]:
    for t in tools_for_agent(agent_id):
        if t.name == name:
            return t
    return None
