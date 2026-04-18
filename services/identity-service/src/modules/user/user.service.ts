import { userRepository } from './user.repository';
import { toUserResponse } from './user.entity';
import { UpdateUserRequest, UserResponse } from './user.dto';

export class UserService {
    constructor() { }

    async getUserById(id: string): Promise<UserResponse | null> {
        const user = await userRepository.findById(id);
        return user ? toUserResponse(user) : null;
    }

    async getUsersByIds(ids: string[]): Promise<UserResponse[]> {
        const users = await userRepository.findByIds(ids);
        return users.map(toUserResponse);
    }

    async getUserEmailById(id: string): Promise<string | null> {
        const row = await userRepository.findEmailById(id);
        return row?.email ?? null;
    }

    async getUserByEmail(email: string): Promise<UserResponse | null> {
        const user = await userRepository.findByEmail(email);
        return user ? toUserResponse(user) : null;
    }

    async updateUser(id: string, request: UpdateUserRequest): Promise<UserResponse> {
        const existing = await userRepository.findById(id);
        if (!existing) {
            throw new Error('User not found');
        }

        const user = await userRepository.update(id, {
            name: request.name,
            avatar: request.avatar,
            bio: request.bio,
            roleId: request.roleId,
        });
        return toUserResponse(user);
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
        return users.map(toUserResponse);
    }
}

// Singleton instance
export const userService = new UserService();
