'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');

jest.mock('@azure/msal-node');
jest.mock('@microsoft/microsoft-graph-client');
jest.mock('../../src/db');
jest.mock('../../src/utils/cache');
jest.mock('../../src/sms');

describe('outlook integration', () => {
  let outlook, db, cache, sms;
  let mockAcquireToken, mockApiGet, mockApiPost, mockApiPatch, mockApiChain, mockGraphClient;
  let ConfidentialClientApplication, Client;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('@azure/msal-node');
    jest.mock('@microsoft/microsoft-graph-client');
    jest.mock('../../src/db');
    jest.mock('../../src/utils/cache');
    jest.mock('../../src/sms');

    db = require('../../src/db');
    cache = require('../../src/utils/cache');
    sms = require('../../src/sms');

    cache.get.mockReturnValue(null);
    cache.set.mockReturnValue(undefined);

    // MSAL mock
    mockAcquireToken = jest.fn().mockResolvedValue({
      accessToken: 'test_access_token',
      refreshToken: null,
    });
    ({ ConfidentialClientApplication } = require('@azure/msal-node'));
    ConfidentialClientApplication.mockImplementation(() => ({
      acquireTokenByRefreshToken: mockAcquireToken,
    }));

    // Graph client mock — chainable API builder
    mockApiGet = jest.fn();
    mockApiPost = jest.fn();
    mockApiPatch = jest.fn();
    mockApiChain = {
      select: jest.fn().mockReturnThis(),
      filter: jest.fn().mockReturnThis(),
      top: jest.fn().mockReturnThis(),
      query: jest.fn().mockReturnThis(),
      get: mockApiGet,
      post: mockApiPost,
      patch: mockApiPatch,
    };
    mockGraphClient = { api: jest.fn().mockReturnValue(mockApiChain) };

    ({ Client } = require('@microsoft/microsoft-graph-client'));
    Client.initWithMiddleware = jest.fn().mockReturnValue(mockGraphClient);

    // Default: user with Microsoft token
    db.getUserById.mockResolvedValue({
      id: 1,
      phone_number: '+15551234567',
      microsoft_refresh_token: 'existing_refresh_token',
      microsoft_subscription_id: null,
    });
    db.updateUser.mockResolvedValue(undefined);

    sms.sendMessage.mockResolvedValue(undefined);

    outlook = require('../../src/integrations/outlook');
  });

  // ─── getGraphClient ───────────────────────────────────────────────────────────

  describe('getGraphClient', () => {
    it('returns null when no token in DB', async () => {
      db.getUserById.mockResolvedValue({ id: 1, microsoft_refresh_token: null });

      const client = await outlook.getGraphClient(1);

      expect(client).toBeNull();
      expect(mockAcquireToken).not.toHaveBeenCalled();
    });

    it('returns client when token exists', async () => {
      const client = await outlook.getGraphClient(1);

      expect(client).not.toBeNull();
      expect(mockAcquireToken).toHaveBeenCalledWith({
        refreshToken: 'existing_refresh_token',
        scopes: ['Mail.Read', 'Mail.Send', 'Calendars.Read', 'Calendars.ReadWrite'],
      });
      expect(Client.initWithMiddleware).toHaveBeenCalled();
    });

    it('saves new refresh token if returned', async () => {
      mockAcquireToken.mockResolvedValue({
        accessToken: 'new_access_token',
        refreshToken: 'new_refresh_token',
      });

      await outlook.getGraphClient(1);

      expect(db.updateUser).toHaveBeenCalledWith(1, {
        microsoft_refresh_token: 'new_refresh_token',
      });
    });

    it('returns null and logs error on MSAL failure', async () => {
      mockAcquireToken.mockRejectedValue(new Error('token expired'));

      const client = await outlook.getGraphClient(1);

      expect(client).toBeNull();
    });
  });

  // ─── isEmailImportant ─────────────────────────────────────────────────────────

  describe('isEmailImportant', () => {
    it('returns true for .edu sender', () => {
      const result = outlook.isEmailImportant({ from: 'prof@vt.edu', subject: 'hello' });
      expect(result.important).toBe(true);
      expect(result.reason).toContain('.edu');
    });

    it('returns true for .gov sender', () => {
      const result = outlook.isEmailImportant({ from: 'notice@irs.gov', subject: 'update' });
      expect(result.important).toBe(true);
      expect(result.reason).toContain('.gov');
    });

    it('returns true for subject with exam', () => {
      const result = outlook.isEmailImportant({ from: 'nobody@gmail.com', subject: 'Exam schedule update' });
      expect(result.important).toBe(true);
      expect(result.reason).toContain('exam');
    });

    it('returns true for subject with financial aid', () => {
      const result = outlook.isEmailImportant({ from: 'aid@someservice.com', subject: 'Your financial aid package' });
      expect(result.important).toBe(true);
      expect(result.reason).toContain('financial aid');
    });

    it('returns false for random newsletter', () => {
      const result = outlook.isEmailImportant({ from: 'deals@somestore.com', subject: 'Weekend sale this Saturday!' });
      expect(result.important).toBe(false);
      expect(result.reason).toBe('');
    });
  });

  // ─── getUnreadEmails ──────────────────────────────────────────────────────────

  describe('getUnreadEmails', () => {
    it('returns empty array when no client', async () => {
      db.getUserById.mockResolvedValue({ id: 1, microsoft_refresh_token: null });

      const result = await outlook.getUnreadEmails(1);

      expect(result).toEqual([]);
      expect(mockApiGet).not.toHaveBeenCalled();
    });

    it('returns formatted array on success', async () => {
      mockApiGet.mockResolvedValue({
        value: [{
          id: 'msg1',
          subject: 'Office Hours Tomorrow',
          from: { emailAddress: { address: 'prof@vt.edu', name: 'Prof Smith' } },
          receivedDateTime: '2026-03-23T10:00:00Z',
          bodyPreview: 'Come see me during office hours',
          importance: 'normal',
        }],
      });

      const result = await outlook.getUnreadEmails(1);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'msg1',
        subject: 'Office Hours Tomorrow',
        from: 'prof@vt.edu',
        fromName: 'Prof Smith',
        bodyPreview: 'Come see me during office hours',
        importance: 'normal',
      });
    });

    it('returns empty array on API error', async () => {
      mockApiGet.mockRejectedValue(new Error('Graph API error'));

      const result = await outlook.getUnreadEmails(1);

      expect(result).toEqual([]);
    });

    it('never includes full email bodies', async () => {
      mockApiGet.mockResolvedValue({
        value: [{
          id: 'msg1',
          subject: 'Test',
          from: { emailAddress: { address: 'a@b.com', name: 'A' } },
          receivedDateTime: '2026-03-23T10:00:00Z',
          bodyPreview: 'Short preview only',
          // body field not selected — shouldn't appear in results
          body: { contentType: 'html', content: '<html>FULL BODY CONTENT HERE</html>' },
          importance: 'normal',
        }],
      });

      const result = await outlook.getUnreadEmails(1);

      expect(result[0]).not.toHaveProperty('body');
      expect(JSON.stringify(result[0])).not.toContain('FULL BODY CONTENT HERE');
    });

    it('returns cached result on second call', async () => {
      cache.get.mockReturnValue([{ id: 'cached', subject: 'Cached email' }]);

      const result = await outlook.getUnreadEmails(1);

      expect(result).toEqual([{ id: 'cached', subject: 'Cached email' }]);
      expect(mockApiGet).not.toHaveBeenCalled();
    });
  });

  // ─── webhook handler ─────────────────────────────────────────────────────────

  describe('webhook handler', () => {
    let mockRes;

    beforeEach(() => {
      mockRes = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis(),
        contentType: jest.fn().mockReturnThis(),
      };
    });

    it('responds with validationToken on validation challenge', async () => {
      const mockReq = { query: { validationToken: 'abc-123-xyz' }, body: {} };

      await outlook.graphWebhookHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.contentType).toHaveBeenCalledWith('text/plain');
      expect(mockRes.send).toHaveBeenCalledWith('abc-123-xyz');
    });

    it('returns 202 immediately for real notifications', async () => {
      const mockReq = {
        query: {},
        body: { value: [{ clientState: '1', resourceData: { id: 'msg1' } }] },
      };
      mockApiGet.mockResolvedValue({
        subject: 'test',
        from: { emailAddress: { address: 'x@x.com' } },
        bodyPreview: '',
      });

      await outlook.graphWebhookHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(202);
      expect(mockRes.send).toHaveBeenCalled();
    });

    it('sends iMessage for important emails', async () => {
      mockApiGet.mockResolvedValue({
        subject: 'Exam scores posted',
        from: { emailAddress: { address: 'prof@vt.edu' } },
        bodyPreview: 'Your exam has been graded',
      });

      await outlook.processEmailNotification('1', { resourceData: { id: 'msg1' } });

      expect(sms.sendMessage).toHaveBeenCalledWith(
        '+15551234567',
        expect.stringContaining('prof@vt.edu'),
        1,
      );
    });

    it('skips non-important emails', async () => {
      mockApiGet.mockResolvedValue({
        subject: 'Check out this weekend sale!',
        from: { emailAddress: { address: 'promo@somestore.com' } },
        bodyPreview: 'Deals inside',
      });

      await outlook.processEmailNotification('1', { resourceData: { id: 'msg2' } });

      expect(sms.sendMessage).not.toHaveBeenCalled();
    });

    it('handles missing user gracefully', async () => {
      db.getUserById.mockResolvedValue(null);

      await expect(
        outlook.processEmailNotification('999', { resourceData: { id: 'msg3' } })
      ).resolves.not.toThrow();

      expect(sms.sendMessage).not.toHaveBeenCalled();
    });

    it('skips notifications with no clientState', async () => {
      const mockReq = {
        query: {},
        body: { value: [{ resourceData: { id: 'msg1' } }] }, // no clientState
      };

      await outlook.graphWebhookHandler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(202);
      expect(sms.sendMessage).not.toHaveBeenCalled();
    });
  });
});
