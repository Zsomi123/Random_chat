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
// MIGRÁCIÓK — meglévő adatbázisokhoz utólag hozzáadott oszlopok
// ─────────────────────────────────────────────
function addColumnIfMissing(table, columnDef) {
    try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
    } catch (e) {
        // A oszlop feltehetően már létezik — biztonságos figyelmen kívül hagyni
        if (!/duplicate column name/i.test(e.message)) throw e;
    }
}
// lifted_at: mikor oldotta fel manuálisan az admin a tiltást (a lejárattól eltérően)
addColumnIfMissing('bans', `lifted_at TEXT`);
// kind: 'manual' (admin hozta létre) vagy 'reporter_auto' (a rendszer hozta létre
// alaptalan jelentések halmozódása miatt) — az eszkalációs logika ez alapján számol
addColumnIfMissing('bans', `kind TEXT NOT NULL DEFAULT 'manual'`);

// ─────────────────────────────────────────────
// ADMIN SEED — ha még nincs admin user, létrehozzuk env-ből vagy default-ból
// ─────────────────────────────────────────────
function ensureDefaultAdmin() {
    const count = db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
    if (count > 0) return;

    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || '123';

    // Éles környezetben KEMÉNYEN megtagadjuk az indulást, ha nincs beállítva
    // rendes ADMIN_USERNAME/ADMIN_PASSWORD, vagy ha a jelszó túl gyenge.
    // Enélkül egy production deploy simán elindulna admin/123 hitelesítő adatokkal,
    // ami triviálisan feltörhető admin hozzáférést jelentene.
    if (process.env.NODE_ENV === 'production') {
        if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
            console.error('KRITIKUS HIBA: Production módban kötelező beállítani az ADMIN_USERNAME és ADMIN_PASSWORD env változókat. Az alapértelmezett admin/123 fiók éles környezetben nem engedélyezett.');
            process.exit(1);
        }
        if (process.env.ADMIN_PASSWORD.length < 12) {
            console.error('KRITIKUS HIBA: Az ADMIN_PASSWORD túl rövid (minimum 12 karakter szükséges production módban).');
            process.exit(1);
        }
    }

    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, hash);
    console.log(`[admin] Létrehozva egy alap admin fiók: "${username}". KÉRLEK változtasd meg a jelszót / állítsd be az ADMIN_USERNAME és ADMIN_PASSWORD env változókat éles környezetben!`);
}
ensureDefaultAdmin();

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
    const reportedHistory = getReportedUserHistory(report.reported_username, report.reported_ip, id);
    const reporterStatus = getReporterEscalationStatus(report.reporter_username, report.reporter_ip);
    return { ...report, messages, reportedHistory, reporterStatus };
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

// Egy adott jelentett felhasználó/IP korábbi jelentési előzménye (a jelenlegi kivételével)
function getReportedUserHistory(username, ip, excludeId) {
    const conditions = [];
    const params = [excludeId];
    if (username) { conditions.push('reported_username = ?'); params.push(username); }
    if (ip) { conditions.push('reported_ip = ?'); params.push(ip); }
    if (!conditions.length) return [];
    const sql = `
        SELECT id, created_at, status, reason, resolution_note
        FROM reports
        WHERE id != ? AND (${conditions.join(' OR ')})
        ORDER BY created_at DESC
    `;
    return db.prepare(sql).all(...params);
}

// Hány alaptalannak (dismissed) minősített jelentést adott le eddig ez a jelentő.
// A sinceReportId paraméterrel csak a megadott jelentés-ID utáni (annál nagyobb ID-jű)
// jelentések számítanak — ez teszi lehetővé, hogy egy korábbi automatikus tiltás
// lejárta/feloldása után "nulláról" induljon újra a számlálás. Jelentés-ID alapú
// határt használunk (nem időbélyeget), mert az egyértelmű és sorrendhelyes, még akkor
// is, ha több művelet ugyanabban a másodpercben (vagy ezredmásodpercben) történik.
function countDismissedReportsByReporter(reporterUsername, reporterIp, sinceReportId) {
    const conditions = [];
    const params = [];
    if (reporterUsername) { conditions.push('reporter_username = ?'); params.push(reporterUsername); }
    if (reporterIp) { conditions.push('reporter_ip = ?'); params.push(reporterIp); }
    if (!conditions.length) return 0;
    let sql = `SELECT COUNT(*) AS c FROM reports WHERE status = 'dismissed' AND (${conditions.join(' OR ')})`;
    if (sinceReportId) { sql += ` AND id > ?`; params.push(sinceReportId); }
    return db.prepare(sql).get(...params).c;
}

// ─────────────────────────────────────────────
// JELENTŐ ESZKALÁCIÓS LOGIKA
// ─────────────────────────────────────────────
// Fokozatok: minél többször tiltottuk már ki ugyanezt a jelentőt alaptalan
// jelentések miatt, annál hamarabb (kevesebb alaptalan jelentés után) és
// annál hosszabb időre tiltjuk ki legközelebb.
//   0. fokozat (még sosem volt automatikus tiltása): 5 alaptalan jelentés → 3 nap
//   1. fokozat (1x már lejárt/feloldott auto-tiltása van): 3 alaptalan jelentés → 1 hét
//   2.+ fokozat (2x vagy több lejárt/feloldott auto-tiltása van): 1 alaptalan jelentés → végleges
const REPORTER_ESCALATION_TIERS = [
    { threshold: 5, hours: 72, label: '3 nap', reason: 'Túl sok alaptalan jelentés' },
    { threshold: 3, hours: 168, label: '1 hét', reason: 'Ismételt alaptalan jelentések (visszaeső jelentő)' },
    { threshold: 1, hours: null, label: 'végleges', reason: 'Ismétlődően alaptalan jelentések — végleges tiltás' },
];

function isBanEffectivelyEnded(ban) {
    if (!ban.active) return true;
    if (ban.expires_at && new Date(ban.expires_at + 'Z') <= new Date()) return true;
    return false;
}

// Az ez idáig a jelentő ellen (username vagy ip alapján) létrehozott automatikus
// (alaptalan jelentés miatti) tiltások, létrehozás szerint növekvő sorrendben.
function getReporterAutoBans(username, ip) {
    const conditions = [];
    const params = [];
    if (username) { conditions.push('username = ?'); params.push(username); }
    if (ip) { conditions.push('ip = ?'); params.push(ip); }
    if (!conditions.length) return [];
    const sql = `SELECT * FROM bans WHERE kind = 'reporter_auto' AND (${conditions.join(' OR ')}) ORDER BY id ASC`;
    return db.prepare(sql).all(...params);
}

// Kiszámolja, hogy egy adott jelentő jelenleg hol tart az eszkalációs rendszerben:
// hányszor volt már (lejárt/feloldott) automatikus tiltása, ebben a szakaszban hány
// alaptalan jelentést adott le eddig, és mennyi kell a következő automatikus tiltáshoz.
function getReporterEscalationStatus(username, ip) {
    const autoBans = getReporterAutoBans(username, ip);
    const ended = autoBans.filter(isBanEffectivelyEnded);
    const hasActiveAutoBan = autoBans.some(b => !isBanEffectivelyEnded(b));
    const strikeLevel = ended.length;

    const tier = REPORTER_ESCALATION_TIERS[Math.min(strikeLevel, REPORTER_ESCALATION_TIERS.length - 1)];

    // A legutóbbi lezárt automatikus tiltást kiváltó jelentés ID-ja a határ — az ezt
    // követő (nagyobb ID-jű) alaptalan jelentések számítanak az új szakaszba.
    const sinceReportId = ended.length ? (ended[ended.length - 1].source_report_id || 0) : 0;
    const countInPeriod = countDismissedReportsByReporter(username, ip, sinceReportId);

    return {
        strikeLevel,
        hasActiveAutoBan,
        threshold: tier.threshold,
        nextDurationHours: tier.hours,
        nextDurationLabel: tier.label,
        nextReason: tier.reason,
        countInPeriod,
    };
}

// ─────────────────────────────────────────────
// TILTÁSOK
// ─────────────────────────────────────────────
function createBan({ ip, username, reason, bannedBy, expiresAt, sourceReportId, kind }) {
    const result = db.prepare(`
        INSERT INTO bans (ip, username, reason, banned_by, expires_at, source_report_id, kind)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(ip || null, username || null, reason || null, bannedBy || null, expiresAt || null, sourceReportId || null, kind || 'manual');
    return result.lastInsertRowid;
}

function liftBan(id) {
    db.prepare(`UPDATE bans SET active = 0, lifted_at = datetime('now') WHERE id = ?`).run(id);
}

// Meglévő tiltás indoklásának és lejáratának szerkesztése.
// expiresAt: 'YYYY-MM-DD HH:MM:SS' string vagy null (= végleges).
function updateBan(id, { reason, expiresAt }) {
    db.prepare(`UPDATE bans SET reason = ?, expires_at = ? WHERE id = ?`).run(reason, expiresAt || null, id);
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
    updateBan,
    liftBan,
    listBans,
    isBanned,
    getReportedUserHistory,
    countDismissedReportsByReporter,
    getReporterEscalationStatus,
    deactivateExpiredBans,
    logModerationEvent,
    moderationEventStats,
};