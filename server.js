const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
// Importation du client PostgreSQL au lieu de mongoose
const { Client } = require('pg'); 

const app = express();
const server = http.createServer(app);

// --- 1. BASE DE DONNÉES (PostgreSQL) ---

// Railway fournit l'URI de connexion complète dans DATABASE_URL
const DATABASE_URL = process.env.DATABASE_URL;
let pgClient; // Déclaration du client de base de données

if (!DATABASE_URL) {
    console.error("ERREUR: La variable d'environnement DATABASE_URL n'est pas définie.");
} else {
    // Configuration du client PostgreSQL
    pgClient = new Client({
        connectionString: DATABASE_URL,
        // Ces options sont souvent nécessaires pour se connecter
        // à des bases de données cloud (SSL)
        ssl: {
            rejectUnauthorized: false,
        },
    });

    // Connexion à la base de données
    pgClient.connect()
        .then(() => {
            console.log('✅ Connecté à PostgreSQL Railway.');
            
            // CRÉATION DE LA TABLE SI ELLE N'EXISTE PAS
            const createTableQuery = `
                CREATE TABLE IF NOT EXISTS messages (
                    id SERIAL PRIMARY KEY,
                    sender VARCHAR(255) NOT NULL,
                    message TEXT NOT NULL,
                    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );
            `;
            return pgClient.query(createTableQuery);

        })
        .catch(err => console.error('❌ Erreur de connexion PostgreSQL:', err.stack));
}

// --- 2. CONFIGURATION DU SERVEUR (CORS & PORT) ---

// EN PRODUCTION, REMPLACEZ L'URL GÉNÉRIQUE PAR L'URL EXACTE DE VOTRE SITE NETLIFY
const allowedOrigin = process.env.NODE_ENV === 'production' 
    ? 'https://myjournaly.quest' 
    : '*'; 

app.use(cors({ origin: allowedOrigin, methods: ["GET", "POST"] }));

const io = new Server(server, { 
    cors: { origin: allowedOrigin, methods: ["GET", "POST"] } 
});

// Railway fournit le port via process.env.PORT
const PORT = process.env.PORT || 3000; 

// --- 3. GESTION DES CONNEXIONS SOCKET.IO (Temps réel et Persistance) ---

io.on('connection', async (socket) => {
    console.log(`Un utilisateur est connecté. ID: ${socket.id}`);

    // ENVOYER L'HISTORIQUE LORS DE LA CONNEXION
    try {
        if (pgClient) {
            // Requête SQL pour charger les 50 derniers messages
            const query = `
                SELECT sender, message, timestamp 
                FROM messages 
                ORDER BY timestamp 
                DESC LIMIT 50;
            `;
            const result = await pgClient.query(query);
            const history = result.rows.reverse(); // Inverse pour avoir l'ordre chronologique
            
            socket.emit('history', history);
        }
    } catch (e) {
        console.error('Erreur de chargement de l\'historique (PG):', e);
    }

    socket.on('chat message', async (data) => {
        // Validation basique
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

// --- 4. DÉMARRAGE DU SERVEUR ---

server.listen(PORT, () => {
  console.log(`🚀 Serveur de chat démarré sur le port ${PORT}`);
});
