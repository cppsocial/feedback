UPDATE discussions
SET
    thumbsup = ?,
    thumbsdown = ?,
    upvotes = ?,
    locked = ?,
    updated_at = ?,
    fetched_at = ?
WHERE id = ?
