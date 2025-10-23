const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);

// --- 1. BASE DE DONNÉES (MongoDB) ---
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    console.error("ERREUR: La variable d'environnement MONGODB_URI n'est pas définie.");
}

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Connecté à MongoDB.'))
  .catch(err => console.error('❌ Erreur de connexion MongoDB:', err));

const MessageSchema = new mongoose.Schema({
    sender: String,
    message: String,
    timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

// --- 2. CONFIGURATION DU SERVEUR (CORS & PORT) ---
const allowedOrigin = process.env.NODE_ENV === 'production' 
    ? 'https://myjournaly.quest' // 👈 VÉRIFIEZ ET REMPLACEZ CETTE URL !
    : '*'; 

app.use(cors({ origin: allowedOrigin, methods: ["GET", "POST"] }));

const io = new Server(server, { 
    cors: { origin: allowedOrigin, methods: ["GET", "POST"] } 
});

const connectedUsers = {}; // Map pour stocker les utilisateurs connectés (ID de socket -> nom)
const PORT = process.env.PORT || 3000; 

// Fonction utilitaire pour diffuser la liste des utilisateurs en ligne
const emitOnlineUsers = () => {
    // On extrait uniquement les noms d'utilisateur à partir de la map des sockets
    const onlineUsers = Object.values(connectedUsers); 
    io.emit('online users', onlineUsers);
};

// --- 3. GESTION DES CONNEXIONS SOCKET.IO (Temps réel et Persistance) ---
io.on('connection', async (socket) => {
    console.log(`Un utilisateur est connecté. ID: ${socket.id}`);

    // ENVOYER L'HISTORIQUE LORS DE LA CONNEXION
    try {
        const history = await Message.find().sort('timestamp').limit(50); 
        socket.emit('history', history); 
    } catch (e) {
        console.error('Erreur de chargement de l\'historique:', e);
    }
    
    // Gérer l'identification de l'utilisateur (seulement Olga ou Eric)
    socket.on('user joined', (username) => {
        if (username === 'Olga' || username === 'Eric') {
            connectedUsers[socket.id] = username;
            emitOnlineUsers(); // Diffuser la liste mise à jour
        }
    });
    
    // Gérer l'événement 'typing'
    socket.on('typing', (sender) => {
        socket.broadcast.emit('typing', sender);
    });

    // Gérer l'événement 'stop typing'
    socket.on('stop typing', (sender) => {
        socket.broadcast.emit('stop typing', sender);
    });
    
    socket.on('chat message', async (data) => {
        if (!data.message || !data.sender) return;

        let messageToEmit = data; 
        
        // 1. SAUVEGARDER LE MESSAGE EN BASE DE DONNÉES
        try {
            const newMessage = new Message({
                sender: data.sender,
                message: data.message
            });
            const savedMessage = await newMessage.save();
            
            // Mettre à jour l'objet à émettre avec l'horodatage
            messageToEmit = {
                sender: savedMessage.sender,
                message: savedMessage.message,
                timestamp: savedMessage.timestamp 
            };

        } catch (e) {
            console.error('Erreur de sauvegarde du message:', e);
            messageToEmit.timestamp = new Date(); 
        }
        
        // 2. Émettre le message à TOUS les clients connectés (avec l'horodatage)
        io.emit('chat message', messageToEmit);
    });

    socket.on('disconnect', () => {
        const username = connectedUsers[socket.id];
        if (username) {
            delete connectedUsers[socket.id];
            emitOnlineUsers(); // Diffuser la liste mise à jour
        }
        console.log(`Un utilisateur s’est déconnecté. ID: ${socket.id}`);
    });
});

// --- 4. DÉMARRAGE DU SERVEUR ---
server.listen(PORT, () => {
  console.log(`🚀 Serveur de chat démarré sur le port ${PORT}`);
});
