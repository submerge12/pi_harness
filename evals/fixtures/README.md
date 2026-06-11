# Eval Fixtures

Phase 17 tasks can define fixtures inline with a `files` map or reference a fixture workspace with `path`.

The offline runner materializes each fixture into a temporary workspace for the executor. It does not call a provider, use the network, or delete generated temp directories; OS temp cleanup owns those directories.
