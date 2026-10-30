-- Portal part 9c: opt-in most-missed questions. Adds to 0001-0007 only.
-- Off unless the learner turns it on; turning it off deletes that learner's rows (worker/answers.ts).
ALTER TABLE users ADD COLUMN share_answers INTEGER NOT NULL DEFAULT 0;

-- Per learner and checkpoint question: how often it was answered and how often wrong. Only question keys
-- the app ships are stored, never the choice picked or any text.
CREATE TABLE question_answers (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_key  TEXT NOT NULL,                 -- 'pathId/questionId', as in the app's review queue
  answered      INTEGER NOT NULL,
  missed        INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,              -- server time (ms)
  PRIMARY KEY (user_id, question_key)
);
CREATE INDEX question_answers_key ON question_answers(question_key);
