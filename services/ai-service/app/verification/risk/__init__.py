"""Risk engine — empty stubs; ML-ready interface (math deferred)."""

from __future__ import annotations

from typing import Optional, Protocol

from app.verification.contracts import (
    AuthenticityResult,
    ReportDuplicate,
    RiskAssessment,
)


class RiskEngine(Protocol):
    def assess(
        self,
        duplicate: Optional[ReportDuplicate],
        authenticity: AuthenticityResult,
        *,
        behavior_score: Optional[float] = None,
        context_score: Optional[float] = None,
    ) -> RiskAssessment: ...


def combine(
    duplicate_risk: Optional[float],
    authenticity_risk: Optional[float],
    behavior_risk: Optional[float],
    context_risk: Optional[float],
) -> Optional[float]:
    """
    Combine component risks into a single risk_score.

    Contract (when implemented): authenticity_risk = 1 - authenticity_score.
    Do NOT add authenticity_score into risk directly.
    """
    _ = (duplicate_risk, authenticity_risk, behavior_risk, context_risk)
    return None


def assess(
    duplicate: Optional[ReportDuplicate],
    authenticity: AuthenticityResult,
    *,
    behavior_score: Optional[float] = None,
    context_score: Optional[float] = None,
) -> RiskAssessment:
    """Empty risk assessment placeholder returning the standardized shape."""
    _ = (duplicate, authenticity, behavior_score, context_score)
    return RiskAssessment()


class RuleBasedRiskEngine:
    """Rule-based risk engine stub (weighted sum deferred)."""

    def assess(
        self,
        duplicate: Optional[ReportDuplicate],
        authenticity: AuthenticityResult,
        *,
        behavior_score: Optional[float] = None,
        context_score: Optional[float] = None,
    ) -> RiskAssessment:
        return assess(
            duplicate,
            authenticity,
            behavior_score=behavior_score,
            context_score=context_score,
        )


class MlRiskEngine:
    """Future ML risk engine stub (logistic / XGBoost)."""

    def assess(
        self,
        duplicate: Optional[ReportDuplicate],
        authenticity: AuthenticityResult,
        *,
        behavior_score: Optional[float] = None,
        context_score: Optional[float] = None,
    ) -> RiskAssessment:
        return assess(
            duplicate,
            authenticity,
            behavior_score=behavior_score,
            context_score=context_score,
        )
