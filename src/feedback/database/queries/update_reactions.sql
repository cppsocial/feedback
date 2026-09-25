UPDATE discussions
SET
    thumbsup = ?,
    thumbsdown = ?,
    locked = ?,
    updated_at = ?,
    fetched_at = ?
WHERE id = ?
