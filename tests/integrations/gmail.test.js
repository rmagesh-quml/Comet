'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');

// Factory mock — only uses jest globals, safe to hoist
jest.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: jest.fn() },
    gmail: jest.fn(),
    calendar: jest.fn(),
  },
}));

jest.mock('../../src/db');
jest.mock('../../src/utils/cache');
jest.mock('../../src/sms');
jest.mock('../../src/integrations/outlook');

describe('gmail integration', () => {
  let gmail, db, cache, sms, outlookMock;
  let mockGmailList, mockGmailGet, mockCalendarList, mockGmailWatch, mockHistoryList;
  let mockGmailClient, mockCalendarClient;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../../src/db');
    jest.mock('../../src/utils/cache');
    jest.mock('../../src/sms');
    jest.mock('../../src/integrations/outlook');

    db = require('../../src/db');
    cache = require('../../src/utils/cache');
    sms = require('../../src/sms');
    outlookMock = require('../../src/integrations/outlook');

    cache.get.mockReturnValue(null);
    cache.set.mockReturnValue(undefined);
    sms.sendMessage.mockResolvedValue(undefined);

    // googleapis mock setup
    const { google } = require('googleapis');

    mockGmailList = jest.fn();
    mockGmailGet = jest.fn();
    mockCalendarList = jest.fn();
    mockGmailWatch = jest.fn();
    mockHistoryList = jest.fn();

    mockGmailClient = {
      users: {
        messages: { list: mockGmailList, get: mockGmailGet },
        history: { list: mockHistoryList },
        watch: mockGmailWatch,
      },
    };
    mockCalendarClient = { events: { list: mockCalendarList } };

    const mockOAuth2Instance = { setCredentials: jest.fn(), on: jest.fn() };
    google.auth.OAuth2.mockImplementation(() => mockOAuth2Instance);
    google.gmail.mockReturnValue(mockGmailClient);
    google.calendar.mockReturnValue(mockCalendarClient);

    // Default: user with Google token
    db.getUserById.mockResolvedValue({
      id: 1,
      phone_number: '+15551234567',
      google_refresh_token: 'test_refresh_token',
      google_history_id: '100',
      google_email: 'student@gmail.com',
    });
    db.updateUser.mockResolvedValue(undefined);
    db.getUserByGoogleEmail.mockResolvedValue(null);

    // Default outlook stubs
    outlookMock.getUnreadEmails.mockResolvedValue([]);
    outlookMock.getEmailBody.mockResolvedValue(null);
    outlookMock.isEmailImportant.mockReturnValue({ important: false, reason: '' });

    gmail = require('../../src/integrations/gmail');
  });

  // ─── getUnreadEmails ──────────────────────────────────────────────────────────

  describe('getUnreadEmails', () => {
    it('returns empty array when no Google token', async () => {
      db.getUserById.mockResolvedValue({ id: 1, google_refresh_token: null });

      const result = await gmail.getUnreadEmails(1);

      expect(result).toEqual([]);
      expect(mockGmailList).not.toHaveBeenCalled();
    });

    it('returns formatted metadata array', async () => {
      mockGmailList.mockResolvedValue({
        data: { messages: [{ id: 'msg1' }, { id: 'msg2' }] },
      });
      mockGmailGet
        .mockResolvedValueOnce({
          data: {
            id: 'msg1',
            snippet: 'Please prepare for the upcoming exam',
            payload: {
              headers: [
                { name: 'Subject', value: 'Exam next week' },
                { name: 'From', value: 'Prof Smith <prof@vt.edu>' },
                { name: 'Date', value: 'Mon, 23 Mar 2026 10:00:00 +0000' },
              ],
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            id: 'msg2',
            snippet: 'Check out our sale',
            payload: {
              headers: [
                { name: 'Subject', value: 'Big sale today!' },
                { name: 'From', value: 'promo@store.com' },
                { name: 'Date', value: 'Mon, 23 Mar 2026 11:00:00 +0000' },
              ],
            },
          },
        });

      outlookMock.isEmailImportant
        .mockReturnValueOnce({ important: true, reason: 'from .edu address' })
        .mockReturnValueOnce({ important: false, reason: '' });

      const result = await gmail.getUnreadEmails(1);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: 'msg1',
        subject: 'Exam next week',
        from: 'prof@vt.edu',
        fromName: 'Prof Smith',
        isImportant: true,
        isInternship: false,
      });
      expect(result[1]).toMatchObject({
        id: 'msg2',
        isImportant: false,
        isInternship: false,
      });
    });

    it('correctly flags internship emails by domain', async () => {
      mockGmailList.mockResolvedValue({ data: { messages: [{ id: 'msg1' }] } });
      mockGmailGet.mockResolvedValue({
        data: {
          id: 'msg1',
          snippet: 'Update on your application',
          payload: {
            headers: [
              { name: 'Subject', value: 'Your application at Acme' },
              { name: 'From', value: 'noreply@greenhouse.io' },
              { name: 'Date', value: 'Mon, 23 Mar 2026 10:00:00 +0000' },
            ],
          },
        },
      });
      outlookMock.isEmailImportant.mockReturnValue({ important: false, reason: '' });

      const result = await gmail.getUnreadEmails(1);

      expect(result[0].isInternship).toBe(true);
    });

    it('correctly flags internship emails by subject keyword', async () => {
      mockGmailList.mockResolvedValue({ data: { messages: [{ id: 'msg1' }] } });
      mockGmailGet.mockResolvedValue({
        data: {
          id: 'msg1',
          snippet: '',
          payload: {
            headers: [
              { name: 'Subject', value: 'We want to move forward with your application' },
              { name: 'From', value: 'hr@somecorp.com' },
              { name: 'Date', value: 'Mon, 23 Mar 2026 10:00:00 +0000' },
            ],
          },
        },
      });
      outlookMock.isEmailImportant.mockReturnValue({ important: false, reason: '' });

      const result = await gmail.getUnreadEmails(1);

      expect(result[0].isInternship).toBe(true);
    });

    it('returns cached result on second call', async () => {
      cache.get.mockReturnValue([{ id: 'cached-msg', subject: 'Cached' }]);

      const result = await gmail.getUnreadEmails(1);

      expect(result).toEqual([{ id: 'cached-msg', subject: 'Cached' }]);
      expect(mockGmailList).not.toHaveBeenCalled();
    });

    it('returns empty array on API error', async () => {
      mockGmailList.mockRejectedValue(new Error('Gmail API down'));

      const result = await gmail.getUnreadEmails(1);

      expect(result).toEqual([]);
    });
  });

  // ─── parseVenmoEmails ─────────────────────────────────────────────────────────

  describe('parseVenmoEmails', () => {
    it('returns null when no Gmail connected', async () => {
      db.getUserById.mockResolvedValue({ id: 1, google_refresh_token: null });

      const result = await gmail.parseVenmoEmails(1);

      expect(result).toBeNull();
    });

    it('parses "You paid X $Y for Z" correctly', async () => {
      mockGmailList.mockResolvedValue({ data: { messages: [{ id: 'v1' }] } });
      mockGmailGet.mockResolvedValue({
        data: {
          payload: {
            headers: [
              { name: 'Subject', value: 'You paid Alex $25.00 for dinner' },
              { name: 'Date', value: new Date().toUTCString() },
            ],
          },
        },
      });

      const result = await gmail.parseVenmoEmails(1);

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0]).toMatchObject({
        direction: 'paid',
        name: 'Alex',
        amount: 25.00,
        desc: 'dinner',
      });
      expect(result.monthlySpend).toBe(25.00);
    });

    it('parses "X paid you $Y for Z" correctly', async () => {
      mockGmailList.mockResolvedValue({ data: { messages: [{ id: 'v1' }] } });
      mockGmailGet.mockResolvedValue({
        data: {
          payload: {
            headers: [
              { name: 'Subject', value: 'Jordan paid you $15.50 for pizza' },
              { name: 'Date', value: new Date().toUTCString() },
            ],
          },
        },
      });

      const result = await gmail.parseVenmoEmails(1);

      expect(result.transactions[0]).toMatchObject({
        direction: 'received',
        name: 'Jordan',
        amount: 15.50,
        desc: 'pizza',
      });
      expect(result.monthlySpend).toBe(0); // received, not paid
    });

    it('handles malformed subjects gracefully', async () => {
      mockGmailList.mockResolvedValue({
        data: { messages: [{ id: 'v1' }, { id: 'v2' }] },
      });
      mockGmailGet
        .mockResolvedValueOnce({
          data: {
            payload: {
              headers: [
                { name: 'Subject', value: 'Venmo notification — weekly summary' },
                { name: 'Date', value: new Date().toUTCString() },
              ],
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            payload: {
              headers: [
                { name: 'Subject', value: 'You paid Sam $10.00 for coffee' },
                { name: 'Date', value: new Date().toUTCString() },
              ],
            },
          },
        });

      const result = await gmail.parseVenmoEmails(1);

      expect(result.transactions).toHaveLength(1); // malformed one is skipped
      expect(result.transactions[0].amount).toBe(10.00);
    });

    it('calculates monthly spend correctly (paid only, not received)', async () => {
      const now = new Date().toUTCString();
      mockGmailList.mockResolvedValue({
        data: { messages: [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }] },
      });
      mockGmailGet
        .mockResolvedValueOnce({
          data: {
            payload: {
              headers: [
                { name: 'Subject', value: 'You paid Alex $30.00 for groceries' },
                { name: 'Date', value: now },
              ],
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            payload: {
              headers: [
                { name: 'Subject', value: 'You paid Jordan $20.00 for gas' },
                { name: 'Date', value: now },
              ],
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            payload: {
              headers: [
                { name: 'Subject', value: 'Sam paid you $50.00 for concert tickets' },
                { name: 'Date', value: now },
              ],
            },
          },
        });

      const result = await gmail.parseVenmoEmails(1);

      expect(result.monthlySpend).toBe(50.00); // 30 + 20, received $50 not counted
      expect(result.transactions).toHaveLength(3);
    });

    it('returns no transactions when inbox is empty', async () => {
      mockGmailList.mockResolvedValue({ data: { messages: [] } });

      const result = await gmail.parseVenmoEmails(1);

      expect(result).toEqual({ monthlySpend: 0, transactions: [], isLowOnFunds: false });
    });
  });

  // ─── getAllEmailContext ────────────────────────────────────────────────────────

  describe('getAllEmailContext', () => {
    it('returns both school and personal arrays', async () => {
      outlookMock.getUnreadEmails.mockResolvedValue([
        { id: 'o1', subject: 'Canvas announcement', from: 'lms@vt.edu', fromName: 'Canvas' },
      ]);
      outlookMock.isEmailImportant.mockReturnValue({ important: true, reason: 'from .edu' });
      outlookMock.getEmailBody.mockResolvedValue('School email body text');

      mockGmailList.mockResolvedValue({ data: { messages: [] } });

      const result = await gmail.getAllEmailContext(1);

      expect(result).toHaveProperty('school');
      expect(result).toHaveProperty('personal');
      expect(result.school).toHaveLength(1);
      expect(result.school[0].body).toBe('School email body text');
      expect(result.personal).toEqual([]);
    });

    it('fetches bodies for important Gmail emails', async () => {
      outlookMock.getUnreadEmails.mockResolvedValue([]);
      mockGmailList.mockResolvedValue({ data: { messages: [{ id: 'g1' }] } });

      // First mockGmailGet call: metadata (from getUnreadEmails)
      // Second mockGmailGet call: full message (from getEmailBody)
      mockGmailGet
        .mockResolvedValueOnce({
          data: {
            id: 'g1',
            snippet: 'We want to move forward',
            payload: {
              headers: [
                { name: 'Subject', value: 'Application update' },
                { name: 'From', value: 'noreply@greenhouse.io' },
                { name: 'Date', value: new Date().toUTCString() },
              ],
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            payload: {
              mimeType: 'text/plain',
              body: {
                data: Buffer.from('Congratulations! We want to move forward.').toString('base64'),
              },
            },
          },
        });

      outlookMock.isEmailImportant.mockReturnValue({ important: false, reason: '' });

      const result = await gmail.getAllEmailContext(1);

      expect(result.personal).toHaveLength(1);
      expect(result.personal[0]).toHaveProperty('isInternship', true);
      expect(result.personal[0].body).toContain('Congratulations');
    });

    it('handles one source failing gracefully', async () => {
      outlookMock.getUnreadEmails.mockRejectedValue(new Error('Outlook down'));
      mockGmailList.mockResolvedValue({ data: { messages: [] } });

      const result = await gmail.getAllEmailContext(1);

      expect(result.school).toEqual([]);
      expect(result.personal).toEqual([]);
    });

    it('limits bodies to 3 per source', async () => {
      // 5 important Outlook emails — only 3 should get bodies fetched
      const outlookEmails = Array.from({ length: 5 }, (_, i) => ({
        id: `o${i}`,
        subject: `Important ${i}`,
        from: `prof${i}@vt.edu`,
        fromName: `Prof ${i}`,
      }));
      outlookMock.getUnreadEmails.mockResolvedValue(outlookEmails);
      outlookMock.isEmailImportant.mockReturnValue({ important: true, reason: '.edu' });
      outlookMock.getEmailBody.mockResolvedValue('body');

      mockGmailList.mockResolvedValue({ data: { messages: [] } });

      const result = await gmail.getAllEmailContext(1);

      expect(result.school).toHaveLength(3);
      expect(outlookMock.getEmailBody).toHaveBeenCalledTimes(3);
    });
  });
});
