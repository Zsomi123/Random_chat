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

function parositasKiserlel(socket, topic) {
    if (varolista[topic] && varolista[topic] !== socket.id) {
        const parId = varolista[topic];
        const szobaNev = `szoba_${parId}_${socket.id}`;

        socket.join(szobaNev);
        const parSocket = io.sockets.sockets.get(parId);
        if (parSocket) {
            parSocket.join(szobaNev);
            socket.currentRoom = szobaNev;
            parSocket.currentRoom = szobaNev;
            io.to(szobaNev).emit('chat_ready', `Összekötöttünk valakivel a(z) #${topic} témában!`);
            delete varolista[topic];
        }
    } else {
        varolista[topic] = socket.id;
        socket.emit('waiting', 'Várakozás egy partnerre...');
    }
}

io.on('connection', (socket) => {
    console.log('Egy felhasználó csatlakozott:', socket.id);

    socket.on('join_topic', (topic) => {
        socket.topic = topic;
        parositasKiserlel(socket, topic);
    });

    socket.on('next_partner', () => {
        console.log(`Next: ${socket.id}`);

        if (socket.currentRoom) {
            socket.to(socket.currentRoom).emit('partner_left', 'A partnered elhagyta a chatet, hogy új embert keressen.');

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
        if (topic) {
            parositasKiserlel(socket, topic);
        }
    });

    // Typing indicators
    socket.on('typing_start', () => {
        if (socket.currentRoom) {
            socket.to(socket.currentRoom).emit('partner_typing');
        }
    });

    socket.on('typing_stop', () => {
        if (socket.currentRoom) {
            socket.to(socket.currentRoom).emit('partner_typing_stop');
        }
    });

    // AI moderált üzenetküldés
    socket.on('send_message', async (msg) => {
        if (!socket.currentRoom) return;

        // Stop typing indicator when message is sent
        socket.to(socket.currentRoom).emit('partner_typing_stop');

        try {
            const moderation = await openai.moderations.create({ input: msg });
            const result = moderation.results[0];

            if (result.flagged) {
                console.log(`Blokkolt üzenet tőle: ${socket.id}. Ok:`, result.categories);
                socket.emit('receive_message', 'RENDSZER: Az üzeneted nem lett elküldve, mert nem megfelelő (felnőtt vagy sértő) tartalmat észleltünk.');
            } else {
                socket.to(socket.currentRoom).emit('receive_message', msg);
            }
        } catch (error) {
            console.error('Hiba az AI moderáció során:', error);
            socket.to(socket.currentRoom).emit('receive_message', msg);
        }
    });

    socket.on('disconnect', () => {
        if (socket.topic && varolista[socket.topic] === socket.id) {
            delete varolista[socket.topic];
        }
        if (socket.currentRoom) {
            socket.to(socket.currentRoom).emit('partner_left', 'A partnered kilépett a chatből.');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`A szerver fut a http://localhost:${PORT} címen`);
});