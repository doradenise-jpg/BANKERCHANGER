// backend/src/dto/user.dto.ts

export interface UserDTO {
  id: string;
  email: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  createdAt: string;
}

/** Strips all internal fields (passwordHash, twoFactorSecret, resetTokenHash, sessionVersion, etc.) */
export function toUserDTO(user: {
  id: string;
  email: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  createdAt?: Date | string;
}): UserDTO {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    twoFactorEnabled: user.twoFactorEnabled,
    createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : new Date(0).toISOString(),
  };
}
