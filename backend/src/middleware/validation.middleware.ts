import { Request, Response, NextFunction } from "express";
import { z, ZodSchema } from "zod";
import { AppError } from "../utils/AppError";

// ─── Schema Definitions ──────────────────────────────────────────────────────

export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  sortBy: z.string().optional(),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
});

export const MarketIdSchema = z.object({
  market_id: z.string().min(1).max(128),
});

export const CreateMarketSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().min(1).max(5000),
  fighter_a: z.string().min(1).max(200),
  fighter_b: z.string().min(1).max(200),
  event_date: z.string().datetime(),
  weight_class: z.string().min(1).max(100),
  tier: z.number().int().min(1).max(100),
});

export const PlaceBetSchema = z.object({
  market_id: z.string().min(1).max(128),
  outcome: z.enum(["fighter_a", "fighter_b", "draw"]),
  amount: z.number().positive().max(1000000),
  slippage_tolerance: z.number().min(0).max(0.5).default(0.05),
});

export const ResolveMarketSchema = z.object({
  market_id: z.string().min(1).max(128),
  outcome: z.enum(["fighter_a", "fighter_b", "draw", "no_contest"]),
});

export const SubmitOracleReportSchema = z.object({
  market_id: z.string().min(1).max(128),
  outcome: z.enum(["fighter_a", "fighter_b", "draw", "no_contest"]),
  confidence: z.number().min(0).max(1),
  signature: z.string().min(1),
});

export const UserRegistrationSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(100),
});

export const UserLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const DisputeSchema = z.object({
  market_id: z.string().min(1).max(128),
  reason: z.string().min(10).max(5000),
  evidence: z.array(z.string().url()).max(10).optional(),
});

// ─── Validation Middleware Factory ────────────────────────────────────────────

export function validateBody(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const formattedErrors = error.issues.map((err) => ({
          field: err.path.join("."),
          message: err.message,
          code: err.code,
        }));
        return next(
          new AppError(400, `Validation failed: ${formattedErrors.map((e) => e.message).join("; ")}`),
        );
      }
      next(error);
    }
  };
}

export function validateQuery(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      req.query = schema.parse(req.query) as any;
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const formattedErrors = error.issues.map((err) => ({
          field: err.path.join("."),
          message: err.message,
          code: err.code,
        }));
        return next(
          new AppError(400, `Query validation failed: ${formattedErrors.map((e) => e.message).join("; ")}`),
        );
      }
      next(error);
    }
  };
}

export function validateParams(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      req.params = schema.parse(req.params) as any;
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const formattedErrors = error.issues.map((err) => ({
          field: err.path.join("."),
          message: err.message,
          code: err.code,
        }));
        return next(
          new AppError(400, `Params validation failed: ${formattedErrors.map((e) => e.message).join("; ")}`),
        );
      }
      next(error);
    }
  };
}

// ─── Authorization Middleware ─────────────────────────────────────────────────

export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = (req as any).user;
    if (!user) {
      return next(new AppError(401, "Authentication required"));
    }

    if (roles.length > 0 && !roles.includes(user.role)) {
      return next(new AppError(403, `Insufficient permissions. Required: ${roles.join(" or ")}`));
    }

    next();
  };
}

// ─── Request Size Limiter ────────────────────────────────────────────────────

export function maxBodySize(maxBytes: number) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const contentLength = parseInt(req.headers["content-length"] || "0", 10);
    if (contentLength > maxBytes) {
      return next(
        new AppError(413, `Request body too large. Maximum size: ${maxBytes} bytes`),
      );
    }
    next();
  };
}

// ─── Idempotency Check ──────────────────────────────────────────────────────

export function requireIdempotencyKey() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const idempotencyKey = req.headers["idempotency-key"] as string;
    if (!idempotencyKey) {
      return next(new AppError(400, "Idempotency-Key header is required"));
    }

    if (idempotencyKey.length < 16 || idempotencyKey.length > 128) {
      return next(new AppError(400, "Idempotency-Key must be between 16 and 128 characters"));
    }

    next();
  };
}
