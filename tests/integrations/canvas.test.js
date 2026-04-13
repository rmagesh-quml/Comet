'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');

jest.mock('../../src/db');
jest.mock('../../src/utils/cache');

describe('canvas integration', () => {
  let canvas;
  let db;
  let cache;
  let mockFetch;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('../../src/db');
    jest.mock('../../src/utils/cache');

    db = require('../../src/db');
    cache = require('../../src/utils/cache');

    // Default: cache miss
    cache.get.mockReturnValue(null);
    cache.set.mockReturnValue(undefined);

    // Default user has canvas configured
    db.getUserById.mockResolvedValue({
      id: 1,
      canvas_token: 'test_token',
      canvas_base_url: 'https://canvas.vt.edu',
    });

    mockFetch = jest.fn();
    global.fetch = mockFetch;

    canvas = require('../../src/integrations/canvas');
  });

  afterEach(() => {
    delete global.fetch;
  });

  // ─── getUpcomingAssignments ─────────────────────────────────────────────────

  describe('getUpcomingAssignments', () => {
    it('returns empty array when no canvas token in DB', async () => {
      db.getUserById.mockResolvedValue({ id: 1, canvas_token: null, canvas_base_url: null });

      const result = await canvas.getUpcomingAssignments(1);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('returns empty array when API returns error', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 401 });

      const result = await canvas.getUpcomingAssignments(1);

      expect(result).toEqual([]);
    });

    it('returns correctly shaped array on success', async () => {
      // planner/items response shape (used since calendar_events?type=assignment
      // only returns manually-added calendar events, not course assignments)
      const plannerResponse = [
        {
          plannable_type: 'assignment',
          course_id: 101,
          plannable: {
            title: 'Homework 1',
            due_at: '2024-03-15T23:59:00Z',
            points_possible: 100,
            html_url: 'https://canvas.vt.edu/courses/101/assignments/1',
          },
          submissions: { submitted: false },
        },
        {
          plannable_type: 'quiz',
          course_id: 102,
          plannable: {
            title: 'Quiz 2',
            due_at: '2024-03-17T12:00:00Z',
            points_possible: 50,
            html_url: 'https://canvas.vt.edu/courses/102/assignments/2',
          },
          submissions: { submitted: false },
        },
      ];
      // Route fetch calls by URL: courses endpoint vs planner/items endpoint
      mockFetch.mockImplementation((url) => {
        if (url.includes('/courses')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([
              { id: 101, name: 'Math 101' },
              { id: 102, name: 'CS 102' },
            ]),
            headers: { get: () => null },
          });
        }
        // planner/items
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(plannerResponse),
          headers: { get: () => null },
        });
      });

      const result = await canvas.getUpcomingAssignments(1, 7);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        title: 'Homework 1',
        dueDate: '2024-03-15T23:59:00Z',
        courseName: 'Math 101',
        pointsPossible: 100,
        htmlUrl: 'https://canvas.vt.edu/courses/101/assignments/1',
      });
      // sorted by dueDate
      expect(new Date(result[0].dueDate) <= new Date(result[1].dueDate)).toBe(true);
    });

    it('uses cache on second call', async () => {
      const cached = [{ title: 'Cached HW', dueDate: '2024-03-15T23:59:00Z' }];
      cache.get.mockReturnValue(cached);

      const result = await canvas.getUpcomingAssignments(1);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result).toEqual(cached);
    });
  });

  // ─── getMissingAssignments ──────────────────────────────────────────────────

  describe('getMissingAssignments', () => {
    it('returns empty array when no canvas token', async () => {
      db.getUserById.mockResolvedValue({ id: 1, canvas_token: null, canvas_base_url: null });

      const result = await canvas.getMissingAssignments(1);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('returns correctly shaped array on success', async () => {
      const apiResponse = [
        {
          name: 'Essay Draft',
          due_at: '2024-03-10T23:59:00Z',
          course_id: 101,
          points_possible: 80,
        },
      ];
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(apiResponse),
      });

      const result = await canvas.getMissingAssignments(1);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        title: 'Essay Draft',
        dueDate: '2024-03-10T23:59:00Z',
        courseName: '101',
        pointsPossible: 80,
      });
    });

    it('hits the correct missing_submissions endpoint', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });

      await canvas.getMissingAssignments(1);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/v1/users/self/missing_submissions');
    });
  });

  // ─── detectGradeChanges ─────────────────────────────────────────────────────

  describe('detectGradeChanges', () => {
    const currentGrades = [
      { courseName: 'CS 3114', currentScore: 88 },
      { courseName: 'MATH 2114', currentScore: 75 },
    ];

    it('returns empty array when no previous snapshot', async () => {
      db.getLatestGradeSnapshot.mockResolvedValue(null);
      db.saveGradeSnapshot.mockResolvedValue({});

      const changes = await canvas.detectGradeChanges(1, currentGrades);

      expect(changes).toEqual([]);
      expect(db.saveGradeSnapshot).toHaveBeenCalledWith(1, currentGrades);
    });

    it('detects grade going down', async () => {
      db.getLatestGradeSnapshot.mockResolvedValue({
        grades: [
          { courseName: 'CS 3114', currentScore: 92 },
          { courseName: 'MATH 2114', currentScore: 75 },
        ],
      });
      db.saveGradeSnapshot.mockResolvedValue({});

      const changes = await canvas.detectGradeChanges(1, currentGrades);

      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        courseName: 'CS 3114',
        oldScore: 92,
        newScore: 88,
        direction: 'down',
      });
    });

    it('detects grade going up', async () => {
      db.getLatestGradeSnapshot.mockResolvedValue({
        grades: [
          { courseName: 'CS 3114', currentScore: 85 },
          { courseName: 'MATH 2114', currentScore: 75 },
        ],
      });
      db.saveGradeSnapshot.mockResolvedValue({});

      const changes = await canvas.detectGradeChanges(1, currentGrades);

      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        courseName: 'CS 3114',
        oldScore: 85,
        newScore: 88,
        direction: 'up',
      });
    });

    it('returns empty array when nothing changed', async () => {
      db.getLatestGradeSnapshot.mockResolvedValue({ grades: currentGrades });
      db.saveGradeSnapshot.mockResolvedValue({});

      const changes = await canvas.detectGradeChanges(1, currentGrades);

      expect(changes).toEqual([]);
    });

    it('saves new snapshot after comparison', async () => {
      db.getLatestGradeSnapshot.mockResolvedValue({ grades: currentGrades });
      db.saveGradeSnapshot.mockResolvedValue({});

      await canvas.detectGradeChanges(1, currentGrades);

      expect(db.saveGradeSnapshot).toHaveBeenCalledWith(1, currentGrades);
    });
  });

  // ─── getWeeklySnapshot ──────────────────────────────────────────────────────

  describe('getWeeklySnapshot', () => {
    it('returns object with all four fields', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const result = await canvas.getWeeklySnapshot(1);

      expect(result).toHaveProperty('upcoming');
      expect(result).toHaveProperty('missing');
      expect(result).toHaveProperty('grades');
      expect(result).toHaveProperty('announcements');
      expect(Array.isArray(result.upcoming)).toBe(true);
      expect(Array.isArray(result.missing)).toBe(true);
      expect(Array.isArray(result.grades)).toBe(true);
      expect(Array.isArray(result.announcements)).toBe(true);
    });

    it('if one integration fails, others still return', async () => {
      // upcoming throws, missing and grades succeed, announcements needs courses first
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error('network error'); // upcoming fails
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });

      const result = await canvas.getWeeklySnapshot(1);

      // All four fields present even if one threw
      expect(result.upcoming).toEqual([]);
      expect(Array.isArray(result.missing)).toBe(true);
      expect(Array.isArray(result.grades)).toBe(true);
      expect(Array.isArray(result.announcements)).toBe(true);
    });
  });
});
