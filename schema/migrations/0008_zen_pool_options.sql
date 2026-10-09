-- Exact context continuations preserve caller response/tool controls through the queue.
ALTER TABLE zen_pool_tasks ADD COLUMN options TEXT;
