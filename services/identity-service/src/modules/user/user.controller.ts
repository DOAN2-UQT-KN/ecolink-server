import { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { HTTP_STATUS, sendError, sendSuccess } from '../../constants/http-status';
import { userService } from './user.service';

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
        body('avatar').optional().isURL().withMessage('Avatar must be a valid URL'),
        body('bio').optional().trim(),
        body('roleId').optional().isUUID().withMessage('Role ID must be a valid UUID'),
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

    getAllUsers = async (_req: Request, res: Response): Promise<void> => {
        try {
            const users = await userService.getAllUsers();
            sendSuccess(res, HTTP_STATUS.OK, { users });
        } catch (error) {
            console.error('Get all users error:', error);
            sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
    };
}

// Singleton instance
export const userController = new UserController();
