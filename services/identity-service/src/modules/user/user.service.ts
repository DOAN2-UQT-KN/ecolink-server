import { userRepository } from './user.repository';
import { toUserResponse } from './user.entity';
import { UpdateUserRequest, UserResponse } from './user.dto';

export class UserService {
    constructor() { }

    async getUserById(
        id: string,
        viewerUserId?: string | null,
    ): Promise<UserResponse | null> {
        const user = await userRepository.findById(id);
        if (!user) {
            return null;
        }
        const includeLocation =
            viewerUserId != null && viewerUserId === id;
        return toUserResponse(user, { includeLocation });
    }

    async getUsersByIds(ids: string[]): Promise<UserResponse[]> {
        const users = await userRepository.findByIds(ids);
        return users.map((u) => toUserResponse(u));
    }

    async getUserEmailById(id: string): Promise<string | null> {
        const row = await userRepository.findEmailById(id);
        return row?.email ?? null;
    }

    async getUserByEmail(
        email: string,
        viewerUserId?: string | null,
    ): Promise<UserResponse | null> {
        const user = await userRepository.findByEmail(email);
        if (!user) {
            return null;
        }
        const includeLocation =
            viewerUserId != null && viewerUserId === user.id;
        return toUserResponse(user, { includeLocation });
    }

    async updateUser(id: string, request: UpdateUserRequest): Promise<UserResponse> {
        const existing = await userRepository.findById(id);
        if (!existing) {
            throw new Error('User not found');
        }

        const latIn = request.latitude;
        const lngIn = request.longitude;
        if (
            (latIn !== undefined && lngIn === undefined) ||
            (lngIn !== undefined && latIn === undefined)
        ) {
            throw new Error(
                'latitude and longitude must be provided together',
            );
        }

        let locationPatch: {
            latitude?: number | null;
            longitude?: number | null;
            locationUpdatedAt?: Date | null;
        } = {};
        if (latIn !== undefined && lngIn !== undefined) {
            if (latIn === null && lngIn === null) {
                locationPatch = {
                    latitude: null,
                    longitude: null,
                    locationUpdatedAt: null,
                };
            } else if (
                typeof latIn === 'number' &&
                typeof lngIn === 'number'
            ) {
                locationPatch = {
                    latitude: latIn,
                    longitude: lngIn,
                    locationUpdatedAt: new Date(),
                };
            } else {
                throw new Error('Invalid latitude/longitude pair');
            }
        }

        const user = await userRepository.update(id, {
            name: request.name,
            avatar: request.avatar,
            bio: request.bio,
            roleId: request.roleId,
            ...locationPatch,
        });
        return toUserResponse(user, { includeLocation: true });
    }

    async deleteUser(id: string): Promise<void> {
        const existing = await userRepository.findById(id);
        if (!existing) {
            throw new Error('User not found');
        }

        await userRepository.softDelete(id);
    }

    async getAllUsers(): Promise<UserResponse[]> {
        const users = await userRepository.findAll();
        return users.map((u) => toUserResponse(u));
    }

    /** Internal: user ids with last-known location within radius (meters). */
    async findUserIdsNearPointForInternal(params: {
        latitude: number;
        longitude: number;
        radiusMeters: number;
        excludeUserIds: string[];
    }): Promise<string[]> {
        const found = await userRepository.findActiveUserIdsNearPoint(
            params.longitude,
            params.latitude,
            params.radiusMeters,
        );
        const exclude = new Set(
            params.excludeUserIds.map((x) => x.toLowerCase().trim()),
        );
        return found.filter((id) => !exclude.has(id.toLowerCase().trim()));
    }
}

// Singleton instance
export const userService = new UserService();
