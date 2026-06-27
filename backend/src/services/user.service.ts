// backend/src/services/user.service.ts
import { users } from './auth.service.js';
import { UserDTO, toUserDTO } from '../dto/user.dto.js';
import { AppError } from '../utils/AppError.js';
import { UserTier } from '../types/auth.types.js';

// Extended metadata not stored on UserRecord — keyed by userId
const userMeta = new Map<string, {
  tier: UserTier;
  isActive: boolean;
  username?: string;
  avatarUrl?: string;
  createdAt: Date;
}>();

function getMeta(userId: string) {
  if (!userMeta.has(userId)) {
    userMeta.set(userId, { tier: UserTier.BEGINNER, isActive: true, createdAt: new Date() });
  }
  return userMeta.get(userId)!;
}

function toDTO(userId: string): UserDTO {
  const user = users.get(userId);
  if (!user) throw new AppError(404, 'User not found');
  return toUserDTO({ ...user, createdAt: getMeta(userId).createdAt });
}

export class UserService {
  getPublicProfile(id: string): UserDTO {
    return toDTO(id);
  }

  getMyProfile(userId: string): UserDTO {
    return toDTO(userId);
  }

  updateProfile(userId: string, body: { username?: string; avatarUrl?: string }): UserDTO {
    if (!users.has(userId)) throw new AppError(404, 'User not found');

    if (body.username) {
      const taken = [...userMeta.entries()].some(
        ([id, m]) => id !== userId && m.username === body.username,
      );
      if (taken) throw new AppError(409, 'Username already taken');
      getMeta(userId).username = body.username;
    }

    if (body.avatarUrl !== undefined) {
      getMeta(userId).avatarUrl = body.avatarUrl;
    }

    return toDTO(userId);
  }

  listUsers(opts: {
    page: number;
    limit: number;
    role?: UserTier;
    status?: 'active' | 'suspended';
    search?: string;
  }): { users: UserDTO[]; total: number; page: number; limit: number } {
    let entries = [...users.entries()];

    if (opts.role) {
      entries = entries.filter(([id]) => getMeta(id).tier === opts.role);
    }
    if (opts.status) {
      const active = opts.status === 'active';
      entries = entries.filter(([id]) => getMeta(id).isActive === active);
    }
    if (opts.search) {
      const q = opts.search.toLowerCase();
      entries = entries.filter(([, u]) => u.email.toLowerCase().includes(q));
    }

    const total = entries.length;
    const page = opts.page;
    const limit = opts.limit;
    const slice = entries.slice((page - 1) * limit, page * limit);

    return { users: slice.map(([id]) => toDTO(id)), total, page, limit };
  }

  suspendUser(id: string): void {
    if (!users.has(id)) throw new AppError(404, 'User not found');
    getMeta(id).isActive = false;
  }

  updateUserRole(id: string, role: UserTier): { id: string; tier: UserTier } {
    if (!users.has(id)) throw new AppError(404, 'User not found');
    getMeta(id).tier = role;
    return { id, tier: role };
  }
}
