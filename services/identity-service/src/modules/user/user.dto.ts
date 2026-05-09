// Request DTOs
export interface CreateUserRequest {
    email: string;
    name: string;
    password: string;
    avatar?: string;
    bio?: string;
    roleId: string;
}

export interface UpdateUserRequest {
    name?: string;
    avatar?: string;
    bio?: string;
    roleId?: string;
    /** Both required together when updating; use `null` for both to clear stored location. */
    latitude?: number | null;
    longitude?: number | null;
}

// Response DTOs (excludes password and sensitive fields)
export interface UserResponse {
    id: string;
    email: string;
    name: string;
    avatar: string | null;
    bio: string | null;
    roleId: string;
    emailVerified: boolean;
    createdAt: Date;
    updatedAt: Date;
    /** Only included when the viewer is this user (or after a self-update). Otherwise null. */
    latitude: number | null;
    longitude: number | null;
    locationUpdatedAt: Date | null;
}
