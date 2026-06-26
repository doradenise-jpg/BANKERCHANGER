// backend/tests/controllers/users.controller.test.ts
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Request, Response } from 'express';
import { UsersController } from '../../src/controllers/users.controller';
import { UserService } from '../../src/services/user.service';
import { AuthenticatedRequest } from '../../src/types/auth.types';

jest.mock('../../src/services/user.service');

const SENSITIVE_FIELDS = ['passwordHash', 'twoFactorSecret', 'resetTokenHash', 'sessionVersion'];

const mockDTO = {
  id: 'user-1',
  email: 'test@example.com',
  emailVerified: true,
  twoFactorEnabled: false,
  createdAt: new Date().toISOString(),
};

function makeMockRes() {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnThis();
  return { json, status, res: { json, status } as unknown as Response };
}

function makeReq(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    params: {},
    query: {},
    body: {},
    user: { userId: 'user-1', email: 'test@example.com', sessionVersion: 1 },
    ...overrides,
  } as unknown as AuthenticatedRequest;
}

function assertNoSensitiveFields(jsonArgs: unknown[]): void {
  for (const arg of jsonArgs) {
    const str = JSON.stringify(arg);
    for (const field of SENSITIVE_FIELDS) {
      expect(str).not.toContain(field);
    }
  }
}

describe('UsersController — sensitive field exclusion', () => {
  let controller: UsersController;
  let mockService: jest.Mocked<UserService>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockService = new UserService() as jest.Mocked<UserService>;
    (UserService as jest.MockedClass<typeof UserService>).mockImplementation(() => mockService);
    controller = new UsersController();

    mockService.getPublicProfile = jest.fn().mockReturnValue(mockDTO) as jest.MockedFunction<typeof mockService.getPublicProfile>;
    mockService.getMyProfile = jest.fn().mockReturnValue(mockDTO) as jest.MockedFunction<typeof mockService.getMyProfile>;
    mockService.updateProfile = jest.fn().mockReturnValue(mockDTO) as jest.MockedFunction<typeof mockService.updateProfile>;
    mockService.listUsers = jest.fn().mockReturnValue({
      users: [mockDTO],
      total: 1,
      page: 1,
      limit: 20,
    }) as jest.MockedFunction<typeof mockService.listUsers>;
    mockService.suspendUser = jest.fn() as jest.MockedFunction<typeof mockService.suspendUser>;
    mockService.updateUserRole = jest.fn().mockReturnValue({ id: 'user-1', tier: 'BEGINNER' }) as jest.MockedFunction<typeof mockService.updateUserRole>;
  });

  it('GET /api/users/:id — getProfile omits sensitive fields', async () => {
    const req = makeReq({ params: { id: 'user-1' } });
    const { res, json } = makeMockRes();

    await controller.getProfile(req, res);

    assertNoSensitiveFields(json.mock.calls.flat());
  });

  it('GET /api/users/me — getMyProfile omits sensitive fields', async () => {
    const req = makeReq();
    const { res, json } = makeMockRes();

    await controller.getMyProfile(req, res);

    assertNoSensitiveFields(json.mock.calls.flat());
  });

  it('PATCH /api/users/me — updateMyProfile omits sensitive fields', async () => {
    const req = makeReq({ body: { username: 'newuser' } });
    const { res, json } = makeMockRes();

    await controller.updateMyProfile(req, res);

    assertNoSensitiveFields(json.mock.calls.flat());
  });

  it('GET /api/users — listUsers omits sensitive fields', async () => {
    const req = makeReq({ query: { page: '1', limit: '20' } });
    const { res, json } = makeMockRes();

    await controller.listUsers(req, res);

    assertNoSensitiveFields(json.mock.calls.flat());
  });

  it('PATCH /api/users/:id/role — updateRole omits sensitive fields', async () => {
    const req = makeReq({ params: { id: 'user-1' }, body: { role: 'BEGINNER' } });
    const { res, json } = makeMockRes();

    await controller.updateRole(req, res);

    assertNoSensitiveFields(json.mock.calls.flat());
  });

  it('toUserDTO never passes through sensitive fields even if source has them', () => {
    const { toUserDTO } = jest.requireActual<typeof import('../../src/dto/user.dto')>('../../src/dto/user.dto');

    const rawRecord = {
      id: 'u1',
      email: 'a@b.com',
      emailVerified: false,
      twoFactorEnabled: false,
      passwordHash: 'SHOULD_NOT_APPEAR',
      twoFactorSecret: 'SHOULD_NOT_APPEAR',
      resetTokenHash: 'SHOULD_NOT_APPEAR',
      sessionVersion: 99,
    };

    const dto = toUserDTO(rawRecord);
    const str = JSON.stringify(dto);

    for (const field of SENSITIVE_FIELDS) {
      expect(str).not.toContain(field);
    }
    expect(str).not.toContain('SHOULD_NOT_APPEAR');
    expect(dto).toMatchObject({ id: 'u1', email: 'a@b.com' });
  });
});
