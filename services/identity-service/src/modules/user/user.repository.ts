import { PrismaClient } from "@prisma/client";
import prisma from "../../config/prisma.client";
import { UserEntity } from "./user.entity";

export class UserRepository {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = prisma;
  }

  async create(
    entity: Omit<UserEntity, "id" | "createdAt" | "updatedAt" | "deletedAt">,
  ): Promise<UserEntity> {
    return this.prisma.user.create({
      data: {
        email: entity.email,
        name: entity.name,
        password: entity.password,
        avatar: entity.avatar,
        bio: entity.bio,
        roleId: entity.roleId,
        emailVerified: entity.emailVerified,
        verificationToken: entity.verificationToken,
      },
    });
  }

  async findById(id: string): Promise<UserEntity | null> {
    return this.prisma.user.findFirst({
      where: { id, deletedAt: null },
    });
  }

  async findByIds(ids: string[]): Promise<UserEntity[]> {
    const unique = [...new Set(ids)].filter(Boolean);
    if (unique.length === 0) {
      return [];
    }
    return this.prisma.user.findMany({
      where: { id: { in: unique }, deletedAt: null },
    });
  }

  async findEmailById(id: string): Promise<{ email: string } | null> {
    return this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: { email: true },
    });
  }

  async findByEmail(email: string): Promise<UserEntity | null> {
    return this.prisma.user.findFirst({
      where: { email, deletedAt: null },
    });
  }

  async findCurrentUserById(id: string): Promise<{
    id: string;
    email: string;
    name: string;
    roleId: string;
    avatar: string | null;
    bio: string | null;
    emailVerified: boolean;
    createdAt: Date;
    updatedAt: Date;
  } | null> {
    return this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        email: true,
        name: true,
        roleId: true,
        avatar: true,
        bio: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async update(id: string, entity: Partial<UserEntity>): Promise<UserEntity> {
    return this.prisma.user.update({
      where: { id },
      data: entity,
    });
  }

  async softDelete(id: string): Promise<UserEntity> {
    return this.prisma.user.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async findAll(): Promise<UserEntity[]> {
    return this.prisma.user.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
  }
}

// Singleton instance
export const userRepository = new UserRepository();
