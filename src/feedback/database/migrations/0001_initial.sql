BEGIN IMMEDIATE;

CREATE TABLE discussions (
    resource_id TEXT PRIMARY KEY,
    lookup_term TEXT NOT NULL,
    github_node_id TEXT NOT NULL UNIQUE,
    github_number INTEGER NOT NULL UNIQUE CHECK (github_number > 0),
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
    up_count INTEGER NOT NULL DEFAULT 0 CHECK (up_count >= 0),
    down_count INTEGER NOT NULL DEFAULT 0 CHECK (down_count >= 0),
    github_updated_at INTEGER,
    fetched_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE reaction_counts (
    resource_id TEXT NOT NULL
        REFERENCES discussions (resource_id) ON DELETE CASCADE,
    reaction TEXT NOT NULL CHECK (
        reaction IN ('LAUGH', 'HOORAY', 'CONFUSED', 'HEART', 'ROCKET', 'EYES')
    ),
    count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
    PRIMARY KEY (resource_id, reaction)
) STRICT, WITHOUT ROWID;

PRAGMA user_version = 1;

COMMIT;
