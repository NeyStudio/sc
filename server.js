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
    ? 'https://myjournaly.quest' // 👈 VÉRIFIEZ ET REMPLACEZ CETTE URL !
    : '*'; 

app.use(cors({ origin: allowedOrigin, methods: ["GET", "POST"] }));

const io = new Server(server, { 
    cors: { origin: allowedOrigin, methods: ["GET", "POST"] } 
});

const connectedUsers = {}; // NOUVEAU : Map pour suivre les utilisateurs en ligne (Socket ID -> Nom)

// Fonction utilitaire pour diffuser la liste des utilisateurs en ligne
const emitOnlineUsers = () => {
    // On extrait uniquement les noms d'utilisateur à partir de la map des sockets
    // et filtre pour s'assurer que seuls 'Olga' ou 'Eric' sont comptés
    const allowedUsers = ['Olga', 'Eric'];
    const onlineUsers = Object.values(connectedUsers).filter(name => allowedUsers.includes(name));
    io.emit('online users', onlineUsers);
};

// Railway fournit le port via process.env.PORT
const PORT = process.env.PORT || 3000; 

let pgClient; 

// --- 2. FONCTION DE DÉMARRAGE ASYNCHRONE ---
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

        // 2. Création de la Table
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender VARCHAR(255) NOT NULL,
                message TEXT NOT NULL,
                timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `;
        await pgClient.query(createTableQuery);
        console.log('✅ Table "messages" vérifiée/créée.');

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


// --- 3. GESTION DES CONNEXIONS SOCKET.IO (Temps réel et Persistance) ---

io.on('connection', async (socket) => {
    console.log(`Un utilisateur est connecté. ID: ${socket.id}`);

    // ENVOYER L'HISTORIQUE LORS DE LA CONNEXION
    try {
        if (pgClient) {
            const query = `
                SELECT sender, message, timestamp 
                FROM messages 
                ORDER BY timestamp 
                DESC LIMIT 1000000;
            `;
            const result = await pgClient.query(query);
            const history = result.rows.reverse(); 
            
            socket.emit('history', history);
            // ENVOYER LE STATUT EN LIGNE IMMÉDIATEMENT
            emitOnlineUsers(); 
        }
    } catch (e) {
        console.error('Erreur de chargement de l\'historique (PG):', e);
    }
    
    // NOUVEAU : Gérer l'identification de l'utilisateur (pour le statut en ligne)
    socket.on('user joined', (username) => {
        // Validation stricte : n'accepter que 'Olga' ou 'Eric'
        if (username === 'Olga' || username === 'Eric') {
            connectedUsers[socket.id] = username;
            emitOnlineUsers(); // Diffuser la liste mise à jour
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

    socket.on('chat message', async (data) => {
        if (!data.message || !data.sender) return;

        let messageToEmit = data; 
        
        // 1. SAUVEGARDER LE MESSAGE EN BASE DE DONNÉES ET RÉCUPÉRER L'HORODATAGE
        try {
            if (pgClient) {
                // Requête pour insérer ET retourner l'horodatage exact créé par la BDD
                const query = `
                    INSERT INTO messages (sender, message) 
                    VALUES ($1, $2)
                    RETURNING timestamp;
                `;
                const result = await pgClient.query(query, [data.sender, data.message]);
                
                // On s'assure d'utiliser l'horodatage exact de la base de données pour la diffusion
                messageToEmit = {
                    sender: data.sender,
                    message: data.message,
                    timestamp: result.rows[0].timestamp 
                };
            }
        } catch (e) {
            console.error('Erreur de sauvegarde du message (PG):', e);
            // Fallback en cas d'erreur de BDD
            messageToEmit.timestamp = new Date(); 
        }
        
        // 2. Émettre le message à TOUS les clients connectés (avec l'horodatage BDD)
        io.emit('chat message', messageToEmit);
    });

    socket.on('disconnect', () => {
        const username = connectedUsers[socket.id];
        if (username) {
            delete connectedUsers[socket.id];
            emitOnlineUsers(); // Diffuser la liste mise à jour après la déconnexion
        }
        console.log(`Un utilisateur s’est déconnecté. ID: ${socket.id}`);
    });
});

// --- 4. DÉMARRAGE DU PROCESSUS ---
startServer();
