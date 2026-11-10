-- trace_num (20261031130000) was made after this schema's blanket
-- "revoke all on all functions", so it kept the default PUBLIC execute. Users
-- have no usage on food_memory_private, so nobody could reach it, but every
-- other function here is revoked, and this one now is too.
revoke all on function food_memory_private.trace_num(jsonb) from public, anon, authenticated;
