const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);

// --- 1. BASE DE DONNÉES (MongoDB) ---

// Render utilisera cette variable d'environnement pour la connexion
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    console.error("ERREUR: La variable d'environnement MONGODB_URI n'est pas définie.");
    // Utiliser une URL de secours locale si vous testez en local
    // MONGODB_URI = 'mongodb://localhost/simple_chat'; 
}

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Connecté à MongoDB.'))
  .catch(err => console.error('❌ Erreur de connexion MongoDB:', err));

// Définition du Schéma de Message
const MessageSchema = new mongoose.Schema({
    sender: String,
    message: String,
    timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

// --- 2. CONFIGURATION DU SERVEUR (CORS & PORT) ---

// EN PRODUCTION, REMPLACEZ L'URL GÉNÉRIQUE PAR L'URL EXACTE DE VOTRE SITE NETLIFY
// Par exemple : 'https://votre-super-pwa.netlify.app'
const allowedOrigin = process.env.NODE_ENV === 'production' 
    ? 'https://myjournaly.quest' // 👈 Remplacez ceci !
    : '*'; 

app.use(cors({ origin: allowedOrigin, methods: ["GET", "POST"] }));

const io = new Server(server, { 
    cors: { origin: allowedOrigin, methods: ["GET", "POST"] } 
});

// Render fournit le port via process.env.PORT
const PORT = process.env.PORT || 3000; 

// --- 3. GESTION DES CONNEXIONS SOCKET.IO (Temps réel et Persistance) ---

io.on('connection', async (socket) => {
    console.log(`Un utilisateur est connecté. ID: ${socket.id}`);

    // ENVOYER L'HISTORIQUE LORS DE LA CONNEXION
    try {
        // Charger les 50 derniers messages, triés par date
        const history = await Message.find().sort('timestamp').limit(50); 
        socket.emit('history', history); // Envoyer l'historique au client qui vient de se connecter
    } catch (e) {
        console.error('Erreur de chargement de l\'historique:', e);
    }

    socket.on('chat message', async (data) => {
        // Validation basique
        if (!data.message || !data.sender) return;

        // 1. SAUVEGARDER LE MESSAGE EN BASE DE DONNÉES
        try {
            const newMessage = new Message({
                sender: data.sender,
                message: data.message
            });
            await newMessage.save();
        } catch (e) {
            console.error('Erreur de sauvegarde du message:', e);
        }
        
        // 2. Émettre le message à TOUS les clients connectés (pour l'affichage en temps réel)
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
