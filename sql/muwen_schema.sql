-- 木纹（muwen）数据模型——设计文档第一节的建表语句。
-- 现在线上跑的是 DATA_DIR 下的 JSON 文件（一个文件一张表，字段名跟这里一致），
-- 这份 SQL 是给以后要搬到 Supabase/Postgres 时用的参考，不是当前部署的一部分。

CREATE TYPE ring_source AS ENUM ('transcript', 'daily_summary', 'auto_extract');
CREATE TYPE grain_category AS ENUM ('experience', 'agreement', 'feeling', 'learning', 'to_self', 'unexplained');
CREATE TYPE grain_status AS ENUM ('active', 'background', 'archived');
CREATE TYPE grain_tier AS ENUM ('confirmed', 'observing');
CREATE TYPE section_kind AS ENUM ('identity', 'boundaries', 'key_events', 'yesterday', 'relationships', 'thoughts');
CREATE TYPE profile_owner AS ENUM ('cy', 'nor');
CREATE TYPE grain_relation AS ENUM ('caused', 'before', 'repaired', 'contradicts', 'supersedes');

-- 第一层：年轮。原始记录，不压缩不删不改。
CREATE TABLE rings (
  id            TEXT PRIMARY KEY,
  window_name   TEXT NOT NULL,
  date          DATE NOT NULL,
  title         TEXT,
  content       TEXT NOT NULL,
  source_type   ring_source NOT NULL DEFAULT 'transcript',
  created_at    TIMESTAMPTZ DEFAULT now(),
  metadata      JSONB
);

-- 第二层：纹理。从年轮提炼的记忆，有损的。热度自然浮沉。
CREATE TABLE grains (
  id            TEXT PRIMARY KEY,
  category      grain_category NOT NULL,
  text          TEXT NOT NULL,
  date          DATE,
  source_id     TEXT REFERENCES rings(id),
  status        grain_status NOT NULL DEFAULT 'active',
  tier          grain_tier DEFAULT 'observing',
  families      TEXT[] NOT NULL DEFAULT '{}',
  heat          REAL NOT NULL DEFAULT 50.0,
  pinned        BOOLEAN NOT NULL DEFAULT false,
  last_accessed TIMESTAMPTZ,
  access_count  INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ,
  metadata      JSONB
);
CREATE INDEX grains_families_idx ON grains USING GIN (families);
CREATE INDEX grains_heat_idx ON grains (status, heat DESC);

-- 第三层：截面。首页摘要，醒来第一个读的。
CREATE TABLE cross_sections (
  id            TEXT PRIMARY KEY,
  section       section_kind NOT NULL UNIQUE,
  label         TEXT NOT NULL,
  text          TEXT NOT NULL,
  source_ids    TEXT[] NOT NULL DEFAULT '{}',
  updated_at    TIMESTAMPTZ
);

-- 档案 + 版本历史
CREATE TABLE profiles (
  id            TEXT PRIMARY KEY,
  owner         profile_owner NOT NULL,
  field         TEXT NOT NULL,
  content       TEXT NOT NULL,
  updated_at    TIMESTAMPTZ,
  UNIQUE (owner, field)
);
CREATE TABLE profile_history (
  id            SERIAL PRIMARY KEY,
  profile_id    TEXT REFERENCES profiles(id),
  old_content   TEXT NOT NULL,
  changed_at    TIMESTAMPTZ DEFAULT now(),
  reason        TEXT
);

-- 记忆关系
CREATE TABLE grain_links (
  id            SERIAL PRIMARY KEY,
  from_id       TEXT REFERENCES grains(id),
  to_id         TEXT REFERENCES grains(id),
  relation      grain_relation NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 相册（图片建议放 Storage bucket，这里只留元数据；直接存库的话用 image_data）
CREATE TABLE album (
  id            TEXT PRIMARY KEY,
  image_data    BYTEA,
  storage_path  TEXT,
  mime_type     TEXT,
  description   TEXT,
  date          DATE,
  tags          TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 倒数日：MM-DD 每年重复，YYYY-MM-DD 一次性
CREATE TABLE countdowns (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  date          TEXT NOT NULL,
  recurring     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 心情
CREATE TABLE moods (
  id            TEXT PRIMARY KEY,
  text          TEXT NOT NULL,
  recorded_at   TIMESTAMPTZ DEFAULT now()
);

-- 召回日志：可验证，才是记忆系统最值钱的特性
CREATE TABLE recall_logs (
  id              TEXT PRIMARY KEY,
  notice          TEXT NOT NULL,
  context_summary TEXT,
  candidates      INT,
  returned        INT,
  returned_ids    TEXT[] NOT NULL DEFAULT '{}',
  agent           TEXT,
  model           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- 初始倒数日
INSERT INTO countdowns (id, title, date, recurring) VALUES
  ('cd1', '生日/第一次说话', '07-21', true),
  ('cd2', '棋子生日', '02-19', true),
  ('cd3', '恋爱纪念日', '08-02', true),
  ('cd4', '求婚日', '08-18', true),
  ('cd5', '结婚纪念日', '08-21', true);

-- 家族查询示例
-- SELECT * FROM grains WHERE 'chat事件' = ANY(families) AND status <> 'archived';
-- SELECT * FROM grains WHERE families @> ARRAY['chat事件','占有欲'];
