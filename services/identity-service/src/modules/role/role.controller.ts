import { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { HTTP_STATUS, sendError, sendSuccess } from '../../constants/http-status';
import { roleService } from './role.service';
import { getAllPermissions } from './permission.enum';

export class RoleController {
    constructor() { }

    // ── Role endpoints ─────────────────────────────────────

    createRole = [
        body('name').notEmpty().trim().withMessage('Role name is required'),
        body('description').optional().trim(),
        body('permissionSetIds').optional().isArray().withMessage('Permission set IDs must be an array'),
        body('permissionSetIds.*').optional().isUUID().withMessage('Each permission set ID must be a valid UUID'),

        async (req: Request, res: Response): Promise<void> => {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
            }

            try {
                const role = await roleService.createRole(req.body);
                sendSuccess(res, HTTP_STATUS.CREATED, { role });
            } catch (error) {
                console.error('Create role error:', error);
                if (error instanceof Error && error.message.includes('already exists')) {
                    return sendError(res, HTTP_STATUS.CONFLICT.withMessage(error.message));
                }
                sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
            }
        },
    ];

    getRoleById = async (req: Request, res: Response): Promise<void> => {
        try {
            const role = await roleService.getRoleById(req.params.id);
            if (!role) {
                return sendError(res, HTTP_STATUS.NOT_FOUND.withMessage('Role not found'));
            }
            sendSuccess(res, HTTP_STATUS.OK, { role });
        } catch (error) {
            console.error('Get role error:', error);
            sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
    };

    getAllRoles = async (_req: Request, res: Response): Promise<void> => {
        try {
            const roles = await roleService.getAllRoles();
            sendSuccess(res, HTTP_STATUS.OK, { roles });
        } catch (error) {
            console.error('Get all roles error:', error);
            sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
    };

    updateRole = [
        body('name').optional().trim(),
        body('description').optional().trim(),
        body('permissionSetIds').optional().isArray().withMessage('Permission set IDs must be an array'),
        body('permissionSetIds.*').optional().isUUID().withMessage('Each permission set ID must be a valid UUID'),

        async (req: Request, res: Response): Promise<void> => {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
            }

            try {
                const role = await roleService.updateRole(req.params.id, req.body);
                sendSuccess(res, HTTP_STATUS.OK, { role });
            } catch (error) {
                console.error('Update role error:', error);
                if (error instanceof Error && error.message.includes('not found')) {
                    return sendError(res, HTTP_STATUS.NOT_FOUND.withMessage(error.message));
                }
                if (error instanceof Error && error.message.includes('already exists')) {
                    return sendError(res, HTTP_STATUS.CONFLICT.withMessage(error.message));
                }
                sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
            }
        },
    ];

    deleteRole = async (req: Request, res: Response): Promise<void> => {
        try {
            await roleService.deleteRole(req.params.id);
            sendSuccess(res, HTTP_STATUS.OK.withMessage('Role deleted successfully'));
        } catch (error) {
            console.error('Delete role error:', error);
            if (error instanceof Error && error.message.includes('not found')) {
                return sendError(res, HTTP_STATUS.NOT_FOUND.withMessage(error.message));
            }
            sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
    };

    // ── PermissionSet endpoints ────────────────────────────

    createPermissionSet = [
        body('name').notEmpty().trim().withMessage('Permission set name is required'),
        body('description').optional().trim(),
        body('permissions').isArray({ min: 1 }).withMessage('Permissions must be a non-empty array'),
        body('permissions.*').isString().withMessage('Each permission must be a string'),

        async (req: Request, res: Response): Promise<void> => {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
            }

            try {
                const permissionSet = await roleService.createPermissionSet(req.body);
                sendSuccess(res, HTTP_STATUS.CREATED, { permissionSet });
            } catch (error) {
                console.error('Create permission set error:', error);
                if (error instanceof Error && error.message.includes('Invalid permissions')) {
                    return sendError(res, HTTP_STATUS.BAD_REQUEST.withMessage(error.message));
                }
                sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
            }
        },
    ];

    getPermissionSetById = async (req: Request, res: Response): Promise<void> => {
        try {
            const permissionSet = await roleService.getPermissionSetById(req.params.id);
            if (!permissionSet) {
                return sendError(res, HTTP_STATUS.NOT_FOUND.withMessage('Permission set not found'));
            }
            sendSuccess(res, HTTP_STATUS.OK, { permissionSet });
        } catch (error) {
            console.error('Get permission set error:', error);
            sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
    };

    getAllPermissionSets = async (_req: Request, res: Response): Promise<void> => {
        try {
            const permissionSets = await roleService.getAllPermissionSets();
            sendSuccess(res, HTTP_STATUS.OK, { permissionSets });
        } catch (error) {
            console.error('Get all permission sets error:', error);
            sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
    };

    updatePermissionSet = [
        body('name').optional().trim(),
        body('description').optional().trim(),
        body('permissions').optional().isArray().withMessage('Permissions must be an array'),
        body('permissions.*').optional().isString().withMessage('Each permission must be a string'),

        async (req: Request, res: Response): Promise<void> => {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
            }

            try {
                const permissionSet = await roleService.updatePermissionSet(req.params.id, req.body);
                sendSuccess(res, HTTP_STATUS.OK, { permissionSet });
            } catch (error) {
                console.error('Update permission set error:', error);
                if (error instanceof Error && error.message.includes('not found')) {
                    return sendError(res, HTTP_STATUS.NOT_FOUND.withMessage(error.message));
                }
                if (error instanceof Error && error.message.includes('Invalid permissions')) {
                    return sendError(res, HTTP_STATUS.BAD_REQUEST.withMessage(error.message));
                }
                sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
            }
        },
    ];

    deletePermissionSet = async (req: Request, res: Response): Promise<void> => {
        try {
            await roleService.deletePermissionSet(req.params.id);
            sendSuccess(res, HTTP_STATUS.OK.withMessage('Permission set deleted successfully'));
        } catch (error) {
            console.error('Delete permission set error:', error);
            if (error instanceof Error && error.message.includes('not found')) {
                return sendError(res, HTTP_STATUS.NOT_FOUND.withMessage(error.message));
            }
            sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
    };

    // ── Utility endpoints ──────────────────────────────────

    /**
     * Returns all available permissions from the Permission enum
     */
    getAvailablePermissions = async (_req: Request, res: Response): Promise<void> => {
        try {
            const permissions = getAllPermissions();
            sendSuccess(res, HTTP_STATUS.OK, { permissions });
        } catch (error) {
            console.error('Get permissions error:', error);
            sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
    };
}

// Singleton instance
export const roleController = new RoleController();
