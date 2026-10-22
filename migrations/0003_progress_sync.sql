-- Progress sync (docs/LOGIN_PLAN.md, Phase 3). The rules live in src/lib/syncRules.ts.

-- One row per earned item, so each carries the reset epoch of its scope when it was earned
CREATE TABLE progress_items (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                 -- 'objective' | 'lesson' | 'quiz'
  item_key      TEXT NOT NULL,                 -- 'moduleId/objectiveId' or 'pathId/stepId'
  scope         TEXT NOT NULL,                 -- reset scope, derived from the key: 'lab:<moduleId>' | 'path:<pathId>'
  epoch         INTEGER NOT NULL,              -- the scope's epoch when it was earned
  correct       INTEGER,                       -- quiz only: best score
  total         INTEGER,
  earned_at     INTEGER NOT NULL,              -- client time (ms), for display only
  PRIMARY KEY (user_id, kind, item_key)
);
CREATE INDEX progress_items_scope ON progress_items(user_id, scope);

-- Persistent reset markers: one counter per scope, raised by each reset and never removed
CREATE TABLE progress_epochs (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL,
  epoch         INTEGER NOT NULL,
  PRIMARY KEY (user_id, scope)
);

-- The learner's app settings as one JSON object: { field: { value, updatedAt } } for prefs, theme,
-- badges, practice, goalWeeks and cleared. Per field the newest write wins. `version` makes the
-- read-merge-write safe against two uploads at once.
CREATE TABLE user_settings (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data          TEXT NOT NULL,
  version       INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL               -- server time (ms) of the last change
);
