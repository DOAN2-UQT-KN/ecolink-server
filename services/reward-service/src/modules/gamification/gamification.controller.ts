import type { Request, Response } from "express";
import {
  HTTP_STATUS,
  sendError,
  sendSuccess,
} from "../../constants/http-status";
import {
  gamificationConfigService,
  pointRulesValues,
  validatePointRulesInput,
  type PointRulesValues,
} from "./gamification-config.service";
import {
  fetchUsersByIds,
  getUserProfile,
  type OrganizationOwnerResponse,
} from "../../utils/identity-user.client";

// --- Admin: point rules (the only gamification config left after spec 014) ---

function toPointRulesDto(rules: NonNullable<Awaited<ReturnType<typeof gamificationConfigService.getActivePointRules>>>) {
  return {
    id: rules.id,
    ...pointRulesValues(rules),
    effectiveFrom: rules.effectiveFrom,
    updatedAt: rules.updatedAt,
  };
}

export async function adminGetPointRules(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const rules = await gamificationConfigService.getActivePointRules();
    if (!rules) {
      sendError(res, HTTP_STATUS.NOT_FOUND.withMessage("No active point rules"));
      return;
    }
    sendSuccess(res, HTTP_STATUS.OK, { rules: toPointRulesDto(rules) });
  } catch (e) {
    console.error("adminGetPointRules", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

export async function adminPatchPointRules(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      sendError(res, HTTP_STATUS.UNAUTHORIZED);
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errors = validatePointRulesInput(body);
    if (errors.length > 0) {
      sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors });
      return;
    }
    const rules = await gamificationConfigService.upsertPointRules(
      body as unknown as PointRulesValues,
      userId,
    );
    sendSuccess(res, HTTP_STATUS.OK, { rules: toPointRulesDto(rules) });
  } catch (e) {
    console.error("adminPatchPointRules", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

const POINT_RULE_HISTORY_MAX_LIMIT = 100;

export async function adminGetPointRuleHistory(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(
      POINT_RULE_HISTORY_MAX_LIMIT,
      Math.max(1, Number.parseInt(String(req.query.limit ?? "20"), 10) || 20),
    );
    const { items, total } = await gamificationConfigService.listPointRuleHistory({ page, limit });
    // Names are a nicety: identity-service being down must not hide the history.
    const profiles = await fetchUsersByIds(items.map((i) => i.changedBy)).catch(
      () => new Map<string, OrganizationOwnerResponse>(),
    );
    sendSuccess(res, HTTP_STATUS.OK, {
      items: items.map((i) => ({
        id: i.id,
        changedBy: i.changedBy,
        changedByName: getUserProfile(profiles, i.changedBy)?.name || null,
        changedAt: i.changedAt,
        before: i.before,
        after: i.after,
      })),
      meta: { page, limit, total },
    });
  } catch (e) {
    console.error("adminGetPointRuleHistory", e);
    sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}
