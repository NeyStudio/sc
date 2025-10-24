Const express = require('express');
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
    ? 'https://myjournaly.quest' // 👈 VÉRIFIEZ ET REMPLACEZ CETTE URL !
    : '*'; 

app.use(cors({ origin: allowedOrigin, methods: ["GET", "POST"] }));

const io = new Server(server, { 
    cors: { origin: allowedOrigin, methods: ["GET", "POST"] } 
});

const connectedUsers = {}; // Map pour suivre les utilisateurs en ligne (Socket ID -> Nom)

// Fonction utilitaire pour diffuser la liste des utilisateurs en ligne
const emitOnlineUsers = () => {
    const allowedUsers = ['Olga', 'Eric'];
    const onlineUsers = Object.values(connectedUsers).filter(name => allowedUsers.includes(name));
    io.emit('online users', onlineUsers);
};

// Railway fournit le port via process.env.PORT
const PORT = process.env.PORT || 3000; 

let pgClient; 

// --- 2. FONCTION DE DÉMARRAGE ASYNCHRONE (MISE À JOUR DE LA TABLE) ---
async function startServer() {
    const DATABASE_URL = process.env.DATABASE_URL;

    if (!DATABASE_URL) {
        console.error("ERREUR CRITIQUE: La variable d'environnement DATABASE_URL n'est pas définie. Impossible de continuer.");
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

        // 2. Création ou mise à jour de la Table (Ajout des champs de réponse)
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender VARCHAR(255) NOT NULL,
                message TEXT NOT NULL,
                timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                -- NOUVEAU: Colonnes pour la fonctionnalité de réponse
                reply_to_id INTEGER NULL,
                reply_to_sender VARCHAR(255) NULL,
                reply_to_text TEXT NULL
            );
            
            -- NOUVEAU: Ajout des colonnes si elles n'existent pas déjà (pour la migration)
            DO $$ BEGIN
                ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER NULL;
                ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_sender VARCHAR(255) NULL;
                ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_text TEXT NULL;
            EXCEPTION
                WHEN duplicate_column THEN null;
            END $$;
        `;
        await pgClient.query(createTableQuery);
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


// --- 3. GESTION DES CONNEXIONS SOCKET.IO (MISE À JOUR) ---

io.on('connection', async (socket) => {
    console.log(`Un utilisateur est connecté. ID: ${socket.id}`);

    // ENVOYER L'HISTORIQUE LORS DE LA CONNEXION (MISE À JOUR DE LA REQUÊTE)
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
            const history = result.rows.reverse().map(row => ({
                id: row.id,
                sender: row.sender,
                message: row.message,
                timestamp: row.timestamp,
                // Reconstruction de l'objet replyTo pour le client si les champs existent
                replyTo: (row.reply_to_id && row.reply_to_sender && row.reply_to_text) ? {
                    id: row.reply_to_id,
                    sender: row.reply_to_sender,
                    text: row.reply_to_text,
                } : null,
            }));
            
            socket.emit('history', history);
            emitOnlineUsers(); 
        }
    } catch (e) {
        console.error('Erreur de chargement de l\'historique (PG):', e);
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

    // GESTION DES MESSAGES DE CHAT (MISE À JOUR POUR GÉRER replyTo)
    socket.on('chat message', async (data) => {
        if (!data.message || !data.sender) return;

        // Extraction et validation du contexte de réponse
        const replyTo = data.replyTo;
        const isReply = replyTo && replyTo.id && replyTo.sender && replyTo.text;

        let messageToEmit = {
            sender: data.sender,
            message: data.message,
            replyTo: isReply ? { 
                id: replyTo.id, 
                sender: replyTo.sender, 
                text: replyTo.text 
            } : null // S'assurer que replyTo est null s'il n'est pas valide
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
                
                // On met à jour l'objet à émettre avec les données exactes de la BDD
                messageToEmit.timestamp = result.rows[0].timestamp;
                messageToEmit.id = result.rows[0].id;
            }
        } catch (e) {
            console.error('Erreur de sauvegarde du message avec/sans reply (PG):', e);
            messageToEmit.timestamp = new Date(); 
            // NOTE: Si la sauvegarde échoue, le message ne sera pas conservé.
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
