'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');

jest.mock('../src/db');
jest.mock('../src/sms');
jest.mock('../src/memory/store');

describe('deletion', () => {
  let deletion, db, sms, store;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../src/db');
    jest.mock('../src/sms');
    jest.mock('../src/memory/store');

    db = require('../src/db');
    sms = require('../src/sms');
    store = require('../src/memory/store');

    db.getUserById.mockResolvedValue({
      id: 1,
      phone_number: '+15551234567',
      name: 'Alice',
      microsoft_subscription_id: null,
    });
    db.setDeletionCode.mockResolvedValue(undefined);
    db.verifyDeletionCode.mockResolvedValue(true);
    db.clearDeletionCode.mockResolvedValue(undefined);
    db.deleteUser.mockResolvedValue(undefined);
    sms.sendMessage.mockResolvedValue({ success: true });
    store.deleteUserMemories.mockResolvedValue(undefined);

    deletion = require('../src/deletion');
  });

  // ─── isDeletionRequest ─────────────────────────────────────────────────────

  describe('isDeletionRequest', () => {
    it('detects "delete my account"', () => {
      expect(deletion.isDeletionRequest('delete my account')).toBe(true);
    });

    it('detects "delete account"', () => {
      expect(deletion.isDeletionRequest('delete account please')).toBe(true);
    });

    it('detects "stop texting me"', () => {
      expect(deletion.isDeletionRequest('stop texting me')).toBe(true);
    });

    it('detects "unsubscribe"', () => {
      expect(deletion.isDeletionRequest('unsubscribe')).toBe(true);
    });

    it('detects "delete my data"', () => {
      expect(deletion.isDeletionRequest('please delete my data')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(deletion.isDeletionRequest('DELETE MY ACCOUNT')).toBe(true);
    });

    it('returns false for normal message', () => {
      expect(deletion.isDeletionRequest('hey what is up')).toBe(false);
    });

    it('returns false for "stop that" (partial word)', () => {
      expect(deletion.isDeletionRequest('stop that noise')).toBe(false);
    });
  });

  // ─── requestDeletion ──────────────────────────────────────────────────────

  describe('requestDeletion', () => {
    it('calls setDeletionCode with a 6-digit code', async () => {
      await deletion.requestDeletion(1);
      expect(db.setDeletionCode).toHaveBeenCalledWith(
        1,
        expect.stringMatching(/^\d{6}$/)
      );
    });

    it('sends SMS with the code', async () => {
      await deletion.requestDeletion(1);
      expect(sms.sendMessage).toHaveBeenCalledWith(
        '+15551234567',
        expect.stringContaining('delete'),
        1
      );
      const [, msg] = sms.sendMessage.mock.calls[0];
      expect(msg).toMatch(/\d{6}/);
    });

    it('does nothing if user not found', async () => {
      db.getUserById.mockResolvedValue(null);
      await deletion.requestDeletion(99);
      expect(db.setDeletionCode).not.toHaveBeenCalled();
    });
  });

  // ─── confirmDeletion ──────────────────────────────────────────────────────

  describe('confirmDeletion', () => {
    it('returns false when code is invalid', async () => {
      db.verifyDeletionCode.mockResolvedValue(false);
      const result = await deletion.confirmDeletion(1, '000000');
      expect(result).toBe(false);
    });

    it('returns true when code is valid', async () => {
      const result = await deletion.confirmDeletion(1, '123456');
      expect(result).toBe(true);
    });

    it('calls deleteUserMemories on valid code', async () => {
      await deletion.confirmDeletion(1, '123456');
      expect(store.deleteUserMemories).toHaveBeenCalledWith(1);
    });

    it('deletes the user from DB on valid code', async () => {
      await deletion.confirmDeletion(1, '123456');
      expect(db.deleteUser).toHaveBeenCalledWith(1);
    });

    it('stops and removes user cron jobs', async () => {
      const mockStop = jest.fn();
      const userCrons = new Map([[1, [{ stop: mockStop }, { stop: mockStop }]]]);
      await deletion.confirmDeletion(1, '123456', { userCrons });
      expect(mockStop).toHaveBeenCalledTimes(2);
      expect(userCrons.has(1)).toBe(false);
    });

    it('calls cancelGraphSubscription when subscription exists', async () => {
      db.getUserById.mockResolvedValue({
        id: 1,
        phone_number: '+15551234567',
        microsoft_subscription_id: 'sub-abc',
      });
      const cancelGraphSubscription = jest.fn().mockResolvedValue(undefined);
      await deletion.confirmDeletion(1, '123456', { cancelGraphSubscription });
      expect(cancelGraphSubscription).toHaveBeenCalledWith('sub-abc');
    });

    it('does not call cancelGraphSubscription when no subscription', async () => {
      const cancelGraphSubscription = jest.fn();
      await deletion.confirmDeletion(1, '123456', { cancelGraphSubscription });
      expect(cancelGraphSubscription).not.toHaveBeenCalled();
    });

    it('handles deleteUserMemories failure gracefully', async () => {
      store.deleteUserMemories.mockRejectedValue(new Error('qdrant down'));
      await expect(deletion.confirmDeletion(1, '123456')).resolves.toBe(true);
      expect(db.deleteUser).toHaveBeenCalled();
    });

    it('returns false if user not found', async () => {
      db.getUserById.mockResolvedValue(null);
      const result = await deletion.confirmDeletion(1, '123456');
      expect(result).toBe(false);
    });
  });
});
