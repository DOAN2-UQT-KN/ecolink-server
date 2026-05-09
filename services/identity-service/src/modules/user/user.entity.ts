import { User } from '@prisma/client';

// Type-based entity (not class)
export type UserEntity = User;

// Import the response type from DTOs
import { UserResponse } from './user.dto';

// Helper function for conversion (excludes password and sensitive fields)
export const toUserResponse = (
    entity: UserEntity,
    options?: { includeLocation?: boolean },
): UserResponse => ({
    id: entity.id,
    email: entity.email,
    name: entity.name,
    avatar: entity.avatar,
    bio: entity.bio,
    roleId: entity.roleId,
    emailVerified: entity.emailVerified,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    latitude: options?.includeLocation ? entity.latitude ?? null : null,
    longitude: options?.includeLocation ? entity.longitude ?? null : null,
    locationUpdatedAt: options?.includeLocation
        ? entity.locationUpdatedAt ?? null
        : null,
});
