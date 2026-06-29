import { Request, Response } from 'express';
import { createCorsMiddleware, getAllowedOrigins } from '../../src/config/cors';

// Mock environment
jest.mock('../../src/config/env', () => ({
  getEnv: jest.fn(() => ({
    ALLOWED_ORIGINS: 'http://localhost:3000,https://app.example.com',
  })),
}));

// Mock logger
jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Helper to create mock Response with all required methods
function createMockResponse(): Response {
  const res = {
    setHeader: jest.fn().mockReturnThis(),
    getHeader: jest.fn(),
    end: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    statusCode: 200,
    headersSent: false,
  };
  return res as unknown as Response;
}

describe('CORS Configuration', () => {
  describe('getAllowedOrigins', () => {
    it('should parse comma-separated origins from env', () => {
      const origins = getAllowedOrigins();
      expect(origins).toEqual(['http://localhost:3000', 'https://app.example.com']);
    });
  });

  describe('createCorsMiddleware', () => {
    let corsMiddleware: ReturnType<typeof createCorsMiddleware>;

    beforeEach(() => {
      corsMiddleware = createCorsMiddleware();
    });

    it('should allow requests from allowed origins', (done) => {
      const mockReq = {
        method: 'GET',
        headers: {
          origin: 'http://localhost:3000',
        },
      } as Request;

      const mockRes = createMockResponse();

      const next = jest.fn(() => {
        // Verify CORS headers were set
        expect(mockRes.setHeader).toHaveBeenCalledWith(
          'Access-Control-Allow-Origin',
          'http://localhost:3000'
        );
        expect(mockRes.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Credentials', 'true');
        done();
      });

      corsMiddleware(mockReq, mockRes, next);
    });

    it('should allow requests from all allowed origins in the list', (done) => {
      const mockReq = {
        method: 'GET',
        headers: {
          origin: 'https://app.example.com',
        },
      } as Request;

      const mockRes = createMockResponse();

      const next = jest.fn(() => {
        expect(mockRes.setHeader).toHaveBeenCalledWith(
          'Access-Control-Allow-Origin',
          'https://app.example.com'
        );
        done();
      });

      corsMiddleware(mockReq, mockRes, next);
    });

    it('should reject requests from non-allowed origins', (done) => {
      const mockReq = {
        method: 'GET',
        headers: {
          origin: 'https://evil.com',
        },
      } as Request;

      const mockRes = createMockResponse();

      const next = jest.fn((error?: Error) => {
        expect(error).toBeDefined();
        expect(error?.message).toBe('Not allowed by CORS');
        done();
      });

      corsMiddleware(mockReq, mockRes, next);
    });

    it('should allow requests with no origin (mobile apps, curl)', (done) => {
      const mockReq = {
        method: 'GET',
        headers: {},
      } as Request;

      const mockRes = createMockResponse();

      const next = jest.fn(() => {
        // Should proceed without error
        expect(next).toHaveBeenCalled();
        done();
      });

      corsMiddleware(mockReq, mockRes, next);
    });

    it('should handle OPTIONS preflight requests correctly', (done) => {
      const mockReq = {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': 'POST',
        },
      } as Request;

      const mockRes = createMockResponse();
      mockRes.end = jest.fn(() => {
        // Verify preflight headers
        expect(mockRes.setHeader).toHaveBeenCalledWith(
          'Access-Control-Allow-Origin',
          'http://localhost:3000'
        );
        expect(mockRes.setHeader).toHaveBeenCalledWith(
          'Access-Control-Allow-Methods',
          'GET,POST,PUT,DELETE,OPTIONS'
        );
        expect(mockRes.setHeader).toHaveBeenCalledWith('Access-Control-Max-Age', '3600');
        done();
        return mockRes;
      });

      const next = jest.fn();

      corsMiddleware(mockReq, mockRes, next);
    });

    it('should restrict to specific HTTP methods', (done) => {
      const mockReq = {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': 'POST',
        },
      } as Request;

      const mockRes = createMockResponse();
      mockRes.end = jest.fn(() => {
        const allowMethodsCall = (mockRes.setHeader as jest.Mock).mock.calls.find(
          (call) => call[0] === 'Access-Control-Allow-Methods'
        );
        expect(allowMethodsCall).toBeDefined();
        const methods = allowMethodsCall?.[1] as string;
        expect(methods).toContain('GET');
        expect(methods).toContain('POST');
        expect(methods).toContain('PUT');
        expect(methods).toContain('DELETE');
        expect(methods).toContain('OPTIONS');
        // Should not include other methods like PATCH, TRACE, etc.
        expect(methods).not.toContain('PATCH');
        expect(methods).not.toContain('TRACE');
        done();
        return mockRes;
      });

      const next = jest.fn();

      corsMiddleware(mockReq, mockRes, next);
    });

    it('should enable credentials support', (done) => {
      const mockReq = {
        method: 'GET',
        headers: {
          origin: 'http://localhost:3000',
        },
      } as Request;

      const mockRes = createMockResponse();

      const next = jest.fn(() => {
        expect(mockRes.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Credentials', 'true');
        done();
      });

      corsMiddleware(mockReq, mockRes, next);
    });

    it('should set preflight cache maxAge to 1 hour', (done) => {
      const mockReq = {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': 'POST',
        },
      } as Request;

      const mockRes = createMockResponse();
      mockRes.end = jest.fn(() => {
        expect(mockRes.setHeader).toHaveBeenCalledWith('Access-Control-Max-Age', '3600');
        done();
        return mockRes;
      });

      const next = jest.fn();

      corsMiddleware(mockReq, mockRes, next);
    });
  });

  describe('CORS with empty or invalid ALLOWED_ORIGINS', () => {
    beforeEach(() => {
      // Reset modules to apply new mock
      jest.resetModules();
    });

    it('should default to localhost:3000 when ALLOWED_ORIGINS is empty', () => {
      jest.doMock('../../src/config/env', () => ({
        getEnv: jest.fn(() => ({
          ALLOWED_ORIGINS: '',
        })),
      }));

      const { getAllowedOrigins: getOriginsEmpty } = require('../../src/config/cors');
      const origins = getOriginsEmpty();
      expect(origins).toEqual(['http://localhost:3000']);
    });

    it('should trim whitespace from origins', () => {
      jest.doMock('../../src/config/env', () => ({
        getEnv: jest.fn(() => ({
          ALLOWED_ORIGINS: '  http://localhost:3000  ,  https://app.example.com  ',
        })),
      }));

      const { getAllowedOrigins: getOriginsTrimmed } = require('../../src/config/cors');
      const origins = getOriginsTrimmed();
      expect(origins).toEqual(['http://localhost:3000', 'https://app.example.com']);
    });
  });
});
