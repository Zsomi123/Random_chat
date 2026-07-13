// admin.js — Admin moderációs felület router
// Session-alapú bejelentkezés + REST API az admin.html dashboardhoz

const express = require('express');
const dbMod = require('./db');

function createAdminRouter({ banSocketsCallback } = {}) {
    const router = express.Router();

    // ─── AUTH MIDDLEWARE ───────────────────────
    function requireAuth(req, res, next) {
        if (req.session && req.session.admin) return next();
        return res.status(401).json({ error: 'Nincs bejelentkezve.' });
    }

    // ─── BEJELENTKEZÉS / KIJELENTKEZÉS ─────────
    router.post('/api/login', (req, res) => {
        const { username, password } = req.body || {};
        if (!username || !password) {
            return res.status(400).json({ error: 'Hiányzó felhasználónév vagy jelszó.' });
        }
        const admin = dbMod.verifyAdmin(username, password);
        if (!admin) {
            return res.status(401).json({ error: 'Hibás felhasználónév vagy jelszó.' });
        }

        // Session ID regenerálása bejelentkezéskor — így egy támadó által bejelentkezés
        // ELŐTT megszerzett/befecskendezett session ID nem válik hitelesített sessionné
        // (session fixation elleni védelem).
        req.session.regenerate((err) => {
            if (err) {
                console.error('Session regenerálási hiba:', err);
                return res.status(500).json({ error: 'Belső hiba történt.' });
            }
            req.session.admin = admin;
            req.session.save((saveErr) => {
                if (saveErr) {
                    console.error('Session mentési hiba:', saveErr);
                    return res.status(500).json({ error: 'Belső hiba történt.' });
                }
                res.json({ ok: true, admin });
            });
        });
    });

    router.post('/api/logout', (req, res) => {
        req.session.destroy(() => res.json({ ok: true }));
    });

    router.get('/api/me', (req, res) => {
        if (req.session && req.session.admin) return res.json({ admin: req.session.admin });
        res.status(401).json({ error: 'Nincs bejelentkezve.' });
    });

    // ─── JELENTÉSEK ─────────────────────────────
    router.get('/api/reports', requireAuth, (req, res) => {
        const { status, limit, offset } = req.query;
        const reports = dbMod.listReports({
            status: status || undefined,
            limit: limit ? parseInt(limit, 10) : 50,
            offset: offset ? parseInt(offset, 10) : 0,
        });
        res.json({ reports });
    });

    router.get('/api/reports/:id', requireAuth, (req, res) => {
        const report = dbMod.getReportById(parseInt(req.params.id, 10));
        if (!report) return res.status(404).json({ error: 'Nem található a jelentés.' });
        res.json({ report });
    });

    router.post('/api/reports/:id/resolve', requireAuth, (req, res) => {
        const id = parseInt(req.params.id, 10);
        const { note } = req.body || {};
        dbMod.updateReportStatus(id, { status: 'resolved', resolvedBy: req.session.admin.username, note });
        res.json({ ok: true });
    });

    router.post('/api/reports/:id/dismiss', requireAuth, (req, res) => {
        const id = parseInt(req.params.id, 10);
        const { note } = req.body || {};
        const report = dbMod.getReportById(id);
        if (!report) return res.status(404).json({ error: 'Nem található a jelentés.' });

        dbMod.updateReportStatus(id, { status: 'dismissed', resolvedBy: req.session.admin.username, note });

        // ─── Eszkalálódó automatikus tiltás sorozatos alaptalan jelentés esetén ───
        // 1. alkalommal: 5 alaptalan jelentés után → 3 nap
        // Ha ez a tiltás lejár vagy fel lett oldva, és a jelentő újra alaptalanul
        // jelentget: 2. alkalommal már csak 3 alaptalan jelentés után → 1 hét
        // Ha ez is lejár/fel lett oldva és a jelentő visszatér: 3. alkalommal már
        // 1 alaptalan jelentés is végleges tiltáshoz vezet.
        let autoBanned = false;
        let autoBanInfo = null;
        const reporterUsername = report.reporter_username;
        const reporterIp = report.reporter_ip;
        if (reporterUsername || reporterIp) {
            const alreadyBanned = dbMod.isBanned({ ip: reporterIp, username: reporterUsername });
            if (!alreadyBanned) {
                const esc = dbMod.getReporterEscalationStatus(reporterUsername, reporterIp);
                if (esc.countInPeriod >= esc.threshold) {
                    const expiresAt = esc.nextDurationHours
                        ? new Date(Date.now() + esc.nextDurationHours * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
                        : null;
                    const banId = dbMod.createBan({
                        ip: reporterIp || null,
                        username: reporterUsername || null,
                        reason: esc.nextReason,
                        bannedBy: 'Rendszer (automatikus)',
                        expiresAt,
                        sourceReportId: id,
                        kind: 'reporter_auto',
                    });
                    autoBanned = true;
                    autoBanInfo = { banId, durationLabel: esc.nextDurationLabel, reason: esc.nextReason, strikeLevel: esc.strikeLevel };
                    if (typeof banSocketsCallback === 'function') {
                        banSocketsCallback({ ip: reporterIp, username: reporterUsername });
                    }
                }
            }
        }

        res.json({ ok: true, autoBanned, autoBanInfo });
    });

    // Jelentésből egyenesen tiltás — a jelentett felhasználó VAGY a jelentő ellen
    router.post('/api/reports/:id/ban', requireAuth, (req, res) => {
        const id = parseInt(req.params.id, 10);
        const report = dbMod.getReportById(id);
        if (!report) return res.status(404).json({ error: 'Nem található a jelentés.' });

        const { durationHours, reason, banIp, banUsername, target } = req.body || {};
        const banTarget = target === 'reporter' ? 'reporter' : 'reported';
        const targetIp = banTarget === 'reporter' ? report.reporter_ip : report.reported_ip;
        const targetUsername = banTarget === 'reporter' ? report.reporter_username : report.reported_username;
        const targetSocketId = banTarget === 'reporter' ? report.reporter_socket_id : report.reported_socket_id;

        if (!reason || !reason.trim()) {
            return res.status(400).json({ error: 'Az indoklás megadása kötelező.' });
        }

        const wantsIp = banIp !== false && !!targetIp;
        const wantsUsername = banUsername !== false && !!targetUsername;
        if (!wantsIp && !wantsUsername) {
            return res.status(400).json({ error: 'Nincs elérhető IP vagy felhasználónév ehhez a célhoz.' });
        }

        const hours = (durationHours !== null && durationHours !== undefined) ? parseInt(durationHours, 10) : null;
        const expiresAt = (hours && hours > 0)
            ? new Date(Date.now() + hours * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
            : null;

        const banId = dbMod.createBan({
            ip: wantsIp ? targetIp : null,
            username: wantsUsername ? targetUsername : null,
            reason: reason.trim(),
            bannedBy: req.session.admin.username,
            expiresAt,
            sourceReportId: id,
            kind: 'manual',
        });

        const durationLabel = expiresAt ? `${hours} órára` : 'véglegesen';
        if (banTarget === 'reported') {
            dbMod.updateReportStatus(id, {
                status: 'resolved',
                resolvedBy: req.session.admin.username,
                note: `Felhasználó kitiltva (${durationLabel}). Indok: ${reason.trim()}`,
            });
        }

        // Ha él az aktuális socket kapcsolat, azonnal bontjuk
        if (typeof banSocketsCallback === 'function') {
            banSocketsCallback({ ip: targetIp, username: targetUsername, socketId: targetSocketId });
        }

        res.json({ ok: true, banId, target: banTarget });
    });

    // ─── TILTÁSOK ───────────────────────────────
    router.get('/api/bans', requireAuth, (req, res) => {
        const activeOnly = req.query.active === '1';
        res.json({ bans: dbMod.listBans({ activeOnly }) });
    });

    router.post('/api/bans', requireAuth, (req, res) => {
        const { ip, username, reason, durationHours } = req.body || {};
        if (!ip && !username) {
            return res.status(400).json({ error: 'Legalább IP vagy felhasználónév szükséges.' });
        }
        if (!reason || !reason.trim()) {
            return res.status(400).json({ error: 'Az indoklás megadása kötelező.' });
        }
        const hours = (durationHours !== null && durationHours !== undefined) ? parseInt(durationHours, 10) : null;
        const expiresAt = (hours && hours > 0)
            ? new Date(Date.now() + hours * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
            : null;
        const banId = dbMod.createBan({
            ip: ip || null, username: username || null, reason: reason.trim(), bannedBy: req.session.admin.username, expiresAt,
        });

        if (typeof banSocketsCallback === 'function') {
            banSocketsCallback({ ip, username });
        }

        res.json({ ok: true, banId });
    });

    // Meglévő tiltás indoklásának / időtartamának szerkesztése
    router.post('/api/bans/:id/edit', requireAuth, (req, res) => {
        const id = parseInt(req.params.id, 10);
        const ban = dbMod.listBans().find(b => b.id === id);
        if (!ban) return res.status(404).json({ error: 'Nem található a tiltás.' });

        const { reason, durationHours, permanent } = req.body || {};
        if (!reason || !reason.trim()) {
            return res.status(400).json({ error: 'Az indoklás megadása kötelező.' });
        }

        let expiresAt = null;
        if (!permanent) {
            const hours = (durationHours !== null && durationHours !== undefined) ? parseInt(durationHours, 10) : null;
            if (!hours || hours <= 0) {
                return res.status(400).json({ error: 'Adj meg érvényes időtartamot, vagy jelöld véglegesnek.' });
            }
            expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
        }

        dbMod.updateBan(id, { reason: reason.trim(), expiresAt });
        res.json({ ok: true });
    });

    router.post('/api/bans/:id/lift', requireAuth, (req, res) => {
        const ban = dbMod.listBans().find(b => b.id === parseInt(req.params.id, 10));
        if (!ban) return res.status(404).json({ error: 'Nem található a tiltás.' });
        dbMod.liftBan(ban.id);
        res.json({ ok: true });
    });

    // ─── STATISZTIKÁK ───────────────────────────
    router.get('/api/stats', requireAuth, (req, res) => {
        res.json({
            reportCounts: dbMod.countReportsByStatus(),
            reportsPerDay: dbMod.reportsPerDay(14),
            topReported: dbMod.topReportedUsers(10),
            moderationEvents: dbMod.moderationEventStats(14),
        });
    });

    return router;
}

module.exports = { createAdminRouter };