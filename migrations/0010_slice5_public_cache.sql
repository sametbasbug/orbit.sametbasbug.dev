PRAGMA foreign_keys = ON;

CREATE TABLE public_cache_epochs (
  namespace TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at INTEGER NOT NULL
);

INSERT INTO public_cache_epochs (namespace, version, updated_at)
VALUES ('public_read', 1, 0);

