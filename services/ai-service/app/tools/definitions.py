from collections.abc import Awaitable, Callable
from typing import Any

ToolContext = dict[str, Any]
ToolHandler = Callable[[dict[str, Any], ToolContext], Awaitable[str]]


class RegisteredTool:
    __slots__ = ("name", "description", "parameters", "handler")

    def __init__(
        self,
        name: str,
        description: str,
        parameters: dict[str, Any],
        handler: ToolHandler,
    ) -> None:
        self.name = name
        self.description = description
        self.parameters = parameters
        self.handler = handler

    def openai_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


async def _echo(args: dict[str, Any], _ctx: ToolContext) -> str:
    text = args.get("text", "")
    return f"echo: {text}"


async def _platform_faq(args: dict[str, Any], _ctx: ToolContext) -> str:
    topic = args.get("topic", "general")
    snippets = {
        "reports": (
            "Users can submit environmental incident reports with location and photos. "
            "Reports can be linked to campaigns. Moderators may verify reports."
        ),
        "campaigns": (
            "Organizations create campaigns with a geographic area and schedule. "
            "Volunteers join, get tasks, and submit cleanup results for review."
        ),
        "organizations": (
            "Organizations register on EcoLink, verify contact email, and can create campaigns. "
            "Members and join requests are managed per organization."
        ),
        "general": (
            "EcoLink connects communities with environmental volunteering through reports, "
            "campaigns, and rewards where configured."
        ),
    }
    return snippets.get(topic, snippets["general"])


echo_tool = RegisteredTool(
    name="echo_message",
    description="Echoes a short string. Use when the user asks to test tools.",
    parameters={
        "type": "object",
        "properties": {"text": {"type": "string", "description": "Text to echo"}},
        "required": ["text"],
    },
    handler=_echo,
)

platform_faq_tool = RegisteredTool(
    name="get_platform_faq_excerpt",
    description=(
        "Returns curated FAQ text about EcoLink. Call for common how-to questions "
        "about reports, campaigns, or organizations."
    ),
    parameters={
        "type": "object",
        "properties": {
            "topic": {
                "type": "string",
                "enum": ["reports", "campaigns", "organizations", "general"],
                "description": "Topic area",
            }
        },
        "required": ["topic"],
    },
    handler=_platform_faq,
)
