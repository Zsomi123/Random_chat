require('dotenv').config();
const express = require('express');
const http = require('http');
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

            // Mindenki megkapja a másik nevét
            socket.emit('chat_ready', {
                message: `Összekötöttünk valakivel a(z) #${topic} témában!`,
                partnerUsername: par.username
            });
            parSocket.emit('chat_ready', {
                message: `Összekötöttünk valakivel a(z) #${topic} témában!`,
                partnerUsername: socket.username
            });

            delete varolista[topic];
        }
    } else {
        varolista[topic] = { id: socket.id, username: socket.username };
        socket.emit('waiting', 'Várakozás egy partnerre...');
    }
}

io.on('connection', (socket) => {
    console.log('Csatlakozott:', socket.id);

    socket.on('join_topic', ({ topic, username }) => {
        // Validáljuk a nevet — ha érvénytelen, nem engedjük be
        if (!validUsername(username)) {
            socket.emit('error_msg', 'Érvénytelen felhasználónév.');
            return;
        }
        socket.username = username.trim();
        socket.topic = topic;
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

            socket.leave(socket.currentRoom);
            socket.currentRoom = null;
        }

        const topic = socket.topic;
        if (topic) parositasKiserlel(socket, topic);
    });

    // ÚJ: Kifejezetten a főmenübe való visszatérés kezelése
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
                // Üzenet megy a partnernek a küldő nevével együtt
                socket.to(socket.currentRoom).emit('receive_message', {
                    text: msg,
                    senderName: socket.username
                });
            }
        } catch (error) {
            console.error('Moderáció hiba:', error);
            socket.to(socket.currentRoom).emit('receive_message', {
                text: msg,
                senderName: socket.username
            });
        }
    });

    socket.on('disconnect', () => {
        if (socket.topic && varolista[socket.topic]?.id === socket.id) {
            delete varolista[socket.topic];
        }
        if (socket.currentRoom) {
            socket.to(socket.currentRoom).emit('partner_left', { reason: 'disconnect', partnerName: socket.username });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Szerver fut: http://localhost:${PORT}`);
});