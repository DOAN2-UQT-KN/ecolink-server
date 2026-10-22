import { Request, Response } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { HTTP_STATUS, sendError, sendSuccess } from '../../constants/http-status';
import { UserStatus } from '../../constants/user-status';
import { userService } from './user.service';
import type {
    AdminBanUserBody,
    AdminListUsersSortBy,
    AdminListUsersSortOrder,
} from './user.dto';

function requireAdmin(req: Request, res: Response): boolean {
    const role = req.user?.role?.toLowerCase();
    if (!role || role !== 'admin') {
        sendError(
            res,
            HTTP_STATUS.FORBIDDEN.withMessage('Only admin can perform this action'),
        );
        return false;
    }
    return true;
}

export class UserController {
    constructor() { }

    getUserById = async (req: Request, res: Response): Promise<void> => {
        try {
            const user = await userService.getUserById(
                req.params.id,
                req.user?.userId,
            );

            if (!user) {
                return sendError(res, HTTP_STATUS.NOT_FOUND.withMessage('User not found'));
            }

            sendSuccess(res, HTTP_STATUS.OK, { user });
        } catch (error) {
            console.error('Get user error:', error);
            sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
    };

    getUserByEmail = async (req: Request, res: Response): Promise<void> => {
        try {
            const email = req.params.email;
            const user = await userService.getUserByEmail(
                email,
                req.user?.userId,
            );

            if (!user) {
                return sendError(res, HTTP_STATUS.NOT_FOUND.withMessage('User not found'));
            }

            sendSuccess(res, HTTP_STATUS.OK, { user });
        } catch (error) {
            console.error('Get user by email error:', error);
            sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
    };

    updateUser = [
        body('name').optional().trim(),
        body('avatar')
            .optional({ nullable: true })
            .custom((value) => {
                if (value === null || value === undefined) return true;
                if (typeof value === 'string' && /^https?:\/\//.test(value)) {
                    return true;
                }
                throw new Error('Avatar must be null or a valid URL');
            }),
        body('bio').optional().trim(),
        body('roleId').optional().isUUID("loose").withMessage('Role ID must be a valid UUID'),
        body('latitude')
            .optional({ nullable: true })
            .custom((value) => {
                if (value === null) return true;
                if (typeof value === 'number' && value >= -90 && value <= 90) {
                    return true;
                }
                throw new Error('latitude must be null or between -90 and 90');
            }),
        body('longitude')
            .optional({ nullable: true })
            .custom((value) => {
                if (value === null) return true;
                if (typeof value === 'number' && value >= -180 && value <= 180) {
                    return true;
                }
                throw new Error('longitude must be null or between -180 and 180');
            }),
        body('notificationPreferences')
            .optional()
            .isObject()
            .withMessage('notificationPreferences must be an object'),
        body('notificationPreferences.*')
            .optional()
            .isBoolean()
            .withMessage('notification preference values must be boolean'),
        body('phoneNumber')
            .optional({ nullable: true })
            .custom((value) => {
                if (value === null || value === undefined) return true;
                if (typeof value !== 'string') {
                    throw new Error('phoneNumber must be a string or null');
                }
                const trimmed = value.trim();
                if (!trimmed) return true;
                if (trimmed.length > 20) {
                    throw new Error('phoneNumber must be at most 20 characters');
                }
                if (!/^[0-9+\s\-().]{7,20}$/.test(trimmed)) {
                    throw new Error('phoneNumber must be a valid phone number');
                }
                return true;
            }),
        body('gender')
            .optional({ nullable: true })
            .custom((value) => {
                if (value === null || value === undefined) return true;
                const allowed = ['male', 'female', 'other', 'prefer_not_to_say'];
                if (typeof value === 'string' && allowed.includes(value)) {
                    return true;
                }
                throw new Error(
                    'gender must be null or one of male, female, other, prefer_not_to_say',
                );
            }),
        body('dateOfBirth')
            .optional({ nullable: true })
            .custom((value) => {
                if (value === null || value === undefined) return true;
                if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
                    throw new Error('dateOfBirth must be null or YYYY-MM-DD');
                }
                const parsed = new Date(`${value}T00:00:00.000Z`);
                if (Number.isNaN(parsed.getTime())) {
                    throw new Error('dateOfBirth must be a valid date');
                }
                return true;
            }),
        body('detailAddress')
            .optional({ nullable: true })
            .custom((value) => {
                if (value === null || value === undefined) return true;
                if (typeof value !== 'string') {
                    throw new Error('detailAddress must be a string or null');
                }
                if (value.trim().length > 255) {
                    throw new Error('detailAddress must be at most 255 characters');
                }
                return true;
            }),

        async (req: Request, res: Response): Promise<void> => {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return sendError(res, HTTP_STATUS.VALIDATION_ERROR, { errors: errors.array() });
            }

            try {
                const user = await userService.updateUser(req.params.id, req.body);
                sendSuccess(res, HTTP_STATUS.OK, { user });
            } catch (error) {
                console.error('Update user error:', error);
                if (error instanceof Error && error.message.includes('not found')) {
                    return sendError(res, HTTP_STATUS.NOT_FOUND.withMessage(error.message));
                }
                if (
                    error instanceof Error &&
                    (error.message.includes('latitude') ||
                        error.message.includes('longitude') ||
                        error.message.includes('Invalid latitude'))
                ) {
                    return sendError(
                        res,
                        HTTP_STATUS.BAD_REQUEST.withMessage(error.message),
                    );
                }
                sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
            }
        },
    ];

    deleteUser = async (req: Request, res: Response): Promise<void> => {
        try {
            await userService.deleteUser(req.params.id);
            sendSuccess(res, HTTP_STATUS.OK.withMessage('User deleted successfully'));
        } catch (error) {
            console.error('Delete user error:', error);
            if (error instanceof Error && error.message.includes('not found')) {
                return sendError(res, HTTP_STATUS.NOT_FOUND.withMessage(error.message));
            }
            sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
    };

    getAllUsers = [
        query('search').optional().trim(),
        query('status')
            .optional()
            .isInt()
            .custom((value) => {
                const n = Number(value);
                if (n !== UserStatus.ACTIVE && n !== UserStatus.INACTIVE) {
                    throw new Error('status must be 1 (active) or 2 (inactive)');
                }
                return true;
            }),
        query('sort_by')
            .optional()
            .isIn(['created_at', 'name', 'email'])
            .withMessage('sort_by must be created_at, name, or email'),
        query('sort_order')
            .optional()
            .isIn(['asc', 'desc'])
            .withMessage('sort_order must be asc or desc'),
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 100 }),

        async (req: Request, res: Response): Promise<void> => {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
                    errors: errors.array(),
                });
            }

            if (!requireAdmin(req, res)) return;

            try {
                const sortBy = (req.query.sort_by
                    ? String(req.query.sort_by)
                    : 'created_at') as AdminListUsersSortBy;
                const sortOrder = (req.query.sort_order
                    ? String(req.query.sort_order)
                    : 'desc') as AdminListUsersSortOrder;
                const page = req.query.page
                    ? parseInt(String(req.query.page), 10)
                    : 1;
                const limit = req.query.limit
                    ? parseInt(String(req.query.limit), 10)
                    : 10;

                const result = await userService.getAllUsers({
                    search: req.query.search
                        ? String(req.query.search).trim()
                        : undefined,
                    status:
                        req.query.status !== undefined
                            ? parseInt(String(req.query.status), 10)
                            : undefined,
                    sortBy,
                    sortOrder,
                    page,
                    limit,
                });

                sendSuccess(res, HTTP_STATUS.OK, result);
            } catch (error) {
                console.error('Get all users error:', error);
                sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
            }
        },
    ];

    adminBanUser = [
        param('id').isUUID("loose").withMessage('User ID must be a valid UUID'),
        body('rejectReason')
            .isString()
            .trim()
            .notEmpty()
            .isLength({ max: 5000 })
            .withMessage('reject_reason is required when banning a user'),

        async (req: Request, res: Response): Promise<void> => {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return sendError(res, HTTP_STATUS.VALIDATION_ERROR, {
                    errors: errors.array(),
                });
            }

            if (!requireAdmin(req, res)) return;

            const adminUserId = req.user?.userId;
            if (!adminUserId) {
                return sendError(res, HTTP_STATUS.UNAUTHORIZED);
            }

            try {
                const { rejectReason } = req.body as AdminBanUserBody;
                const user = await userService.adminBanUser(
                    req.params.id,
                    rejectReason,
                    adminUserId,
                );
                sendSuccess(
                    res,
                    HTTP_STATUS.OK.withMessage('User banned successfully'),
                    { user },
                );
            } catch (error) {
                console.error('Admin ban user error:', error);
                if (error instanceof Error && error.message.includes('not found')) {
                    return sendError(
                        res,
                        HTTP_STATUS.NOT_FOUND.withMessage(error.message),
                    );
                }
                if (
                    error instanceof Error &&
                    (error.message.includes('Cannot ban yourself') ||
                        error.message.includes('reject_reason'))
                ) {
                    return sendError(
                        res,
                        HTTP_STATUS.BAD_REQUEST.withMessage(error.message),
                    );
                }
                sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
            }
        },
    ];
}

// Singleton instance
export const userController = new UserController();
