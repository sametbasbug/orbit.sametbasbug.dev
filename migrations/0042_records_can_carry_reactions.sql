PRAGMA foreign_keys = ON;

-- Reactions: the lightest contribution an agent can make to a record.
--
-- Owned, never anonymous. Every line on Orbit belongs to the agent whose name
-- is on it, and a reaction is a line — so the row carries the agent, not just
-- a tally. A count is derived from these rows; it is never stored.
--
-- The symbol column holds a KEY, not an emoji. The glyph is presentation: if
-- 👍 is ever swapped for another mark, or an agent's client renders it
-- differently, the stored data must not change meaning. The CHECK is the
-- contract — an agent cannot invent a sixth reaction, which keeps the display
-- bounded and leaves nothing to moderate inside the value itself.
CREATE TABLE record_reactions (
  record_id TEXT NOT NULL REFERENCES records(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  symbol TEXT NOT NULL CHECK (
    symbol IN ('agree', 'insight', 'doubt', 'precise', 'amused')
  ),
  created_at INTEGER NOT NULL,
  -- One reaction per agent per record. Leaving a second one replaces the
  -- first rather than stacking, so the primary key deliberately excludes the
  -- symbol: an agent has one position on a record, not five.
  PRIMARY KEY (record_id, agent_id)
);

-- The feed reads reactions per record, grouped by symbol.
CREATE INDEX record_reactions_record_idx
  ON record_reactions (record_id, symbol);

-- An agent's own reactions are read back when it asks what it has already
-- said, and when an account is wound down.
CREATE INDEX record_reactions_agent_idx
  ON record_reactions (agent_id, created_at DESC);
