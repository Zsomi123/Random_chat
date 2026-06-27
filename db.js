// db.js — SQLite alapú moderációs adatréteg
// Tárolja: jelentéseket, üzenetlogokat (rövid kontextussal), tiltásokat, admin felhasználókat

const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'moderation.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─────────────────────────────────────────────
// SÉMA
// ─────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS reports (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    reporter_socket_id  TEXT,
    reporter_username   TEXT,
    reporter_ip         TEXT,
    reported_socket_id  TEXT,
    reported_username   TEXT,
    reported_ip         TEXT,
    room_name     TEXT,
    reason        TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',  -- pending | resolved | dismissed
    resolved_by   TEXT,
    resolved_at   TEXT,
    resolution_note TEXT
);

CREATE TABLE IF NOT EXISTS report_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id   INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    sender_name TEXT,
    sender_id   TEXT,
    text        TEXT,
    ts          INTEGER
);

CREATE TABLE IF NOT EXISTS bans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    ip          TEXT,
    username    TEXT,
    reason      TEXT,
    banned_by   TEXT,
    expires_at  TEXT,        -- NULL = végleges
    active      INTEGER NOT NULL DEFAULT 1,
    source_report_id INTEGER REFERENCES reports(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS admins (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS moderation_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    event_type  TEXT NOT NULL,   -- e.g. 'ai_flag', 'link_block', 'spam_block'
    username    TEXT,
    socket_id   TEXT,
    ip          TEXT,
    detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);
CREATE INDEX IF NOT EXISTS idx_bans_active ON bans(active);
CREATE INDEX IF NOT EXISTS idx_bans_ip ON bans(ip);
`);


// ─────────────────────────────────────────────
// ADMIN HELPEREK
// ─────────────────────────────────────────────
function verifyAdmin(username, password) {
    const row = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
    if (!row) return null;
    const ok = bcrypt.compareSync(password, row.password_hash);
    return ok ? { id: row.id, username: row.username } : null;
}

// ─────────────────────────────────────────────
// JELENTÉSEK
// ─────────────────────────────────────────────
function createReport({ reporterSocketId, reporterUsername, reporterIp, reportedSocketId, reportedUsername, reportedIp, roomName, reason, messages }) {
    const result = db.prepare(`
        INSERT INTO reports (reporter_socket_id, reporter_username, reporter_ip, reported_socket_id, reported_username, reported_ip, room_name, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(reporterSocketId, reporterUsername, reporterIp, reportedSocketId, reportedUsername, reportedIp, roomName, reason || null);

    const reportId = result.lastInsertRowid;

    if (messages && messages.length) {
        const insertMsg = db.prepare(`
            INSERT INTO report_messages (report_id, sender_name, sender_id, text, ts)
            VALUES (?, ?, ?, ?, ?)
        `);
        const tx = db.transaction((rows) => {
            for (const m of rows) insertMsg.run(reportId, m.senderName, m.senderId, m.text, m.ts);
        });
        tx(messages);
    }

    return reportId;
}

function listReports({ status, limit = 50, offset = 0 } = {}) {
    if (status) {
        return db.prepare(`SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(status, limit, offset);
    }
    return db.prepare(`SELECT * FROM reports ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
}

function getReportById(id) {
    const report = db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id);
    if (!report) return null;
    const messages = db.prepare(`SELECT * FROM report_messages WHERE report_id = ? ORDER BY ts ASC`).all(id);
    return { ...report, messages };
}

function updateReportStatus(id, { status, resolvedBy, note }) {
    db.prepare(`
        UPDATE reports
        SET status = ?, resolved_by = ?, resolved_at = datetime('now'), resolution_note = ?
        WHERE id = ?
    `).run(status, resolvedBy || null, note || null, id);
}

function countReportsByStatus() {
    const rows = db.prepare(`SELECT status, COUNT(*) AS c FROM reports GROUP BY status`).all();
    const out = { pending: 0, resolved: 0, dismissed: 0 };
    for (const r of rows) out[r.status] = r.c;
    return out;
}

function reportsPerDay(days = 14) {
    return db.prepare(`
        SELECT date(created_at) AS day, COUNT(*) AS c
        FROM reports
        WHERE created_at >= datetime('now', ?)
        GROUP BY day
        ORDER BY day ASC
    `).all(`-${days} days`);
}

function topReportedUsers(limit = 10) {
    return db.prepare(`
        SELECT reported_username AS username, reported_ip AS ip, COUNT(*) AS c
        FROM reports
        WHERE reported_username IS NOT NULL
        GROUP BY reported_username, reported_ip
        ORDER BY c DESC
        LIMIT ?
    `).all(limit);
}

// ─────────────────────────────────────────────
// TILTÁSOK
// ─────────────────────────────────────────────
function createBan({ ip, username, reason, bannedBy, expiresAt, sourceReportId }) {
    const result = db.prepare(`
        INSERT INTO bans (ip, username, reason, banned_by, expires_at, source_report_id)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(ip || null, username || null, reason || null, bannedBy || null, expiresAt || null, sourceReportId || null);
    return result.lastInsertRowid;
}

function liftBan(id) {
    db.prepare(`UPDATE bans SET active = 0 WHERE id = ?`).run(id);
}

function listBans({ activeOnly = false } = {}) {
    if (activeOnly) {
        return db.prepare(`
            SELECT * FROM bans
            WHERE active = 1 AND (expires_at IS NULL OR expires_at > datetime('now'))
            ORDER BY created_at DESC
        `).all();
    }
    return db.prepare(`SELECT * FROM bans ORDER BY created_at DESC`).all();
}

function isBanned({ ip, username }) {
    const row = db.prepare(`
        SELECT * FROM bans
        WHERE active = 1
          AND (expires_at IS NULL OR expires_at > datetime('now'))
          AND ((ip IS NOT NULL AND ip = ?) OR (username IS NOT NULL AND username = ?))
        LIMIT 1
    `).get(ip || '__none__', username || '__none__');
    return row || null;
}

// Lejárt tiltások automatikus deaktiválása (karbantartás)
function deactivateExpiredBans() {
    db.prepare(`
        UPDATE bans SET active = 0
        WHERE active = 1 AND expires_at IS NOT NULL AND expires_at <= datetime('now')
    `).run();
}

// ─────────────────────────────────────────────
// MODERÁCIÓS ESEMÉNYEK (AI flag, link blokk, spam blokk naplózása statisztikához)
// ─────────────────────────────────────────────
function logModerationEvent({ eventType, username, socketId, ip, detail }) {
    db.prepare(`
        INSERT INTO moderation_events (event_type, username, socket_id, ip, detail)
        VALUES (?, ?, ?, ?, ?)
    `).run(eventType, username || null, socketId || null, ip || null, detail ? JSON.stringify(detail) : null);
}

function moderationEventStats(days = 14) {
    return db.prepare(`
        SELECT event_type, COUNT(*) AS c
        FROM moderation_events
        WHERE created_at >= datetime('now', ?)
        GROUP BY event_type
    `).all(`-${days} days`);
}

module.exports = {
    db,
    verifyAdmin,
    createReport,
    listReports,
    getReportById,
    updateReportStatus,
    countReportsByStatus,
    reportsPerDay,
    topReportedUsers,
    createBan,
    liftBan,
    listBans,
    isBanned,
    deactivateExpiredBans,
    logModerationEvent,
    moderationEventStats,
};