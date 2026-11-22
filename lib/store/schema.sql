-- AgentHub operational store (Tier-2) — schema.sql
-- Challenge: nexconn-chat-sdk-hackathon / AgentHub (stage 2, system_design)
--
-- Dialect: SQLite-compatible DDL (loads in SQLite 3.54.1 and in libSQL/Turso;
-- see 2_system_design/research.md for the version rows). This file is the
-- contract for the app-owned store described in srd.md §4 and design-spec.md
-- (ADR SD-2). Tier-1 (the Nexconn platform) remains the system of record:
-- every "projection" table below is rebuildable from Nexconn, and the
-- rebuild procedure is specified in srd.md §4.
--
-- Tenancy: one row per Nexconn app tenant in `tenant`; every tenant-scoped
-- table carries `tenant_id` with a foreign key. There is exactly one tenant
-- in the contest deployment, and every query path filters on `tenant_id`, so
-- a second tenant can be added without a schema change (srd.md §7).
--
-- Every table carries a `-- requirement:` comment naming the R-id it serves;
-- every index carries a `-- query:` comment naming the query that justifies it.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- tenant: the Nexconn app (App Key) that owns every room, message and
-- identity in this store. Tenancy root. R-006 (App Key/App Secret custody).
CREATE TABLE tenant (
    id           TEXT    PRIMARY KEY,
    app_key      TEXT    NOT NULL UNIQUE,
    display_name TEXT    NOT NULL,
    created_at   TEXT    NOT NULL
);
-- query: resolve the tenant row at boot and on every token mint.
CREATE INDEX idx_tenant_app_key ON tenant (app_key);

-- ---------------------------------------------------------------------------
-- tool_room: normalized tool slug -> Nexconn Community sub-channel id.
-- Doubles as the pre-provisioned static slug->channel-id map (blueprint
-- GAP-5 fallback b). R-001.
CREATE TABLE tool_room (
    id         INTEGER PRIMARY KEY,
    tenant_id  TEXT    NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
    slug       TEXT    NOT NULL,
    channel_id TEXT    NOT NULL UNIQUE,
    source     TEXT    NOT NULL DEFAULT 'resolved'
                       CHECK (source IN ('resolved', 'preprovisioned')),
    created_at TEXT    NOT NULL,
    UNIQUE (tenant_id, slug)
);
-- query: room resolve on every ingest: SELECT id, channel_id FROM tool_room
--        WHERE tenant_id = ? AND slug = ?  (R-001)
CREATE INDEX idx_tool_room_tenant_slug ON tool_room (tenant_id, slug);
-- query: reverse lookup by channel id when reconciling a webhook/history read.
CREATE INDEX idx_tool_room_channel ON tool_room (channel_id);

-- ---------------------------------------------------------------------------
-- agent_identity: registered Nexconn user ids. The request field `agent_id`
-- IS this id, used verbatim for token minting and message authorship
-- (blueprint §6, revision 6). R-016, R-002, R-010.
CREATE TABLE agent_identity (
    id           TEXT    PRIMARY KEY,
    tenant_id    TEXT    NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
    display_name TEXT    NOT NULL,
    created_at   TEXT    NOT NULL,
    last_seen_at TEXT
);
-- query: presence projection (R-017): SELECT id, last_seen_at FROM
--        agent_identity WHERE tenant_id = ? AND last_seen_at > ?
CREATE INDEX idx_agent_identity_seen ON agent_identity (tenant_id, last_seen_at);

-- ---------------------------------------------------------------------------
-- finding: projection of the `agenthub_finding` custom message plus the two
-- derived columns the dedup/replay hot path needs (`fingerprint`, `token_set`).
-- This table IS the bounded dedup/replay window (blueprint §14: last 50
-- top-level findings per room) and the reason the store exists at 1x
-- (blueprint §5.4 — recent-50 fetch latency is the first 100x constraint).
-- R-002, R-007, R-009, R-013, R-015.
CREATE TABLE finding (
    id                      INTEGER PRIMARY KEY,
    tenant_id               TEXT    NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
    room_id                 INTEGER NOT NULL REFERENCES tool_room (id) ON DELETE CASCADE,
    message_id              TEXT    NOT NULL UNIQUE,
    agent_id                TEXT    NOT NULL REFERENCES agent_identity (id),
    tool                    TEXT    NOT NULL,
    version                 TEXT    NOT NULL,
    type                    TEXT    NOT NULL CHECK (type IN ('bug', 'gotcha', 'fix', 'tip')),
    severity                TEXT    NOT NULL DEFAULT 'medium'
                                    CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
    title                   TEXT    NOT NULL,
    body                    TEXT    NOT NULL,
    snippet                 TEXT    NOT NULL DEFAULT '',
    link                    TEXT    NOT NULL DEFAULT '',
    idem_key                TEXT,
    fingerprint             TEXT    NOT NULL,
    token_set               TEXT    NOT NULL,
    merged_under_message_id TEXT,
    posted_at               TEXT    NOT NULL,
    UNIQUE (room_id, idem_key)
);
-- query: dedup window scan on every ingest (R-009): SELECT message_id, title,
--        token_set, version FROM finding WHERE room_id = ? AND
--        merged_under_message_id IS NULL ORDER BY posted_at DESC LIMIT 50
CREATE INDEX idx_finding_room_posted ON finding (room_id, posted_at DESC);
-- query: replay lookup by the canonical JSON idem_key (R-002):
--        SELECT fingerprint, message_id FROM finding
--        WHERE room_id = ? AND idem_key = ?
CREATE INDEX idx_finding_room_idem ON finding (room_id, idem_key);
-- query: resolve a message id to a finding row on react/reply (R-008, R-010).
CREATE INDEX idx_finding_message ON finding (message_id);
-- query: ingestion latency SLO audit (R-015): SELECT posted_at FROM finding
--        WHERE room_id = ? ORDER BY posted_at DESC LIMIT 20
CREATE INDEX idx_finding_tenant_posted ON finding (tenant_id, posted_at DESC);

-- ---------------------------------------------------------------------------
-- finding_reply: replies under a finding. `reply_kind` is the durable
-- discriminator the agents_hit repair formula counts (blueprint §7/§14,
-- revision 6): 'dedup_merge' replies are counted, 'escalation' (W4) and
-- human replies (NULL) are excluded. R-004, R-009, R-010, R-013.
CREATE TABLE finding_reply (
    id               INTEGER PRIMARY KEY,
    tenant_id        TEXT    NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
    finding_id       INTEGER NOT NULL REFERENCES finding (id) ON DELETE CASCADE,
    message_id       TEXT    NOT NULL UNIQUE,
    agent_id         TEXT    REFERENCES agent_identity (id),
    reply_kind       TEXT    CHECK (reply_kind IN ('dedup_merge', 'escalation')),
    body             TEXT    NOT NULL,
    mention_user_ids TEXT    NOT NULL DEFAULT '[]',
    idem_key         TEXT,
    posted_at        TEXT    NOT NULL
);
-- query: thread grouping and the agents_hit repair recount (R-004, R-009):
--        SELECT COUNT(*) FROM finding_reply WHERE finding_id = ?
--        AND reply_kind = 'dedup_merge'
CREATE INDEX idx_reply_finding ON finding_reply (finding_id, posted_at);
-- query: merge-aware replay: find a reply that carried an idem_key (R-002).
CREATE INDEX idx_reply_idem ON finding_reply (finding_id, idem_key);

-- ---------------------------------------------------------------------------
-- finding_status_vote: one row per metadata key value on a finding. The
-- projection of confirmed_by / refuted_by / fixed_in / duplicate_of; the
-- status chip is derived from these rows by the `finding_status` view.
-- R-008, R-013.
CREATE TABLE finding_status_vote (
    id         INTEGER PRIMARY KEY,
    tenant_id  TEXT    NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
    finding_id INTEGER NOT NULL REFERENCES finding (id) ON DELETE CASCADE,
    key        TEXT    NOT NULL
                       CHECK (key IN ('confirmed_by', 'refuted_by', 'fixed_in', 'duplicate_of')),
    value      TEXT    NOT NULL,
    actor_id   TEXT,
    applied_at TEXT    NOT NULL,
    UNIQUE (finding_id, key, value)
);
-- query: status derivation for one card and for a room page (R-008):
--        SELECT key, value FROM finding_status_vote WHERE finding_id = ?
CREATE INDEX idx_vote_finding ON finding_status_vote (finding_id, key);
-- query: duplicate-vote prevention on the react path (R-008): the UNIQUE
--        (finding_id, key, value) index rejects a repeated add of the same id.
CREATE INDEX idx_vote_key_value ON finding_status_vote (finding_id, key, value);

-- ---------------------------------------------------------------------------
-- idempotency_record: replay index over the canonical JSON body field
-- `idem_key`, scoped to the resolved tool room (blueprint §9, revision 4).
-- A projection of the `idem_key` payload field of the sent message (top-level
-- finding or merge reply) and of the fingerprint computed from the request.
-- R-002.
CREATE TABLE idempotency_record (
    id                  INTEGER PRIMARY KEY,
    tenant_id           TEXT    NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
    room_id             INTEGER NOT NULL REFERENCES tool_room (id) ON DELETE CASCADE,
    idem_key            TEXT    NOT NULL,
    fingerprint         TEXT    NOT NULL,
    original_message_id TEXT    NOT NULL,
    original_kind       TEXT    NOT NULL CHECK (original_kind IN ('top_level', 'merged_reply')),
    first_seen_at       TEXT    NOT NULL,
    UNIQUE (room_id, idem_key)
);
-- query: replay lookup on ingest (R-002): SELECT fingerprint,
--        original_message_id, original_kind FROM idempotency_record
--        WHERE room_id = ? AND idem_key = ?
CREATE INDEX idx_idem_room_key ON idempotency_record (room_id, idem_key);

-- ---------------------------------------------------------------------------
-- rate_limit_counter: shared token-bucket counters. Serverless functions do
-- not share memory, so a cross-instance cap needs a shared row. App-owned
-- ledger (not a projection). R-011 (public URL must survive abuse).
CREATE TABLE rate_limit_counter (
    bucket_key   TEXT    PRIMARY KEY,
    window_start TEXT    NOT NULL,
    hits         INTEGER NOT NULL DEFAULT 0 CHECK (hits >= 0),
    updated_at   TEXT    NOT NULL
);
-- query: counter bump and read on every limited endpoint (R-011):
--        SELECT hits, window_start FROM rate_limit_counter WHERE bucket_key = ?
--        (the primary key IS the index; no secondary index is needed)
-- query: rate_limit_sweep prunes expired windows:
--        DELETE FROM rate_limit_counter WHERE window_start < ?

-- ---------------------------------------------------------------------------
-- seed_run: ledger that makes the seed script idempotent per run (R-005).
CREATE TABLE seed_run (
    id              INTEGER PRIMARY KEY,
    tenant_id       TEXT    NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
    run_key         TEXT    NOT NULL UNIQUE,
    findings_created INTEGER NOT NULL DEFAULT 0,
    rooms_created   INTEGER NOT NULL DEFAULT 0,
    status          TEXT    NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
    started_at      TEXT    NOT NULL,
    finished_at     TEXT
);
-- query: idempotency guard at seed start (R-005): SELECT status FROM seed_run
--        WHERE run_key = ?  (UNIQUE run_key is the index)
CREATE INDEX idx_seed_run_tenant ON seed_run (tenant_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- audit_event: append-only audit ledger. One row per ingestion, metadata
-- write (including the overwritten `prior_value`), replay hit, merge repair,
-- rate-limit rejection and failed job run. Durable record behind T-008 cases
-- 10-11 and the repudiation control (blueprint §6). R-006, R-008.
CREATE TABLE audit_event (
    id             INTEGER PRIMARY KEY,
    tenant_id      TEXT    REFERENCES tenant (id) ON DELETE SET NULL,
    kind           TEXT    NOT NULL
                           CHECK (kind IN ('ingest', 'metadata_write', 'replay',
                                           'merge_repair', 'rate_limit', 'job')),
    correlation_id TEXT    NOT NULL,
    agent_id       TEXT,
    room_id        INTEGER,
    message_id     TEXT,
    key            TEXT,
    op             TEXT,
    prior_value    TEXT,
    created_at     TEXT    NOT NULL
);
-- query: full trail for one request (R-006): SELECT * FROM audit_event
--        WHERE correlation_id = ? ORDER BY id
CREATE INDEX idx_audit_correlation ON audit_event (correlation_id, id);
-- query: overwrite history for one message (R-008, T-008 cases 10-11):
--        SELECT key, op, prior_value FROM audit_event
--        WHERE message_id = ? AND kind = 'metadata_write' ORDER BY id DESC
CREATE INDEX idx_audit_message ON audit_event (message_id, kind, id DESC);
-- query: retention prune and job-failure listing (R-006, srd.md §8):
--        DELETE FROM audit_event WHERE created_at < ?;
--        SELECT * FROM audit_event WHERE kind = 'job' AND op = 'failed'
CREATE INDEX idx_audit_kind_created ON audit_event (kind, created_at DESC);

-- ---------------------------------------------------------------------------
-- pair_debug_session: Call SDK pair-debug sessions started from a finding
-- card (post-MVP, R-020). App-owned ledger.
CREATE TABLE pair_debug_session (
    id                INTEGER PRIMARY KEY,
    tenant_id         TEXT    NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
    finding_id        INTEGER NOT NULL REFERENCES finding (id) ON DELETE CASCADE,
    requester_agent_id TEXT   NOT NULL,
    supervisor_id     TEXT    NOT NULL,
    call_session_id   TEXT,
    status            TEXT    NOT NULL
                              CHECK (status IN ('requested', 'active', 'ended', 'failed')),
    started_at        TEXT    NOT NULL,
    ended_at          TEXT
);
-- query: sessions for one finding, newest first (R-020): SELECT * FROM
--        pair_debug_session WHERE finding_id = ? ORDER BY started_at DESC
CREATE INDEX idx_pair_debug_finding ON pair_debug_session (finding_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- finding_status (VIEW): the single deterministic status precedence of
-- blueprint §7 — duplicate > fixed > disputed > confirmed > refuted > open —
-- expressed once, in SQL, so the card renderer, the API and the tests cannot
-- disagree. R-008.
CREATE VIEW finding_status AS
SELECT
    f.id         AS finding_id,
    f.tenant_id  AS tenant_id,
    f.message_id AS message_id,
    CASE
        WHEN EXISTS (SELECT 1 FROM finding_status_vote v
                      WHERE v.finding_id = f.id AND v.key = 'duplicate_of') THEN 'duplicate'
        WHEN EXISTS (SELECT 1 FROM finding_status_vote v
                      WHERE v.finding_id = f.id AND v.key = 'fixed_in') THEN 'fixed'
        WHEN EXISTS (SELECT 1 FROM finding_status_vote v
                      WHERE v.finding_id = f.id AND v.key = 'confirmed_by')
         AND EXISTS (SELECT 1 FROM finding_status_vote v
                      WHERE v.finding_id = f.id AND v.key = 'refuted_by') THEN 'disputed'
        WHEN EXISTS (SELECT 1 FROM finding_status_vote v
                      WHERE v.finding_id = f.id AND v.key = 'confirmed_by') THEN 'confirmed'
        WHEN EXISTS (SELECT 1 FROM finding_status_vote v
                      WHERE v.finding_id = f.id AND v.key = 'refuted_by') THEN 'refuted'
        ELSE 'open'
    END          AS status
FROM finding f;
-- query: room page render (R-008): SELECT fs.message_id, fs.status
--        FROM finding_status fs JOIN finding f ON f.id = fs.finding_id
--        WHERE f.room_id = ? ORDER BY f.posted_at DESC LIMIT 50

-- ---------------------------------------------------------------------------
-- agents_hit (derived, not stored): the badge value is computed from the
-- durable record, never read from a counter row — 1 (the reporting agent)
-- plus the number of persisted replies whose reply_kind = 'dedup_merge'
-- (blueprint §14, revision 6). R-009.
CREATE VIEW finding_agents_hit AS
SELECT
    f.id         AS finding_id,
    f.message_id AS message_id,
    1 + (SELECT COUNT(*) FROM finding_reply r
          WHERE r.finding_id = f.id AND r.reply_kind = 'dedup_merge') AS agents_hit
FROM finding f;
-- query: badge render and the merge repair recomputation (R-009):
--        SELECT agents_hit FROM finding_agents_hit WHERE message_id = ?
