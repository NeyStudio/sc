const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
// Utilisation du client PostgreSQL (pg)
const { Client } = require('pg'); 

const app = express();
// Permet de s'assurer qu'Express reçoit l'adresse IP de l'utilisateur
// et le protocole (http/https) lorsque l'application est derrière un proxy
// (ce qui est toujours le cas sur Railway).
app.set('trust proxy', 1); // 👈 C'EST LA LIGNE CLÉ

const server = http.createServer(app);

// --- 1. CONFIGURATION DU SERVEUR (CORS & PORT) ---

// EN PRODUCTION, REMPLACEZ L'URL GÉNÉRIQUE PAR L'URL EXACTE DE VOTRE PWA
const allowedOrigin = process.env.NODE_ENV === 'production' 
    ? 'https://myjournaly.quest' 
    : '*'; 

app.use(cors({ origin: allowedOrigin, methods: ["GET", "POST"] }));

const io = new Server(server, { 
    cors: { origin: allowedOrigin, methods: ["GET", "POST"] } 
});

// Railway fournit le port via process.env.PORT
const PORT = process.env.PORT || 3000; 

// Déclaration du client de base de données
let pgClient; 

// --- 2. FONCTION DE DÉMARRAGE ASYNCHRONE ---

// La fonction principale qui gère la connexion à la base de données
// et, seulement si elle réussit, démarre le serveur Express/Socket.io
async function startServer() {
    const DATABASE_URL = process.env.DATABASE_URL;

    if (!DATABASE_URL) {
        console.error("ERREUR CRITIQUE: La variable d'environnement DATABASE_URL n'est pas définie. Impossible de continuer.");
        return; // Arrêt du processus si la variable manque
    }

    try {
        // Initialisation du client PostgreSQL
        pgClient = new Client({
            connectionString: DATABASE_URL,
            ssl: {
                rejectUnauthorized: false,
            },
        });

        // 1. Connexion à la base de données (étape synchrone)
        await pgClient.connect();
        console.log('✅ Connecté à PostgreSQL Railway.');

        // 2. Création de la Table (étape synchrone)
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

        // 3. Lancement du Serveur (Seulement après la BDD)
        server.listen(PORT, () => {
            console.log(`🚀 Serveur de chat démarré sur le port ${PORT}`);
        });

    } catch (err) {
        console.error('❌ Erreur critique au démarrage (BDD ou Server):', err.stack);
        // Si la connexion échoue, le processus doit s'arrêter pour éviter les erreurs
        process.exit(1); 
    }
}
// Endpoint HTTP simple pour la vérification de santé (Health Check)
// C'est ce que Railway teste pour s'assurer que le serveur est actif.
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
                DESC LIMIT 50;
            `;
            const result = await pgClient.query(query);
            const history = result.rows.reverse(); // Inverse pour l'ordre chronologique
            
            socket.emit('history', history);
        }
    } catch (e) {
        console.error('Erreur de chargement de l\'historique (PG):', e);
    }

    socket.on('chat message', async (data) => {
        if (!data.message || !data.sender) return;

        // 1. SAUVEGARDER LE MESSAGE EN BASE DE DONNÉES (Requête SQL)
        try {
            if (pgClient) {
                const query = `
                    INSERT INTO messages (sender, message) 
                    VALUES ($1, $2);
                `;
                // Utilisation des paramètres ($1, $2) pour prévenir les injections SQL
                await pgClient.query(query, [data.sender, data.message]);
            }
        } catch (e) {
            console.error('Erreur de sauvegarde du message (PG):', e);
        }
        
        // 2. Émettre le message à TOUS les clients connectés
        io.emit('chat message', data);
    });

    socket.on('disconnect', () => {
        console.log(`Un utilisateur s’est déconnecté. ID: ${socket.id}`);
    });
});

// --- 4. DÉMARRAGE DU PROCESSUS ---

startServer(); // Lancement de la fonction de démarrage
