import {
  validateBody,
  validateQuery,
  validateParams,
  requireRole,
  PlaceBetSchema,
  CreateMarketSchema,
  PaginationSchema,
} from "../../src/middleware/validation.middleware";
import { Request, Response, NextFunction } from "express";

describe("Validation Middleware", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockReq = { body: {}, query: {}, params: {} };
    mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    mockNext = jest.fn();
  });

  describe("validateBody", () => {
    it("passes valid body through", () => {
      mockReq.body = {
        market_id: "market1",
        outcome: "fighter_a",
        amount: 100,
        slippage_tolerance: 0.05,
      };

      const middleware = validateBody(PlaceBetSchema);
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
      expect(mockReq.body.amount).toBe(100);
    });

    it("rejects invalid body", () => {
      mockReq.body = {
        market_id: "",
        outcome: "invalid",
        amount: -10,
      };

      const middleware = validateBody(PlaceBetSchema);
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });

    it("applies defaults", () => {
      mockReq.body = {
        market_id: "market1",
        outcome: "fighter_a",
        amount: 100,
      };

      const middleware = validateBody(PlaceBetSchema);
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
      expect(mockReq.body.slippage_tolerance).toBe(0.05);
    });
  });

  describe("validateQuery", () => {
    it("parses and validates query parameters", () => {
      mockReq.query = { page: "2", limit: "50" };

      const middleware = validateQuery(PaginationSchema);
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
      expect((mockReq.query as any).page).toBe(2);
      expect((mockReq.query as any).limit).toBe(50);
    });

    it("rejects query exceeding max limit", () => {
      mockReq.query = { limit: "300" };

      const middleware = validateQuery(PaginationSchema);
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });
  });

  describe("requireRole", () => {
    it("allows user with required role", () => {
      (mockReq as any).user = { role: "admin" };

      const middleware = requireRole("admin");
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it("rejects user without required role", () => {
      (mockReq as any).user = { role: "user" };

      const middleware = requireRole("admin");
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 403,
      }));
    });

    it("rejects unauthenticated user", () => {
      (mockReq as any).user = undefined;

      const middleware = requireRole("admin");
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 401,
      }));
    });

    it("allows any of multiple roles", () => {
      (mockReq as any).user = { role: "moderator" };

      const middleware = requireRole("admin", "moderator");
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });
  });
});
