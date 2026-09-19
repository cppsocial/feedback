BEGIN IMMEDIATE;

CREATE TABLE discussions (
    resource_id TEXT PRIMARY KEY, lookup_term TEXT NOT NULL,
    id TEXT NOT NULL UNIQUE, number INTEGER NOT NULL CHECK (number > 0),
    title TEXT NOT NULL, url TEXT NOT NULL,
    locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
    thumbsup INTEGER NOT NULL DEFAULT 0 CHECK (thumbsup >= 0),
    thumbsdown INTEGER NOT NULL DEFAULT 0 CHECK (thumbsdown >= 0),
    upvotes INTEGER NOT NULL DEFAULT 0 CHECK (upvotes >= 0),
    updated_at INTEGER, fetched_at INTEGER NOT NULL,
    UNIQUE (lookup_term)
) STRICT, WITHOUT ROWID;

CREATE TABLE content (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT, WITHOUT ROWID;

CREATE TABLE comments (
    discussion_id TEXT NOT NULL, id TEXT NOT NULL,
    parent_id TEXT, content_id TEXT NOT NULL REFERENCES content (id) ON DELETE RESTRICT,
    url TEXT, author_id TEXT,
    hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)), minimized_reason TEXT,
    created_at INTEGER, edited_at INTEGER, updated_at INTEGER, fetched_at INTEGER NOT NULL,
    PRIMARY KEY (discussion_id, id),
    FOREIGN KEY (discussion_id) REFERENCES discussions (id) ON DELETE CASCADE,
    FOREIGN KEY (discussion_id, parent_id)
        REFERENCES comments (discussion_id, id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE reactions (
    discussion_id TEXT NOT NULL,
    reaction TEXT NOT NULL, account_id TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 0),
    updated_at INTEGER NOT NULL, PRIMARY KEY (discussion_id, reaction, account_id),
    FOREIGN KEY (discussion_id) REFERENCES discussions (id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE comment_reactions (
    discussion_id TEXT NOT NULL, comment_id TEXT NOT NULL,
    reaction TEXT NOT NULL, account_id TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 0),
    updated_at INTEGER NOT NULL, PRIMARY KEY (discussion_id, comment_id, reaction, account_id),
    FOREIGN KEY (discussion_id, comment_id)
        REFERENCES comments (discussion_id, id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE labels (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, description TEXT
) STRICT, WITHOUT ROWID;

CREATE TABLE discussion_labels (
    discussion_id TEXT NOT NULL,
    label_id TEXT NOT NULL REFERENCES labels (id) ON DELETE CASCADE,
    PRIMARY KEY (discussion_id, label_id),
    FOREIGN KEY (discussion_id) REFERENCES discussions (id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE polls (
    discussion_id TEXT NOT NULL,
    question TEXT NOT NULL,
    PRIMARY KEY (discussion_id),
    FOREIGN KEY (discussion_id) REFERENCES discussions (id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE poll_options (
    discussion_id TEXT NOT NULL, option_id TEXT NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (discussion_id, option_id),
    FOREIGN KEY (discussion_id) REFERENCES polls (discussion_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE poll_votes (
    discussion_id TEXT NOT NULL, option_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    PRIMARY KEY (discussion_id, option_id, account_id),
    FOREIGN KEY (discussion_id) REFERENCES discussions (id) ON DELETE CASCADE,
    FOREIGN KEY (discussion_id, option_id)
        REFERENCES poll_options (discussion_id, option_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE answers (
    discussion_id TEXT NOT NULL,
    comment_id TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
    PRIMARY KEY (discussion_id, comment_id),
    FOREIGN KEY (discussion_id, comment_id)
        REFERENCES comments (discussion_id, id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX comments_by_discussion ON comments (discussion_id, parent_id, created_at);
CREATE INDEX reactions_by_discussion ON reactions (discussion_id, reaction);
CREATE INDEX comment_reactions_by_comment ON comment_reactions (comment_id, reaction);
CREATE INDEX poll_votes_by_account ON poll_votes (account_id, discussion_id);
CREATE INDEX discussions_by_lookup ON discussions (lookup_term);
CREATE UNIQUE INDEX one_verified_answer_per_discussion
    ON answers (discussion_id) WHERE verified = 1;

CREATE TRIGGER delete_comment_content
AFTER DELETE ON comments
BEGIN
    DELETE FROM content WHERE id = OLD.content_id;
END;

PRAGMA user_version = 1;
COMMIT;
