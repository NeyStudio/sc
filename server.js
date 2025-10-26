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

// --- 2. FONCTION DE DÉMARRAGE ASYNCHRONE (GESTION DE LA BDD ET MIGRATION ROBUSTE) ---
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

        // Ajout des colonnes de réponse UNIQUEMENT si elles n'existent pas
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


// --- 3. GESTION DES CONNEXIONS SOCKET.IO (LOGIQUE D'HISTORIQUE ET D'ENVOI CORRIGÉE) ---

io.on('connection', async (socket) => {
    console.log(`Un utilisateur est connecté. ID: ${socket.id}`);

    // ENVOYER L'HISTORIQUE LORS DE LA CONNEXION (LOGIQUE CORRIGÉE)
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
            
            // Reconstruction de l'objet replyTo avec vérification stricte de l'existence et du type
            const history = result.rows.reverse().map(row => {
                // Vérifier si reply_to_id existe (n'est pas NULL) ET est un ID valide (supérieur à 0)
                const hasReply = row.reply_to_id && parseInt(row.reply_to_id) > 0;

                return {
                    id: row.id,
                    sender: row.sender,
                    message: row.message,
                    timestamp: row.timestamp,
                    // Utiliser l'objet de réponse uniquement si les données sont présentes
                    replyTo: hasReply ? {
                        id: parseInt(row.reply_to_id), 
                        sender: row.reply_to_sender,
                        text: row.reply_to_text,
                    } : null, 
                };
            });
            
            socket.emit('history', history);
            emitOnlineUsers(); 
        }
    } catch (e) {
        console.error('❌ Erreur CRITIQUE de chargement de l\'historique (PG):', e);
        // Envoyer un historique vide en cas d'erreur critique pour ne pas bloquer le client
        socket.emit('history', []); 
    }
    
    
    // NOUVEAU : Gérer l'identification de l'utilisateur
    socket.on('user joined', (username) => {
        if (username === 'Olga' || username === 'Eric') {
            connectedUsers[socket.id] = username;
            emitOnlineUsers(); 
        }
    });
    
    // NOUVEAU : Gérer l'événement 'typing'
    socket.on('typing', (sender) => {
        socket.broadcast.emit('typing', sender);
    });

    // NOUVEAU : Gérer l'événement 'stop typing'
    socket.on('stop typing', (sender) => {
        socket.broadcast.emit('stop typing', sender);
    });

    // GESTION DES MESSAGES DE CHAT (INSERTION CORRIGÉE)
    socket.on('chat message', async (data) => {
        if (!data.message || !data.sender) return;

        const replyTo = data.replyTo;
        const isReply = replyTo && replyTo.id && replyTo.sender && replyTo.text;

        let messageToEmit = {
            sender: data.sender,
            message: data.message,
            // S'assurer que replyTo est bien null ou un objet propre pour l'émission
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
                    // Requête avec les champs de réponse
                    query = `
                        INSERT INTO messages (sender, message, reply_to_id, reply_to_sender, reply_to_text) 
                        VALUES ($1, $2, $3, $4, $5)
                        RETURNING id, timestamp;
                    `;
                    values = [data.sender, data.message, replyTo.id, replyTo.sender, replyTo.text];
                } else {
                    // Requête standard
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
                messageToEmit.id = result.rows[0].id; 
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
