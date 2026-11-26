import type { Request, Response, NextFunction } from 'express';
import pinoHttp from 'pino-http';
import { requestLogging } from '../../src/middleware/request-logging.middleware';

jest.mock('pino-http', () => ({
  __esModule: true,
  default: jest.fn(() => (_req: Request, _res: Response, next: NextFunction) => next()),
}));

describe('Authorization Header Redaction (#283)', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = {
      ip: '192.168.1.1',
      method: 'GET',
      path: '/api/markets',
      body: {},
      headers: {},
      get: jest.fn().mockReturnValue(undefined),
      socket: { remoteAddress: '192.168.1.1' } as any,
    };
    mockRes = {
      statusCode: 200,
      on: jest.fn(),
    };
    mockNext = jest.fn();
  });

  function getLoggedRequest(): Record<string, unknown> {
    const options = (pinoHttp as jest.Mock).mock.calls[0][0];
    return options.serializers.req(mockReq);
  }

  it('redacts an Authorization bearer token', () => {
    const token = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
    mockReq.headers = { authorization: token };

    requestLogging(mockReq as Request, mockRes as Response, mockNext);

    const loggedRequest = getLoggedRequest();
    expect(loggedRequest.authorization).toBe('Bearer [REDACTED]');
    expect(loggedRequest.authorization).not.toContain(token.split(' ')[1]);
  });

  it('omits the authorization property when no header is present', () => {
    requestLogging(mockReq as Request, mockRes as Response, mockNext);

    expect(getLoggedRequest().authorization).toBeUndefined();
  });

  it('redacts bearer tokens with different contents', () => {
    const tokens = [
      'Bearer abc123',
      'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      'Bearer token_with_special_chars!@#$%',
    ];

    for (const token of tokens) {
      jest.clearAllMocks();
      mockReq.headers = { authorization: token };

      requestLogging(mockReq as Request, mockRes as Response, mockNext);

      expect(getLoggedRequest().authorization).toBe('Bearer [REDACTED]');
    }
  });

  it('redacts request bodies on sensitive paths', () => {
    mockReq.body = { password: 'secret123' };
    mockReq.path = '/auth/register';

    requestLogging(mockReq as Request, mockRes as Response, mockNext);

    const loggedRequest = getLoggedRequest();
    expect(loggedRequest.body).toBe('[REDACTED]');
    expect(loggedRequest.body).not.toContain('secret123');
  });

  it('redacts both body and authorization on sensitive paths', () => {
    mockReq.headers = { authorization: 'Bearer secrettoken123' };
    mockReq.body = { password: 'secret123' };
    mockReq.path = '/auth/login';

    requestLogging(mockReq as Request, mockRes as Response, mockNext);

    const loggedRequest = getLoggedRequest();
    expect(loggedRequest.body).toBe('[REDACTED]');
    expect(loggedRequest.authorization).toBe('Bearer [REDACTED]');
  });
});
