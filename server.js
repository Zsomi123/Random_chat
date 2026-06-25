require('dotenv').config(); // Ez olvassa be a .env fájlból az API kulcsot
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { OpenAI } = require('openai'); // Beimportáljuk az OpenAI-t

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Inicializáljuk az OpenAI-t (automatikusan használja a folyamatban lévő OPENAI_API_KEY-t)
const openai = new OpenAI();

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

let varolista = {};

io.on('connection', (socket) => {
    console.log('Egy felhasználó csatlakozott:', socket.id);

    socket.on('join_topic', (topic) => {
        socket.topic = topic;
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
    });

    // --- ITT JÖN AZ AI MODERÁCIÓS MÓDOSÍTÁS ---
    socket.on('send_message', async (msg) => {
        if (!socket.currentRoom) return;

        try {
            // Meghívjuk az OpenAI moderációs API-ját
            const moderation = await openai.moderations.create({ input: msg });
            const result = moderation.results[0];

            // Az AI visszaad egy 'flagged' (igaz/hamis) értéket, ha a szabályzatba ütközik
            // Valamint alkategóriákat, mint pl. result.categories.sexual vagy result.categories.hate
            if (result.flagged) {
                console.log(`Blokkolt üzenet tőle: ${socket.id}. Ok:`, result.categories);
                
                // Csak a küldőnek küldünk egy hibaüzenetet, a partner nem látja meg a csúnya szöveget!
                socket.emit('receive_message', 'RENDSZER: Az üzeneted nem lett elküldve, mert nem megfelelő (felnőtt vagy sértő) tartalmat észleltünk.');
            } else {
                // Ha az AI szerint minden tiszta, mehet tovább az üzenet a partnernek
                socket.to(socket.currentRoom).emit('receive_message', msg);
            }
        } catch (error) {
            console.error('Hiba történt az AI moderáció során:', error);
            // Biztonsági játék: Ha az AI épp nem elérhető, eldöntheted, hogy átengeded-e az üzenetet, 
            // vagy inkább hibaüzenetet dobsz. Itt most átengedjük.
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

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`A szerver fut a http://localhost:${PORT} címen`);
});