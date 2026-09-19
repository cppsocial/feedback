UPDATE discussions
SET
    thumbsup = MAX(0, thumbsup + ?),
    thumbsdown = MAX(0, thumbsdown + ?)
WHERE resource_id = ? AND id = ?
RETURNING thumbsup, thumbsdown
