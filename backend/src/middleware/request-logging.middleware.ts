import type { Request, Response, NextFunction } from 'express';
import pinoHttp from 'pino-http';
import { requestContext } from '../utils/requestContext';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';
import { httpRequestDuration, httpRequestsTotal } from '../services/metrics.service';

const SENSITIVE_PATHS = [
  '/auth/login',
  '/auth/register',
  '/auth/reset-password',
  '/api/oracle/submit',
  '/api/admin',
];

/**
 * Request logging middleware backed by pino-http.
 * - Generates or accepts an incoming X-Request-Id for tracing.
 * - Stores the request id in AsyncLocalStorage for the whole request lifecycle.
 * - Sets the X-Request-Id response header.
 * - Emits structured JSON logs (method, path, statusCode, responseTime, ip, request_id).
 * - Masks request body for sensitive paths and redacts Authorization header.
 */
export function requestLogging(req: Request, res: Response, next: NextFunction): void {
  const incomingId = req.get('x-request-id');
  const requestId = incomingId && incomingId.trim() ? incomingId.trim() : randomUUID();
  const startTime = Date.now();
  const method = req.method;

  // Record HTTP metrics on response finish
  res.on('finish', () => {
    const durationMs = Date.now() - startTime;
    const route = req.route?.path || req.path;
    const statusCode = String(res.statusCode);
    httpRequestDuration.observe({ method, route, status_code: statusCode }, durationMs);
    httpRequestsTotal.inc({ method, route, status_code: statusCode });
  });

  const isSensitive = SENSITIVE_PATHS.some((p) => req.path.startsWith(p));

  const httpLogger = pinoHttp({
    logger,
    genReqId: () => requestId,
    customProps: () => ({ request_id: requestId }),
    serializers: {
      req: (request: Request) => {
        const authHeader = request.headers.authorization;
        return {
          method: request.method,
          path: request.path,
          ip: request.ip || request.socket?.remoteAddress || 'unknown',
          ...(isSensitive && { body: '[REDACTED]' }),
          ...(authHeader && { authorization: 'Bearer [REDACTED]' }),
        };
      },
      res: (response: Response) => ({
        statusCode: response.statusCode,
      }),
    },
    customLogObject: (req: Request, res: Response, responseTime: number) => ({
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      responseTime: `${responseTime}ms`,
      ip: req.ip || req.socket?.remoteAddress || 'unknown',
      request_id: requestId,
    }),
  });

  // Run the rest of the request lifecycle inside the AsyncLocalStorage context
  // so that request_id is available to all downstream logs.
  requestContext.run({ requestId }, () => {
    httpLogger(req, res, next);
  });
}
