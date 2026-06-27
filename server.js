require('dotenv').config();
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { OpenAI } = require('openai');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const openai = new OpenAI();

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

let varolista = {};

// Online felhasználók számlálója
let onlineSzam = 0;

// Jelentések naplózása (egyszerű, fájlba író log)
const REPORT_LOG_PATH = path.join(__dirname, 'reports.log');

function logReport({ reporterId, reporterName, reportedId, reportedName, roomMessages, reason }) {
    const entry = {
        timestamp: new Date().toISOString(),
        reporterId,
        reporterName,
        reportedId,
        reportedName,
        reason: reason || null,
        recentMessages: roomMessages || []
    };
    fs.appendFile(REPORT_LOG_PATH, JSON.stringify(entry) + '\n', (err) => {
        if (err) console.error('Nem sikerült a jelentést naplózni:', err);
    });
}

// Engedélyezett reakció emoji-k — szerver oldali whitelist (dupla védelem)
const ALLOWED_REACTIONS = new Set(['👍', '❤️', '😂', '😮']);

// Üzenetek rövid puffere szobánként, hogy jelentésnél tudjunk logolni mit látott a user
const ROOM_HISTORY_LIMIT = 30;
const roomHistory = new Map(); // szobaNev -> [{ id, senderName, text, ts }]

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

io.on('connection', (socket) => {
    onlineSzam++;
    broadcastOnlineCount();
    console.log('Csatlakozott:', socket.id, '| Online:', onlineSzam);

    socket.on('join_topic', ({ topic, username, gender }) => {
        // Validáljuk a nevet — ha érvénytelen, nem engedjük be
        if (!validUsername(username)) {
            socket.emit('error_msg', 'Érvénytelen felhasználónév.');
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

    // ÚJ: A főmenübe való visszatérés kezelése (Szellem-felhasználók irtása)
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

    // ÚJ: Jelentés — naplózzuk és automatikusan bontjuk a kapcsolatot
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

        logReport({
            reporterId: socket.id,
            reporterName: socket.username,
            reportedId: reportedSocket ? reportedSocket.id : null,
            reportedName: reportedSocket ? reportedSocket.username : null,
            roomMessages: roomHistory.get(roomName) || [],
            reason
        });

        console.log(`Jelentés érkezett: ${socket.username} (${socket.id}) jelentette ${reportedSocket ? reportedSocket.username : '???'} (${reportedSocket ? reportedSocket.id : '???'})-t`);

        // Mindkét fél értesítése + szoba bontása
        socket.emit('report_submitted');
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
});