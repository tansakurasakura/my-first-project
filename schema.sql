-- 用户表
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('teacher','student')),
  created_at INTEGER NOT NULL
);

-- 会话 token 表
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  role TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_expires ON tokens(expires);

-- 课堂状态（单行表，id 恒为 1）
CREATE TABLE IF NOT EXISTS classroom_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  question TEXT NOT NULL DEFAULT '',
  teacher_answer TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO classroom_state (id, question, teacher_answer, updated_at)
  VALUES (1, '', '', 0);

-- 课堂答题墙
CREATE TABLE IF NOT EXISTS classroom_answers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  time TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_answers_created ON classroom_answers(created_at DESC);

-- 论坛帖子
CREATE TABLE IF NOT EXISTS forum_posts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reply_count INTEGER NOT NULL DEFAULT 0,
  last_reply_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_posts_recent ON forum_posts(last_reply_at DESC, created_at DESC);

-- 论坛回复
CREATE TABLE IF NOT EXISTS forum_replies (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  content TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(post_id) REFERENCES forum_posts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_replies_post ON forum_replies(post_id, created_at);
