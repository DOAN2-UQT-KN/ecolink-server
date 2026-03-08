import { Request, Response, NextFunction } from "express";
import { HTTP_STATUS, sendError } from "../constants/http-status";
import { Permission } from "../modules/role/permission.enum";
import prisma from "../config/prisma.client";

/**
 * Middleware to check if the authenticated user has the required permission.
 * Must be used after the `authenticate` middleware.
 *
 * Loads user's role → permission sets → permissions and checks against required permission.
 */
export const authorize = (...requiredPermissions: Permission[]) => {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        sendError(res, HTTP_STATUS.UNAUTHORIZED);
        return;
      }

      // Get user's roleId
      const user = await prisma.user.findFirst({
        where: { id: userId, deletedAt: null },
      });

      if (!user) {
        sendError(res, HTTP_STATUS.UNAUTHORIZED);
        return;
      }

      // Get all permission set IDs linked to this role
      const rolePermissionSets = await prisma.rolePermissionSet.findMany({
        where: { roleId: user.roleId, deletedAt: null },
      });

      const permissionSetIds = rolePermissionSets.map(
        (rps) => rps.permissionSetId,
      );

      // Get all permissions from those permission sets
      const permissionSets = await prisma.permissionSet.findMany({
        where: {
          id: { in: permissionSetIds },
          deletedAt: null,
        },
      });

      const userPermissions = new Set(
        permissionSets.flatMap((ps) => ps.permissions),
      );

      // Check if user has ALL required permissions
      const hasPermission = requiredPermissions.every((p) =>
        userPermissions.has(p),
      );

      if (!hasPermission) {
        sendError(res, HTTP_STATUS.FORBIDDEN);
        return;
      }

      next();
    } catch (error) {
      console.error("Authorization error:", error);
      sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  };
};
