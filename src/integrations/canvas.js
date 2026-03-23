'use strict';

const db = require('../db');
const cache = require('../utils/cache');

// ─── Client ───────────────────────────────────────────────────────────────────

async function getCanvasClient(userId) {
  const user = await db.getUserById(userId);
  if (!user || !user.canvas_token || !user.canvas_base_url) return null;
  return { token: user.canvas_token, baseUrl: user.canvas_base_url };
}

async function canvasFetch(userId, endpoint) {
  const client = await getCanvasClient(userId);
  if (!client) return null;

  try {
    const res = await fetch(`${client.baseUrl}${endpoint}`, {
      headers: { Authorization: `Bearer ${client.token}` },
    });
    if (!res.ok) {
      console.error(`Canvas API error ${res.status} for ${endpoint}`);
      return null;
    }
    return res.json();
  } catch (err) {
    console.error(`Canvas fetch failed for ${endpoint}:`, err.message || err);
    return null;
  }
}

// ─── Enrolled courses (shared dependency) ─────────────────────────────────────

async function getEnrolledCourses(userId) {
  const cacheKey = `canvas:courses:${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const data = await canvasFetch(
    userId,
    '/api/v1/courses?enrollment_type=student&enrollment_state=active&per_page=50'
  );
  const courses = Array.isArray(data) ? data : [];
  cache.set(cacheKey, courses, 60);
  return courses;
}

// ─── Upcoming assignments ─────────────────────────────────────────────────────

async function getUpcomingAssignments(userId, daysAhead = 7) {
  const cacheKey = `canvas:upcoming:${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const today = new Date();
  const end = new Date(today);
  end.setDate(end.getDate() + daysAhead);
  const startDate = today.toISOString().split('T')[0];
  const endDate = end.toISOString().split('T')[0];

  const data = await canvasFetch(
    userId,
    `/api/v1/calendar_events?type=assignment&start_date=${startDate}&end_date=${endDate}&per_page=50`
  );

  if (!data) {
    cache.set(cacheKey, [], 15);
    return [];
  }

  const results = data
    .filter(e => e.start_at)
    .map(e => ({
      title: e.title,
      dueDate: e.start_at,
      courseName: e.context_code || '',
      pointsPossible: e.assignment?.points_possible ?? null,
      htmlUrl: e.html_url,
    }))
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  cache.set(cacheKey, results, 15);
  return results;
}

// ─── Missing assignments ──────────────────────────────────────────────────────

async function getMissingAssignments(userId) {
  const cacheKey = `canvas:missing:${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const data = await canvasFetch(
    userId,
    '/api/v1/users/self/missing_submissions?include[]=planner_overrides&filter[]=submittable&per_page=20'
  );

  if (!data) {
    cache.set(cacheKey, [], 15);
    return [];
  }

  const results = data.map(a => ({
    title: a.name,
    dueDate: a.due_at,
    courseName: String(a.course_id || ''),
    pointsPossible: a.points_possible ?? null,
  }));

  cache.set(cacheKey, results, 15);
  return results;
}

// ─── Course grades ────────────────────────────────────────────────────────────

async function getCourseGrades(userId) {
  const cacheKey = `canvas:grades:${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const data = await canvasFetch(
    userId,
    '/api/v1/courses?enrollment_type=student&enrollment_state=active&include[]=total_scores&per_page=50'
  );

  if (!data) {
    cache.set(cacheKey, [], 15);
    return [];
  }

  const results = data
    .filter(c => c.enrollments && c.enrollments.length > 0)
    .map(c => {
      const e = c.enrollments[0];
      return {
        courseName: c.name,
        currentGrade: e.computed_current_grade || null,
        currentScore: e.computed_current_score ?? null,
      };
    });

  cache.set(cacheKey, results, 15);
  return results;
}

// ─── Announcements ────────────────────────────────────────────────────────────

async function getRecentAnnouncements(userId, daysBack = 1) {
  const cacheKey = `canvas:announcements:${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const since = new Date();
  since.setDate(since.getDate() - daysBack);
  const startDate = since.toISOString().split('T')[0];

  const courses = await getEnrolledCourses(userId);
  if (courses.length === 0) {
    cache.set(cacheKey, [], 15);
    return [];
  }

  const contextParams = courses.map(c => `context_codes[]=course_${c.id}`).join('&');
  const data = await canvasFetch(
    userId,
    `/api/v1/announcements?${contextParams}&start_date=${startDate}&per_page=10`
  );

  if (!data) {
    cache.set(cacheKey, [], 15);
    return [];
  }

  const results = data.map(a => ({
    title: a.title,
    message: (a.message || '').replace(/<[^>]*>/g, '').slice(0, 300),
    courseName: a.context_code || '',
    postedAt: a.posted_at,
    authorName: a.author?.display_name || null,
  }));

  cache.set(cacheKey, results, 15);
  return results;
}

// ─── Weekly snapshot ──────────────────────────────────────────────────────────

async function getWeeklySnapshot(userId) {
  const [upcomingResult, missingResult, gradesResult, announcementsResult] =
    await Promise.allSettled([
      getUpcomingAssignments(userId),
      getMissingAssignments(userId),
      getCourseGrades(userId),
      getRecentAnnouncements(userId),
    ]);

  return {
    upcoming: upcomingResult.status === 'fulfilled' ? upcomingResult.value : [],
    missing: missingResult.status === 'fulfilled' ? missingResult.value : [],
    grades: gradesResult.status === 'fulfilled' ? gradesResult.value : [],
    announcements: announcementsResult.status === 'fulfilled' ? announcementsResult.value : [],
  };
}

// ─── Grade change detection ───────────────────────────────────────────────────

async function detectGradeChanges(userId, currentGrades) {
  const snapshot = await db.getLatestGradeSnapshot(userId);

  if (!snapshot) {
    await db.saveGradeSnapshot(userId, currentGrades);
    return [];
  }

  const previous = snapshot.grades;
  const prevMap = new Map(
    (Array.isArray(previous) ? previous : []).map(g => [g.courseName, g.currentScore])
  );

  const changes = [];
  for (const grade of currentGrades) {
    const oldScore = prevMap.get(grade.courseName);
    if (oldScore == null || grade.currentScore == null) continue;
    if (grade.currentScore !== oldScore) {
      changes.push({
        courseName: grade.courseName,
        oldScore,
        newScore: grade.currentScore,
        direction: grade.currentScore > oldScore ? 'up' : 'down',
      });
    }
  }

  await db.saveGradeSnapshot(userId, currentGrades);
  return changes;
}

module.exports = {
  getCanvasClient,
  canvasFetch,
  getEnrolledCourses,
  getUpcomingAssignments,
  getMissingAssignments,
  getCourseGrades,
  getRecentAnnouncements,
  getWeeklySnapshot,
  detectGradeChanges,
};
