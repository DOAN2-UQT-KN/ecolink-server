"""Service-to-service HTTP calls to incident-service (internal API key)."""

from app.clients.incident_internal import patch_duplicate_verification_sync

__all__ = ["patch_duplicate_verification_sync"]
