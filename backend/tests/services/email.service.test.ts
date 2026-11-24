/**
 * Unit tests — Email Service
 *
 * Covers:
 *  1. sendEmail() dispatches to the correct recipient for all 6 templates
 *  2. Each template resolves the expected subject line
 *  3. Graceful failure — transport errors are logged and not re-thrown
 *  4. Convenience wrappers (sendPasswordResetEmail, sendExportReadyEmail) use the transport
 *  5. EMAIL_PROVIDER=sendgrid routes to smtp.sendgrid.net
 */

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports
// ---------------------------------------------------------------------------

const mockSendMail = jest.fn();

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail })),
}));

jest.mock('fs', () => ({
  readFileSync: jest.fn(() => '<html>{{appName}} {{verifyUrl}} {{resetUrl}} {{marketTitle}} {{outcome}} {{amount}} {{disputeId}} {{resolution}}</html>'),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports — after mocks so jest intercepts module registration
// ---------------------------------------------------------------------------

import nodemailer from 'nodemailer';
import { logger } from '../../src/utils/logger';
import {
  sendEmail,
  sendPasswordResetEmail,
  sendExportReadyEmail,
  type EmailTemplate,
} from '../../src/services/email.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const APP_NAME = process.env.APP_NAME ?? 'BANKERCHANGER';

function lastSendMailCall() {
  const calls = mockSendMail.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sendEmail()', () => {
  beforeEach(() => {
    mockSendMail.mockClear();
    mockSendMail.mockResolvedValue({ messageId: 'test-id' });
    (logger.error as jest.Mock).mockClear();
  });

  // ── Recipients ───────────────────────────────────────────────────────────
  describe('recipient routing', () => {
    const templates: EmailTemplate[] = [
      'verify_email',
      'reset_password',
      'market_resolved',
      'winnings_available',
      'dispute_filed',
      'dispute_resolved',
    ];

    it.each(templates)('sends to the correct recipient for template "%s"', async (template) => {
      await sendEmail('user@example.com', template, { verifyUrl: 'http://x', resetUrl: 'http://x', marketTitle: 'Test', outcome: 'Yes', amount: '100', disputeId: 'd1', resolution: 'upheld' });
      expect(lastSendMailCall().to).toBe('user@example.com');
    });
  });

  // ── Subject lines ─────────────────────────────────────────────────────────
  describe('subject lines', () => {
    it('verify_email uses correct subject', async () => {
      await sendEmail('a@b.com', 'verify_email', { verifyUrl: 'http://x' });
      expect(lastSendMailCall().subject).toContain('Verify');
    });

    it('reset_password uses correct subject', async () => {
      await sendEmail('a@b.com', 'reset_password', { resetUrl: 'http://x' });
      expect(lastSendMailCall().subject).toContain('Reset');
    });

    it('market_resolved uses correct subject', async () => {
      await sendEmail('a@b.com', 'market_resolved', { marketTitle: 'Fight', outcome: 'Yes' });
      expect(lastSendMailCall().subject).toContain('resolved');
    });

    it('winnings_available uses correct subject', async () => {
      await sendEmail('a@b.com', 'winnings_available', { amount: '50 XLM', marketTitle: 'Fight' });
      expect(lastSendMailCall().subject).toContain('winnings');
    });

    it('dispute_filed uses correct subject', async () => {
      await sendEmail('a@b.com', 'dispute_filed', { marketTitle: 'Fight', disputeId: 'd1' });
      expect(lastSendMailCall().subject).toContain('Dispute filed');
    });

    it('dispute_resolved uses correct subject', async () => {
      await sendEmail('a@b.com', 'dispute_resolved', { marketTitle: 'Fight', resolution: 'upheld' });
      expect(lastSendMailCall().subject).toContain('Dispute resolved');
    });
  });

  // ── Template rendering ────────────────────────────────────────────────────
  it('injects appName into the rendered HTML', async () => {
    await sendEmail('a@b.com', 'verify_email', { verifyUrl: 'http://verify' });
    const mail = lastSendMailCall();
    expect(mail.html as string).toContain(APP_NAME);
  });

  it('interpolates custom data variables into the HTML', async () => {
    await sendEmail('a@b.com', 'verify_email', { verifyUrl: 'http://custom-url' });
    const mail = lastSendMailCall();
    expect(mail.html as string).toContain('http://custom-url');
  });

  it('escapes HTML in user-controlled template data', async () => {
    await sendEmail('a@b.com', 'verify_email', { verifyUrl: `&<>"'` });
    expect(lastSendMailCall().html).toContain('&amp;&lt;&gt;&quot;&#x27;');
  });

  // ── Graceful failure ──────────────────────────────────────────────────────
  describe('graceful failure', () => {
    it('does not throw when sendMail rejects', async () => {
      mockSendMail.mockRejectedValueOnce(new Error('SMTP connection refused'));
      await expect(sendEmail('a@b.com', 'verify_email', {})).resolves.toBeUndefined();
    });

    it('logs an error when sendMail rejects', async () => {
      mockSendMail.mockRejectedValueOnce(new Error('timeout'));
      await sendEmail('a@b.com', 'market_resolved', { marketTitle: 'Fight', outcome: 'Yes' });
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'Failed to send email', template: 'market_resolved' }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

describe('sendPasswordResetEmail()', () => {
  beforeEach(() => {
    mockSendMail.mockClear();
    mockSendMail.mockResolvedValue({ messageId: 'pw-reset-id' });
  });

  it('dispatches a mail to the given address', async () => {
    await sendPasswordResetEmail('user@example.com', 'tok123');
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(lastSendMailCall().to).toBe('user@example.com');
  });

  it('does not throw on transport failure', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('fail'));
    await expect(sendPasswordResetEmail('user@example.com', 'tok')).resolves.toBeUndefined();
  });
});

describe('sendExportReadyEmail()', () => {
  beforeEach(() => {
    mockSendMail.mockClear();
    mockSendMail.mockResolvedValue({ messageId: 'export-id' });
  });

  it('dispatches a mail with CSV attachment', async () => {
    await sendExportReadyEmail('admin@example.com', 'bets', 'col1,col2\n1,2');
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const mail = lastSendMailCall();
    expect(mail.to).toBe('admin@example.com');
    const attachments = mail.attachments as Array<{ filename: string }>;
    expect(attachments[0].filename).toMatch(/bets-export-.+\.csv/);
  });

  it('does not throw on transport failure', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('fail'));
    await expect(sendExportReadyEmail('a@b.com', 'bets', '')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Provider — SendGrid
// ---------------------------------------------------------------------------

describe('EMAIL_PROVIDER=sendgrid', () => {
  const createTransportMock = nodemailer.createTransport as jest.Mock;

  beforeEach(() => {
    createTransportMock.mockClear();
  });

  it('calls createTransport with smtp.sendgrid.net when provider is sendgrid', () => {
    jest.resetModules();

    process.env.EMAIL_PROVIDER = 'sendgrid';
    process.env.SENDGRID_API_KEY = 'SG.test-key';

    // Re-require the module so createTransporter() runs with the new env
    jest.isolateModules(() => {
      jest.mock('nodemailer', () => ({
        createTransport: jest.fn(() => ({ sendMail: jest.fn() })),
      }));
      jest.mock('fs', () => ({ readFileSync: jest.fn(() => '') }));
      jest.mock('../../src/utils/logger', () => ({
        logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
      }));

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodemailerFresh = require('nodemailer') as typeof nodemailer;
      require('../../src/services/email.service');

      expect((nodemailerFresh.createTransport as jest.Mock)).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'smtp.sendgrid.net' }),
      );
    });

    delete process.env.EMAIL_PROVIDER;
    delete process.env.SENDGRID_API_KEY;
  });

  it('falls back to stub transport when SENDGRID_API_KEY is missing', () => {
    jest.isolateModules(() => {
      jest.mock('nodemailer', () => ({
        createTransport: jest.fn(() => ({ sendMail: jest.fn() })),
      }));
      jest.mock('fs', () => ({ readFileSync: jest.fn(() => '') }));
      jest.mock('../../src/utils/logger', () => ({
        logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
      }));

      process.env.EMAIL_PROVIDER = 'sendgrid';
      delete process.env.SENDGRID_API_KEY;

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodemailerFresh = require('nodemailer') as typeof nodemailer;
      require('../../src/services/email.service');

      expect((nodemailerFresh.createTransport as jest.Mock)).toHaveBeenCalledWith(
        expect.objectContaining({ jsonTransport: true }),
      );

      delete process.env.EMAIL_PROVIDER;
    });
  });
});
