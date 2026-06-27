require('dotenv').config();
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const session = require('express-session');
const { Server } = require('socket.io');
const { OpenAI } = require('openai');

const dbMod = require('./db');
const { createAdminRouter } = require('./admin');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const openai = new OpenAI();

// ─────────────────────────────────────────────
// EXPRESS ALAPBEÁLLÍTÁSOK
// ─────────────────────────────────────────────
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'fejleszteshez-csak-ezt-allitsd-be-elesben',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        maxAge: 8 * 3600 * 1000, // 8 óra
        sameSite: 'lax',
    },
}));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.get('/admin', (req, res) => {
    res.sendFile(__dirname + '/admin.html');
});

// Az admin router callback-et kap, hogy aktív socketeket azonnal bonthasson tiltás esetén
app.use('/admin', createAdminRouter({ banSocketsCallback: disconnectBannedUser }));

let varolista = {};

// Online felhasználók számlálója
let onlineSzam = 0;

// Engedélyezett reakció emoji-k — szerver oldali whitelist (dupla védelem)
const ALLOWED_REACTIONS = new Set(['👍', '❤️', '😂', '😮']);

// Üzenetek rövid puffere szobánként, hogy jelentésnél tudjunk logolni mit látott a user
const ROOM_HISTORY_LIMIT = 30;
const roomHistory = new Map(); // szobaNev -> [{ id, senderId, senderName, text, ts }]

function pushRoomHistory(roomName, entry) {
    if (!roomHistory.has(roomName)) roomHistory.set(roomName, []);
    const arr = roomHistory.get(roomName);
    arr.push(entry);
    if (arr.length > ROOM_HISTORY_LIMIT) arr.shift();
}

function broadcastOnlineCount() {
    io.emit('online_count', onlineSzam);
}

// Spam cooldown: socketId → utolsó üzenet időbélyege
const lastMessageTime = new Map();
const COOLDOWN_MS = 1000; // 1 másodperc

// Link felismerő regex — szerver oldali (dupla védelem)
const LINK_RE = /((https?:\/\/|www\.)[^\s]+|[a-zA-Z0-9\-]+\.(com|net|org|hu|io|co|xyz|gg|me|tv|ru|de|uk|fr|eu|app|dev|ai)(\.[a-zA-Z]{2,})?(?:\/[^\s]*)?)/i;

function containsLink(text) {
    return LINK_RE.test(text);
}

// Felhasználónév validáció szerver oldalon is
const USERNAME_RE = /^[a-zA-Z0-9áéíóöőúüűÁÉÍÓÖŐÚÜŰ_\-]{3,20}$/;

function validUsername(name) {
    return typeof name === 'string' && USERNAME_RE.test(name.trim());
}

// Kliens valós IP-jének kinyerése (proxy mögött is, ha a 'trust proxy' beállítva van)
function getClientIp(socket) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return socket.handshake.address;
}

// Emberi formátum a tiltás lejáratának (vagy "végleges" szövegnek)
function formatBanExpiry(expiresAt) {
    if (!expiresAt) return null;
    // SQLite "YYYY-MM-DD HH:MM:SS" formátumot UTC-ként kezeljük
    const date = new Date(expiresAt.replace(' ', 'T') + 'Z');
    return date.toLocaleString('hu-HU', { dateStyle: 'medium', timeStyle: 'short' });
}

// A 'banned' eseményhez küldött adat összeállítása egy ban-rekordból
function buildBanPayload(ban) {
    if (!ban) {
        return {
            message: 'Ki vagy tiltva a szolgáltatásból.',
            reason: null,
            expiresAt: null,
            permanent: true,
        };
    }
    const expiryLabel = formatBanExpiry(ban.expires_at);
    return {
        message: 'Egy moderátor kitiltott a szolgáltatásból.',
        reason: ban.reason || null,
        expiresAt: expiryLabel,
        permanent: !ban.expires_at,
    };
}

// Tiltott felhasználó aktív socketjének lekapcsolása (admin akcióból hívva)
function disconnectBannedUser({ ip, username, socketId }) {
    for (const [, s] of io.sockets.sockets) {
        const matches = (socketId && s.id === socketId) ||
            (username && s.username === username) ||
            (ip && getClientIp(s) === ip);
        if (matches) {
            // Visszanézünk az adatbázisba, hogy a friss tiltás indokát/lejáratát is megkapja a kliens
            const ban = dbMod.isBanned({ ip: getClientIp(s), username: s.username });
            s.emit('banned', buildBanPayload(ban));
            if (s.currentRoom) {
                s.to(s.currentRoom).emit('partner_left', { reason: 'disconnect', partnerName: s.username });
                roomHistory.delete(s.currentRoom);
            }
            s.disconnect(true);
        }
    }
}

function parositasKiserlel(socket, topic) {
    if (varolista[topic] && varolista[topic].id !== socket.id) {
        const par = varolista[topic];
        const szobaNev = `szoba_${par.id}_${socket.id}`;

        socket.join(szobaNev);
        const parSocket = io.sockets.sockets.get(par.id);
        if (parSocket) {
            parSocket.join(szobaNev);
            socket.currentRoom = szobaNev;
            parSocket.currentRoom = szobaNev;

            // Mindenki megkapja a másik nevét ÉS nemét
            socket.emit('chat_ready', {
                message: `Összekötöttünk valakivel a(z) #${topic} témában!`,
                partnerUsername: par.username,
                partnerGender: par.gender || null
            });
            parSocket.emit('chat_ready', {
                message: `Összekötöttünk valakivel a(z) #${topic} témában!`,
                partnerUsername: socket.username,
                partnerGender: socket.gender || null
            });

            delete varolista[topic];
        }
    } else {
        varolista[topic] = { id: socket.id, username: socket.username, gender: socket.gender || null };
        socket.emit('waiting', 'Várakozás egy partnerre...');
    }
}

// Lejárt tiltások időszakos karbantartása
setInterval(() => dbMod.deactivateExpiredBans(), 5 * 60 * 1000);

io.on('connection', (socket) => {
    const clientIp = getClientIp(socket);

    // Csatlakozáskor azonnali IP-tiltás ellenőrzés (felhasználónév még nem ismert ezen a ponton)
    const banAtConnect = dbMod.isBanned({ ip: clientIp });
    if (banAtConnect) {
        socket.emit('banned', buildBanPayload(banAtConnect));
        socket.disconnect(true);
        return;
    }

    onlineSzam++;
    broadcastOnlineCount();
    console.log('Csatlakozott:', socket.id, '| IP:', clientIp, '| Online:', onlineSzam);

    socket.on('join_topic', ({ topic, username, gender }) => {
        // Validáljuk a nevet — ha érvénytelen, nem engedjük be
        if (!validUsername(username)) {
            socket.emit('error_msg', 'Érvénytelen felhasználónév.');
            return;
        }

        // Felhasználónév-alapú tiltás ellenőrzése (most már ismerjük a nevet is)
        const ban = dbMod.isBanned({ ip: clientIp, username: username.trim() });
        if (ban) {
            socket.emit('banned', buildBanPayload(ban));
            socket.disconnect(true);
            return;
        }

        socket.username = username.trim();
        socket.topic = topic;
        socket.gender = ['ferfi', 'no'].includes(gender) ? gender : null;
        parositasKiserlel(socket, topic);
    });

    socket.on('next_partner', () => {
        if (socket.currentRoom) {
            socket.to(socket.currentRoom).emit('partner_left', { reason: 'next', partnerName: socket.username });

            const roomSockets = io.sockets.adapter.rooms.get(socket.currentRoom);
            if (roomSockets) {
                for (const id of roomSockets) {
                    if (id !== socket.id) {
                        const parSocket = io.sockets.sockets.get(id);
                        if (parSocket) parSocket.currentRoom = null;
                    }
                }
            }

            roomHistory.delete(socket.currentRoom);
            socket.leave(socket.currentRoom);
            socket.currentRoom = null;
        }

        const topic = socket.topic;
        if (topic) parositasKiserlel(socket, topic);
    });

    // A főmenübe való visszatérés kezelése (Szellem-felhasználók irtása)
    socket.on('leave_chat', () => {
        // 1. Ha várakozott, azonnal töröljük a várólistáról
        if (socket.topic && varolista[socket.topic]?.id === socket.id) {
            delete varolista[socket.topic];
        }

        // 2. Ha épp chatezett valakivel, bontsuk a szobát
        if (socket.currentRoom) {
            socket.to(socket.currentRoom).emit('partner_left', { reason: 'disconnect', partnerName: socket.username });

            const roomSockets = io.sockets.adapter.rooms.get(socket.currentRoom);
            if (roomSockets) {
                for (const id of roomSockets) {
                    if (id !== socket.id) {
                        const parSocket = io.sockets.sockets.get(id);
                        if (parSocket) parSocket.currentRoom = null;
                    }
                }
            }

            roomHistory.delete(socket.currentRoom);
            socket.leave(socket.currentRoom);
            socket.currentRoom = null;
        }

        // 3. Töröljük a témáját, hisz visszament a menübe
        socket.topic = null;
    });

    socket.on('typing_start', () => {
        if (socket.currentRoom) socket.to(socket.currentRoom).emit('partner_typing');
    });

    socket.on('typing_stop', () => {
        if (socket.currentRoom) socket.to(socket.currentRoom).emit('partner_typing_stop');
    });

    socket.on('send_message', async (msg) => {
        if (!socket.currentRoom) return;

        // Spam cooldown ellenőrzés
        const now = Date.now();
        const last = lastMessageTime.get(socket.id) || 0;
        if (now - last < COOLDOWN_MS) {
            socket.emit('receive_message', {
                text: 'RENDSZER: Túl gyorsan küldesz üzeneteket. Várj egy másodpercet.',
                senderName: 'Rendszer'
            });
            return;
        }
        lastMessageTime.set(socket.id, now);

        // Leállítjuk a gépelés jelzőt a partnernél
        socket.to(socket.currentRoom).emit('partner_typing_stop');

        // Szerver oldali link blokkolás
        if (containsLink(msg)) {
            console.log(`Link blokkolva tőle: ${socket.username} (${socket.id})`);
            dbMod.logModerationEvent({
                eventType: 'link_block', username: socket.username, socketId: socket.id, ip: clientIp, detail: { msg }
            });
            socket.emit('receive_message', {
                text: 'RENDSZER: Linkek küldése nem engedélyezett.',
                senderName: 'Rendszer'
            });
            return;
        }

        const roomName = socket.currentRoom;
        const messageId = crypto.randomUUID();

        try {
            const moderation = await openai.moderations.create({ input: msg });
            const result = moderation.results[0];

            if (result.flagged) {
                console.log(`Blokkolt üzenet: ${socket.username}. Ok:`, result.categories);
                dbMod.logModerationEvent({
                    eventType: 'ai_flag',
                    username: socket.username,
                    socketId: socket.id,
                    ip: clientIp,
                    detail: { msg, categories: result.categories }
                });
                socket.emit('receive_message', {
                    text: 'RENDSZER: Az üzeneted nem lett elküldve, mert nem megfelelő tartalmat észleltünk.',
                    senderName: 'Rendszer'
                });
            } else {
                // Elmentjük a szoba rövid előzményébe (jelentésekhez)
                pushRoomHistory(roomName, { id: messageId, senderId: socket.id, senderName: socket.username, text: msg, ts: now });

                // Üzenet megy a partnernek a küldő nevével és egyedi ID-val együtt
                socket.to(roomName).emit('receive_message', {
                    id: messageId,
                    text: msg,
                    senderName: socket.username
                });
                // A küldő is megkapja a saját üzenete ID-ját, hogy a reakciók odaköthetők legyenek
                socket.emit('message_sent_ack', { id: messageId, text: msg });
            }
        } catch (error) {
            console.error('Moderáció hiba:', error);
            pushRoomHistory(roomName, { id: messageId, senderId: socket.id, senderName: socket.username, text: msg, ts: now });
            socket.to(roomName).emit('receive_message', {
                id: messageId,
                text: msg,
                senderName: socket.username
            });
            socket.emit('message_sent_ack', { id: messageId, text: msg });
        }
    });

    // ÚJ: Üzenet reakció (emoji) — valós időben továbbítva a partnernek (Hozzáadás és Törlés)
    socket.on('message_reaction', ({ messageId, emoji, isRemoved }) => {
        if (!socket.currentRoom) return;
        if (typeof messageId !== 'string' || !messageId) return;
        if (!ALLOWED_REACTIONS.has(emoji)) return;

        socket.to(socket.currentRoom).emit('partner_reaction', {
            messageId,
            emoji,
            fromName: socket.username,
            isRemoved: !!isRemoved // Biztosítjuk, hogy boolean (igaz/hamis) legyen
        });
    });

    // Jelentés — adatbázisba mentjük (kontextussal) és automatikusan bontjuk a kapcsolatot
    socket.on('report_partner', ({ reason } = {}) => {
        if (!socket.currentRoom) return;

        const roomName = socket.currentRoom;
        const roomSockets = io.sockets.adapter.rooms.get(roomName);
        let reportedSocket = null;
        if (roomSockets) {
            for (const id of roomSockets) {
                if (id !== socket.id) reportedSocket = io.sockets.sockets.get(id);
            }
        }

        const messages = roomHistory.get(roomName) || [];

        const reportId = dbMod.createReport({
            reporterSocketId: socket.id,
            reporterUsername: socket.username,
            reporterIp: clientIp,
            reportedSocketId: reportedSocket ? reportedSocket.id : null,
            reportedUsername: reportedSocket ? reportedSocket.username : null,
            reportedIp: reportedSocket ? getClientIp(reportedSocket) : null,
            roomName,
            reason,
            messages,
        });

        console.log(`Jelentés (#${reportId}) érkezett: ${socket.username} (${socket.id}) jelentette ${reportedSocket ? reportedSocket.username : '???'} (${reportedSocket ? reportedSocket.id : '???'})-t`);

        // Mindkét fél értesítése + szoba bontása
        socket.emit('report_submitted', { reportId });
        if (reportedSocket) {
            reportedSocket.emit('partner_left', { reason: 'reported', partnerName: socket.username });
            reportedSocket.currentRoom = null;
        }
        socket.to(roomName).emit('partner_left', { reason: 'reported', partnerName: socket.username });

        roomHistory.delete(roomName);
        socket.leave(roomName);
        if (reportedSocket) reportedSocket.leave(roomName);
        socket.currentRoom = null;
    });

    socket.on('disconnect', () => {
        onlineSzam = Math.max(0, onlineSzam - 1);
        broadcastOnlineCount();
        lastMessageTime.delete(socket.id);

        if (socket.topic && varolista[socket.topic]?.id === socket.id) {
            delete varolista[socket.topic];
        }
        if (socket.currentRoom) {
            socket.to(socket.currentRoom).emit('partner_left', { reason: 'disconnect', partnerName: socket.username });
            roomHistory.delete(socket.currentRoom);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Szerver fut: http://localhost:${PORT}`);
    console.log(`Admin felület: http://localhost:${PORT}/admin`);
});