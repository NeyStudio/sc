const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Client } = require('pg'); 

// NOUVEAU: Imports pour la sécurité
const bcrypt = require('bcrypt'); 
const jwt = require('jsonwebtoken'); 

const app = express();
app.set('trust proxy', 1); 
// NOUVEAU: Middleware pour analyser les corps de requêtes JSON (pour le login POST)
app.use(express.json());

const server = http.createServer(app);

// --- 1. CONFIGURATION ET SECRETS ---

const allowedOrigin = process.env.NODE_ENV === 'production' 
    ? 'https://myjournaly.quest' 
    : '*'; 

app.use(cors({ origin: allowedOrigin, methods: ["GET", "POST"] }));

const io = new Server(server, { 
    cors: { origin: allowedOrigin, methods: ["GET", "POST"] } 
});

// NOUVEAU: Récupération des secrets (assurez-vous qu'ils sont définis sur Railway!)
const STORED_HASH = process.env.SECRET_QUEST_HASH;
const JWT_SECRET = process.env.JWT_SECRET_KEY;

const connectedUsers = {}; 

const emitOnlineUsers = () => {
    const allowedUsers = ['Olga', 'Eric'];
    // Vérifie si le nom dans connectedUsers est dans la liste autorisée
    const onlineUsers = Object.values(connectedUsers).filter(name => allowedUsers.includes(name));
    io.emit('online users', onlineUsers);
};

const PORT = process.env.PORT || 3000; 
let pgClient; 

// --- NOUVEAU: MIDDLEWARE DE VÉRIFICATION DU JETON JWT ---

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    // Tente de récupérer le token de l'en-tête "Authorization: Bearer <TOKEN>"
    const token = authHeader && authHeader.split(' ')[1]; 

    if (token == null) {
        return res.status(401).json({ message: 'Accès refusé. Jeton manquant.' }); 
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            // 403 Forbidden: Jeton invalide ou expiré
            return res.status(403).json({ message: 'Jeton invalide ou expiré.' });
        }
        req.user = user; 
        next(); 
    });
};

// --- 2. FONCTION DE DÉMARRAGE ASYNCHRONE ---
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

        // 2. Création/Mise à jour de la Table
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender VARCHAR(255) NOT NULL,
                message TEXT NOT NULL,
                timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `;
        await pgClient.query(createTableQuery);

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

// --- 3. ROUTES EXPRESS (PROTECTION HTTP) ---

app.get('/', (req, res) => {
    res.status(200).send('Chat Backend is running and healthy!');
});

// NOUVEAU: ROUTE D'AUTHENTIFICATION (Le point d'entrée sécurisé pour le "Nom de Quête")
app.post('/api/auth/login', async (req, res) => {
    const { nomDeQuete } = req.body;

    if (!nomDeQuete || !STORED_HASH || !JWT_SECRET) {
        return res.status(400).json({ message: 'Configuration ou données manquantes.' });
    }

    try {
        // 1. Vérification sécurisée du mot de passe (Nom de Quête)
        const match = await bcrypt.compare(nomDeQuete, STORED_HASH);

        if (match) {
            // 2. Création du Jeton JWT
            const token = jwt.sign(
                { identity: 'couple_messenger' }, // Payload
                JWT_SECRET,
                { expiresIn: '1d' } // Le jeton expire après 1 jour
            );

            // 3. Renvoi du jeton au client
            res.json({ success: true, token });
        } else {
            res.status(401).json({ success: false, message: 'Nom de quête invalide.' });
        }
    } catch (error) {
        console.error("Erreur d'authentification:", error);
        res.status(500).json({ message: 'Erreur interne du serveur.' });
    }
});

// NOUVEAU: Exemple de route protégée (facultatif si tout passe par Socket.IO)
// app.get('/api/messages', authenticateToken, (req, res) => {
//     res.json({ status: 'OK', message: 'Accès aux messages HTTP autorisé.' });
// });


// --- 4. GESTION DES CONNEXIONS SOCKET.IO (LOGIQUE D'HISTORIQUE ET D'ENVOI) ---

io.on('connection', async (socket) => {
    console.log(`Un utilisateur est connecté. ID: ${socket.id}`);

    // NOUVEAU: L'historique n'est plus envoyé immédiatement
    // Il sera envoyé après l'événement 'user joined' (avec le token)

    // NOUVEAU: Gérer l'identification de l'utilisateur AVEC VÉRIFICATION DU TOKEN
    socket.on('user joined', async ({ username, token }) => {
        const allowedUsers = ['Olga', 'Eric'];

        // VÉRIFICATION DU TOKEN
        if (!token) {
            socket.emit('auth_error', 'Jeton manquant. Reconnexion requise.');
            socket.disconnect(true);
            return;
        }

        jwt.verify(token, JWT_SECRET, async (err, decoded) => {
            if (err) {
                socket.emit('auth_error', 'Jeton invalide ou expiré.');
                socket.disconnect(true);
                return;
            }

            // AUTHENTIFICATION RÉUSSIE
            if (allowedUsers.includes(username)) {
                connectedUsers[socket.id] = username;
                emitOnlineUsers(); 

                // ENVOI DE L'HISTORIQUE APRÈS AUTHENTIFICATION RÉUSSIE
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
                        
                        const history = result.rows.reverse().map(row => {
                            const hasReply = row.reply_to_id && parseInt(row.reply_to_id) > 0;
                            return {
                                id: row.id,
                                sender: row.sender,
                                message: row.message,
                                timestamp: row.timestamp,
                                replyTo: hasReply ? {
                                    id: parseInt(row.reply_to_id), 
                                    sender: row.reply_to_sender,
                                    text: row.reply_to_text,
                                } : null, 
                            };
                        });
                        
                        socket.emit('history', history);
                    }
                } catch (e) {
                    console.error('❌ Erreur CRITIQUE de chargement de l\'historique (PG):', e);
                    socket.emit('history', []); 
                }

            } else {
                // Le nom d'utilisateur n'est pas "Olga" ou "Eric"
                socket.emit('auth_error', 'Utilisateur non autorisé.');
                socket.disconnect(true);
            }
        });
    });
    
    // GESTION DES MESSAGES DE CHAT (AVEC VÉRIFICATION DU SENDER)
    socket.on('chat message', async (data) => {
        // NOUVEAU: Vérifie que l'utilisateur est dans la liste des connectés (authentifié)
        const sender = connectedUsers[socket.id];
        if (!sender) {
            console.error('TENTATIVE D\'ENVOI NON AUTHENTIFIÉE:', socket.id);
            socket.emit('auth_error', 'Non connecté. Reconnexion.');
            return;
        }

        if (!data.message) return; // Le sender est maintenant garanti par 'connectedUsers'

        const replyTo = data.replyTo;
        const isReply = replyTo && replyTo.id && replyTo.sender && replyTo.text;

        let messageToEmit = {
            sender: sender, // Utiliser le sender vérifié
            message: data.message,
            replyTo: isReply ? { 
                id: replyTo.id, 
                sender: replyTo.sender, 
                text: replyTo.text 
            } : null 
        };
        
        // 1. SAUVEGARDER LE MESSAGE EN BASE DE DONNÉES
        try {
            // ... (votre logique d'insertion BDD) ...
            if (pgClient) {
                let query, values;
                
                if (isReply) {
                    query = `
                        INSERT INTO messages (sender, message, reply_to_id, reply_to_sender, reply_to_text) 
                        VALUES ($1, $2, $3, $4, $5)
                        RETURNING id, timestamp;
                    `;
                    values = [sender, data.message, replyTo.id, replyTo.sender, replyTo.text];
                } else {
                    query = `
                        INSERT INTO messages (sender, message) 
                        VALUES ($1, $2)
                        RETURNING id, timestamp;
                    `;
                    values = [sender, data.message];
                }

                const result = await pgClient.query(query, values);
                
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
    
    // NOUVEAU : Gérer l'événement 'typing' (Gardez-le)
    socket.on('typing', (sender) => {
        // Une vérification du sender ici serait idéale mais laissons simple pour le typing
        socket.broadcast.emit('typing', sender);
    });

    // NOUVEAU : Gérer l'événement 'stop typing' (Gardez-le)
    socket.on('stop typing', (sender) => {
        socket.broadcast.emit('stop typing', sender);
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

// --- 5. DÉMARRAGE DU PROCESSUS ---
startServer();
