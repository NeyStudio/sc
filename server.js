const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
// Utilisation du client PostgreSQL (pg)
const { Client } = require('pg'); 

const app = express();
app.set('trust proxy', 1); 

const server = http.createServer(app);

// --- 1. CONFIGURATION DU SERVEUR (CORS & PORT) ---

const allowedOrigin = process.env.NODE_ENV === 'production' 
    ? 'https://myjournaly.quest' 
    : '*'; 

app.use(cors({ origin: allowedOrigin, methods: ["GET", "POST"] }));

const io = new Server(server, { 
    cors: { origin: allowedOrigin, methods: ["GET", "POST"] } 
});

const connectedUsers = {}; 

const emitOnlineUsers = () => {
    const allowedUsers = ['Olga', 'Eric'];
    const onlineUsers = Object.values(connectedUsers).filter(name => allowedUsers.includes(name));
    io.emit('online users', onlineUsers);
};

const PORT = process.env.PORT || 3000; 
let pgClient; 

// --- 2. FONCTION DE DÉMARRAGE ASYNCHRONE (CORRECTION & MIGRATION ROBUSTE) ---
async function startServer() {
    const DATABASE_URL = process.env.DATABASE_URL;

    if (!DATABASE_URL) {
        console.error("ERREUR CRITIQUE: La variable d'environnement DATABASE_URL n'est pas définie.");
        return; 
    }

    try {
        pgClient = new Client({
            connectionString: DATABASE_URL,
            ssl: { rejectUnauthorized: false },
        });

        // 1. Connexion à la base de données
        await pgClient.connect();
        console.log('✅ Connecté à PostgreSQL Railway.');

        // 2. Création/Mise à jour de la Table (Migration explicite et sûre)
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender VARCHAR(255) NOT NULL,
                message TEXT NOT NULL,
                timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `;
        await pgClient.query(createTableQuery);

        // NOUVEAU: Ajout des colonnes de réponse UNIQUEMENT si elles n'existent pas
        await pgClient.query(`
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER NULL;
        `);
        await pgClient.query(`
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_sender VARCHAR(255) NULL;
        `);
        await pgClient.query(`
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_text TEXT NULL;
        `);

        console.log('✅ Table "messages" vérifiée/mise à jour pour la réponse.');

        // 3. Lancement du Serveur
        server.listen(PORT, () => {
            console.log(`🚀 Serveur de chat démarré sur le port ${PORT}`);
        });

    } catch (err) {
        console.error('❌ Erreur critique au démarrage (BDD ou Server):', err.stack);
        process.exit(1); 
    }
}

app.get('/', (req, res) => {
    res.status(200).send('Chat Backend is running and healthy!');
});


// --- 3. GESTION DES CONNEXIONS SOCKET.IO ---

io.on('connection', async (socket) => {
    console.log(`Un utilisateur est connecté. ID: ${socket.id}`);

    // ENVOYER L'HISTORIQUE LORS DE LA CONNEXION (CORRECTION DE LA REQUÊTE)
    try {
        if (pgClient) {
            const query = `
                SELECT 
                    id, sender, message, timestamp, 
                    reply_to_id, reply_to_sender, reply_to_text
                FROM messages 
                ORDER BY timestamp 
                DESC LIMIT 1000000;
            `;
            const result = await pgClient.query(query);
            
            // CORRECTION CLÉ: Utiliser .rows.map pour reconstruire l'objet
            const history = result.rows.reverse().map(row => ({
                id: row.id,
                sender: row.sender,
                message: row.message,
                timestamp: row.timestamp,
                // CORRECTION CLÉ: Vérification stricte si l'ID de réponse est un nombre valide
                replyTo: (row.reply_to_id && typeof row.reply_to_id === 'number') ? {
                    id: row.reply_to_id,
                    sender: row.reply_to_sender,
                    text: row.reply_to_text,
                } : null, // Retourne null si les champs de citation sont NULL
            }));
            
            socket.emit('history', history);
            emitOnlineUsers(); 
        }
    } catch (e) {
        console.error('❌ Erreur de chargement de l\'historique (PG):', e);
    }
    
    // ... (user joined, typing, stop typing inchangés) ...
    socket.on('user joined', (username) => {
        if (username === 'Olga' || username === 'Eric') {
            connectedUsers[socket.id] = username;
            emitOnlineUsers(); 
        }
    });
    
    socket.on('typing', (sender) => {
        socket.broadcast.emit('typing', sender);
    });

    socket.on('stop typing', (sender) => {
        socket.broadcast.emit('stop typing', sender);
    });

    // GESTION DES MESSAGES DE CHAT (Légère correction de la diffusion)
    socket.on('chat message', async (data) => {
        if (!data.message || !data.sender) return;

        const replyTo = data.replyTo;
        const isReply = replyTo && replyTo.id && replyTo.sender && replyTo.text;

        let messageToEmit = {
            sender: data.sender,
            message: data.message,
            replyTo: isReply ? { 
                id: replyTo.id, 
                sender: replyTo.sender, 
                text: replyTo.text 
            } : null 
        };
        
        // 1. SAUVEGARDER LE MESSAGE EN BASE DE DONNÉES
        try {
            if (pgClient) {
                let query, values;
                
                if (isReply) {
                    query = `
                        INSERT INTO messages (sender, message, reply_to_id, reply_to_sender, reply_to_text) 
                        VALUES ($1, $2, $3, $4, $5)
                        RETURNING id, timestamp;
                    `;
                    values = [data.sender, data.message, replyTo.id, replyTo.sender, replyTo.text];
                } else {
                    query = `
                        INSERT INTO messages (sender, message) 
                        VALUES ($1, $2)
                        RETURNING id, timestamp;
                    `;
                    values = [data.sender, data.message];
                }

                const result = await pgClient.query(query, values);
                
                // Mise à jour de l'objet à émettre avec l'ID et l'horodatage BDD
                messageToEmit.timestamp = result.rows[0].timestamp;
                messageToEmit.id = result.rows[0].id; // IMPORTANT pour que l'ID soit disponible pour d'autres citations
            }
        } catch (e) {
            console.error('❌ Erreur de sauvegarde du message (PG):', e);
            messageToEmit.timestamp = new Date(); 
        }
        
        // 2. Émettre le message à TOUS les clients connectés
        io.emit('chat message', messageToEmit);
    });

    socket.on('disconnect', () => {
        const username = connectedUsers[socket.id];
        if (username) {
            delete connectedUsers[socket.id];
            emitOnlineUsers(); 
        }
        console.log(`Un utilisateur s’est déconnecté. ID: ${socket.id}`);
    });
});

// --- 4. DÉMARRAGE DU PROCESSUS ---
startServer();
