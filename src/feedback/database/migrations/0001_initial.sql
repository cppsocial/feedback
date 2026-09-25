BEGIN IMMEDIATE;

CREATE TABLE discussions (
    resource_id TEXT PRIMARY KEY, category_key TEXT NOT NULL, lookup_term TEXT NOT NULL,
    id TEXT NOT NULL UNIQUE, number INTEGER NOT NULL CHECK (number > 0),
    title TEXT NOT NULL, url TEXT NOT NULL,
    locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
    thumbsup INTEGER NOT NULL DEFAULT 0 CHECK (thumbsup >= 0),
    thumbsdown INTEGER NOT NULL DEFAULT 0 CHECK (thumbsdown >= 0),
    updated_at INTEGER, fetched_at INTEGER NOT NULL,
    UNIQUE (category_key, lookup_term)
) STRICT, WITHOUT ROWID;

CREATE TABLE reactions (
    object_id TEXT NOT NULL,
    reaction TEXT NOT NULL, count INTEGER NOT NULL CHECK (count >= 0),
    updated_at INTEGER NOT NULL, PRIMARY KEY (object_id, reaction),
    FOREIGN KEY (object_id) REFERENCES discussions (id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX reactions_by_discussion ON reactions (object_id, reaction);
CREATE INDEX discussions_by_lookup ON discussions (category_key, lookup_term);

PRAGMA user_version = 6;
COMMIT;
