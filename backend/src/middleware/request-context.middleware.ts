import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { requestContext } from '../utils/requestContext';

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.get('x-request-id') || randomUUID();
  requestContext.run({ requestId, method: req.method, path: req.path }, next);
}
