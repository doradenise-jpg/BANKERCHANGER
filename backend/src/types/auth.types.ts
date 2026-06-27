// backend/src/types/auth.types.ts
import { Request } from 'express';

export enum UserTier {
  BEGINNER = 'BEGINNER',
  ADVANCED = 'ADVANCED',
  EXPERT = 'EXPERT',
  LEGENDARY = 'LEGENDARY',
}

export interface JwtUser {
  userId: string;
  email: string;
  sessionVersion: number;
  isAdmin?: boolean;
}

export interface AuthenticatedRequest extends Request {
  user?: JwtUser;
}
