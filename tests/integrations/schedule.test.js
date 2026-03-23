'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');

jest.mock('../../src/db');
jest.mock('../../src/utils/claude');

describe('schedule integration', () => {
  let schedule, db, claude;

  const sampleSchedule = [
    { name: 'CS 3114', days: ['M', 'W', 'F'], startTime: '09:00', endTime: '09:50', location: 'MCB 100', professor: 'Dr. Jones' },
    { name: 'MATH 2114', days: ['T', 'Th'], startTime: '11:00', endTime: '12:15', location: 'MN 109', professor: 'Dr. Smith' },
    { name: 'PHYS 2305', days: ['M', 'W', 'F'], startTime: '14:00', endTime: '14:50', location: 'Robeson Hall', professor: null },
  ];

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../../src/db');
    jest.mock('../../src/utils/claude');

    db = require('../../src/db');
    claude = require('../../src/utils/claude');

    db.getUserById.mockResolvedValue({ id: 1, class_schedule: sampleSchedule });
    db.updateUser.mockResolvedValue(undefined);

    schedule = require('../../src/integrations/schedule');
  });

  // ─── storeClassSchedule ───────────────────────────────────────────────────

  describe('storeClassSchedule', () => {
    it('calls classify and saves parsed schedule', async () => {
      claude.classify.mockResolvedValue(JSON.stringify(sampleSchedule));

      const result = await schedule.storeClassSchedule(1, 'CS 3114 MWF 9-9:50am MCB 100\nMATH 2114 TTh 11am-12:15pm');

      expect(claude.classify).toHaveBeenCalled();
      expect(db.updateUser).toHaveBeenCalledWith(1, { class_schedule: sampleSchedule });
      expect(result).toEqual(sampleSchedule);
    });

    it('returns empty array on invalid JSON from classify', async () => {
      claude.classify.mockResolvedValue('not valid json');

      const result = await schedule.storeClassSchedule(1, 'some text');

      expect(result).toEqual([]);
      expect(db.updateUser).not.toHaveBeenCalled();
    });

    it('returns empty array when classify returns non-array', async () => {
      claude.classify.mockResolvedValue(JSON.stringify({ notAnArray: true }));

      const result = await schedule.storeClassSchedule(1, 'some text');

      expect(result).toEqual([]);
    });

    it('returns empty array on classify error', async () => {
      claude.classify.mockRejectedValue(new Error('Claude down'));

      const result = await schedule.storeClassSchedule(1, 'some text');

      expect(result).toEqual([]);
    });
  });

  // ─── getClassSchedule ─────────────────────────────────────────────────────

  describe('getClassSchedule', () => {
    it('returns schedule from DB', async () => {
      const result = await schedule.getClassSchedule(1);
      expect(result).toEqual(sampleSchedule);
    });

    it('returns empty array when no schedule set', async () => {
      db.getUserById.mockResolvedValue({ id: 1, class_schedule: null });

      const result = await schedule.getClassSchedule(1);

      expect(result).toEqual([]);
    });
  });

  // ─── isInClass ────────────────────────────────────────────────────────────

  describe('isInClass', () => {
    it('returns true when currently in class (Monday 9:30am)', async () => {
      // Monday = getDay() 1, 9:30 is between 09:00 and 09:50
      const monday930 = new Date('2026-03-23T09:30:00'); // Monday

      const result = await schedule.isInClass(1, monday930);

      expect(result).toBe(true);
    });

    it('returns false when between classes (Monday 10:00am)', async () => {
      const monday10 = new Date('2026-03-23T10:00:00');

      const result = await schedule.isInClass(1, monday10);

      expect(result).toBe(false);
    });

    it('returns false when no class on that day (Saturday)', async () => {
      const saturday = new Date('2026-03-28T09:30:00'); // Saturday

      const result = await schedule.isInClass(1, saturday);

      expect(result).toBe(false);
    });

    it('returns false at exact endTime (half-open interval)', async () => {
      // CS 3114 ends at 09:50 — should NOT be in class at exactly 09:50
      const monday950 = new Date('2026-03-23T09:50:00');

      const result = await schedule.isInClass(1, monday950);

      expect(result).toBe(false);
    });

    it('returns true at exact startTime', async () => {
      const monday900 = new Date('2026-03-23T09:00:00');

      const result = await schedule.isInClass(1, monday900);

      expect(result).toBe(true);
    });

    it('returns false when no schedule', async () => {
      db.getUserById.mockResolvedValue({ id: 1, class_schedule: null });

      const result = await schedule.isInClass(1, new Date());

      expect(result).toBe(false);
    });

    it('returns true for Tuesday class (MATH 2114)', async () => {
      // Tuesday = getDay() 2, 11:30 is between 11:00 and 12:15
      const tuesday1130 = new Date('2026-03-24T11:30:00'); // Tuesday

      const result = await schedule.isInClass(1, tuesday1130);

      expect(result).toBe(true);
    });
  });

  // ─── getFreeBlocksToday ───────────────────────────────────────────────────

  describe('getFreeBlocksToday', () => {
    it('returns free blocks around class schedule on Monday', async () => {
      // Monday: CS 3114 09:00-09:50, PHYS 2305 14:00-14:50
      // Expected blocks: 08:00-09:00, 09:50-14:00, 14:50-22:00
      const monday = new Date('2026-03-23T08:00:00');

      const blocks = await schedule.getFreeBlocksToday(1, monday);

      expect(blocks.length).toBeGreaterThanOrEqual(2);
      const starts = blocks.map(b => b.start);
      expect(starts).toContain('08:00');
      expect(starts).toContain('09:50');
    });

    it('includes durationMins in each block', async () => {
      const monday = new Date('2026-03-23T08:00:00');

      const blocks = await schedule.getFreeBlocksToday(1, monday);

      blocks.forEach(b => {
        expect(b).toHaveProperty('durationMins');
        expect(b.durationMins).toBeGreaterThanOrEqual(45);
      });
    });

    it('ignores gaps shorter than 45 minutes', async () => {
      // Schedule with only a 30-min gap
      db.getUserById.mockResolvedValue({
        id: 1,
        class_schedule: [
          { name: 'Class A', days: ['M'], startTime: '09:00', endTime: '10:00', location: null, professor: null },
          { name: 'Class B', days: ['M'], startTime: '10:30', endTime: '12:00', location: null, professor: null },
        ],
      });
      const monday = new Date('2026-03-23T08:00:00');

      const blocks = await schedule.getFreeBlocksToday(1, monday);

      // The 10:00-10:30 gap (30 min) should not appear
      const shortBlock = blocks.find(b => b.start === '10:00');
      expect(shortBlock).toBeUndefined();
    });

    it('returns full day when no classes on that day', async () => {
      // Saturday — no classes
      const saturday = new Date('2026-03-28T08:00:00');

      const blocks = await schedule.getFreeBlocksToday(1, saturday);

      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ start: '08:00', end: '22:00', durationMins: 840 });
    });

    it('returns full day when schedule is empty', async () => {
      db.getUserById.mockResolvedValue({ id: 1, class_schedule: [] });
      const monday = new Date('2026-03-23T08:00:00');

      const blocks = await schedule.getFreeBlocksToday(1, monday);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].durationMins).toBe(840); // 08:00-22:00 = 840 mins
    });
  });
});
