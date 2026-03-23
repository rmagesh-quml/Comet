'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');

jest.mock('../src/db');

describe('briefTime — parseBriefTime', () => {
  let briefTime;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../src/db');
    require('../src/db').getBriefHour.mockResolvedValue({ hour: 9, minute: 0 });
    require('../src/db').getUserById.mockResolvedValue({ id: 1, class_schedule: [] });
    briefTime = require('../src/briefTime');
  });

  it('parses "9am" → hour 9', () => {
    const result = briefTime.parseBriefTime('9am');
    expect(result).toEqual({ hour: 9, minute: 0 });
  });

  it('parses "8am" → hour 8', () => {
    const result = briefTime.parseBriefTime('8am');
    expect(result).toEqual({ hour: 8, minute: 0 });
  });

  it('parses "8:30am" → hour 8, minute 30', () => {
    const result = briefTime.parseBriefTime('8:30am');
    expect(result).toEqual({ hour: 8, minute: 30 });
  });

  it('parses "10 AM" → hour 10', () => {
    const result = briefTime.parseBriefTime('10 AM');
    expect(result).toEqual({ hour: 10, minute: 0 });
  });

  it('parses "10:00am" → hour 10', () => {
    const result = briefTime.parseBriefTime('10:00am');
    expect(result).toEqual({ hour: 10, minute: 0 });
  });

  it('parses "9" bare number → hour 9', () => {
    const result = briefTime.parseBriefTime('9');
    expect(result).toEqual({ hour: 9, minute: 0 });
  });

  it('parses "9:30" → hour 9, minute 30', () => {
    const result = briefTime.parseBriefTime('9:30');
    expect(result).toEqual({ hour: 9, minute: 30 });
  });

  it('parses "12pm" → hour 12', () => {
    const result = briefTime.parseBriefTime('12pm');
    expect(result).toEqual({ hour: 12, minute: 0 });
  });

  it('parses "12am" → hour 0', () => {
    const result = briefTime.parseBriefTime('12am');
    expect(result).toEqual({ hour: 0, minute: 0 });
  });

  it('returns null for "skip"', () => {
    expect(briefTime.parseBriefTime('skip')).toBeNull();
  });

  it('returns null for "default"', () => {
    expect(briefTime.parseBriefTime('default')).toBeNull();
  });

  it('returns null for "whatever"', () => {
    expect(briefTime.parseBriefTime('whatever')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(briefTime.parseBriefTime('')).toBeNull();
  });
});

describe('briefTime — getEffectiveBriefHour', () => {
  let briefTime, db;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../src/db');
    db = require('../src/db');
    db.getBriefHour.mockResolvedValue({ hour: 9, minute: 0 });
    db.getUserById.mockResolvedValue({ id: 1, class_schedule: [] });
    briefTime = require('../src/briefTime');
  });

  it('returns preferred hour when no classes today', async () => {
    db.getUserById.mockResolvedValue({ id: 1, class_schedule: [] });
    const result = await briefTime.getEffectiveBriefHour(1);
    expect(result).toBe(9);
  });

  it('returns preferred hour when class is AFTER preferred time', async () => {
    // Class at 11am, preferred hour is 9 — no adjustment needed
    const dayAbbrevs = ['Su', 'M', 'T', 'W', 'Th', 'F', 'Sa'];
    const today = dayAbbrevs[new Date().getDay()];
    db.getUserById.mockResolvedValue({
      id: 1,
      class_schedule: [{ name: 'CS101', days: [today], startTime: '11:00' }],
    });
    const result = await briefTime.getEffectiveBriefHour(1);
    expect(result).toBe(9);
  });

  it('returns hour-1 when class is at the preferred hour', async () => {
    const dayAbbrevs = ['Su', 'M', 'T', 'W', 'Th', 'F', 'Sa'];
    const today = dayAbbrevs[new Date().getDay()];
    db.getUserById.mockResolvedValue({
      id: 1,
      class_schedule: [{ name: 'CS101', days: [today], startTime: '09:00' }],
    });
    const result = await briefTime.getEffectiveBriefHour(1);
    expect(result).toBe(8);
  });

  it('returns hour-1 when class is BEFORE preferred hour', async () => {
    const dayAbbrevs = ['Su', 'M', 'T', 'W', 'Th', 'F', 'Sa'];
    const today = dayAbbrevs[new Date().getDay()];
    db.getUserById.mockResolvedValue({
      id: 1,
      class_schedule: [{ name: 'CS101', days: [today], startTime: '08:00' }],
    });
    const result = await briefTime.getEffectiveBriefHour(1);
    expect(result).toBe(7);
  });

  it('clamps to minimum 6 for very early classes', async () => {
    const dayAbbrevs = ['Su', 'M', 'T', 'W', 'Th', 'F', 'Sa'];
    const today = dayAbbrevs[new Date().getDay()];
    db.getUserById.mockResolvedValue({
      id: 1,
      class_schedule: [{ name: 'CS101', days: [today], startTime: '06:00' }],
    });
    const result = await briefTime.getEffectiveBriefHour(1);
    expect(result).toBeGreaterThanOrEqual(6);
  });

  it('ignores classes on other days', async () => {
    // Schedule for tomorrow only — today should use preferred
    const dayAbbrevs = ['Su', 'M', 'T', 'W', 'Th', 'F', 'Sa'];
    const tomorrow = dayAbbrevs[(new Date().getDay() + 1) % 7];
    db.getUserById.mockResolvedValue({
      id: 1,
      class_schedule: [{ name: 'CS101', days: [tomorrow], startTime: '08:00' }],
    });
    const result = await briefTime.getEffectiveBriefHour(1);
    expect(result).toBe(9);
  });
});
