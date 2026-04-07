'use strict';

const routes = {
  conversation:     'claude-sonnet-4-6',
  proactive:        'claude-haiku-4-5-20251001',
  brief_build:      'claude-haiku-4-5-20251001',
  classification:   'claude-haiku-4-5-20251001',
  research:         'gemini-2.0-flash-exp',
  browser_planning: 'gemini-2.0-flash-exp',
  coding_simple:    'gemini-2.0-flash-exp',
  coding_complex:   'claude-sonnet-4-6',
};

function getModel(taskType) {
  return routes[taskType] ?? 'claude-sonnet-4-6';
}

module.exports = { getModel };
