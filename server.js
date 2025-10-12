// Import des modules
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors'); // Nécessaire pour les requêtes cross-domain (Netlify vers votre serveur)

const app = express();
const server = http.createServer(app);

// Configuration de CORS : Autoriser la connexion depuis n'importe quel domaine (*)
// Pour la production, remplacez '*' par l'URL de votre site Netlify : 'https://votre-site-netlify.app'
app.use(cors({
    origin: "https://myjournaly.quest", 
    methods: ["GET", "POST"]
}));

// Configuration de Socket.IO
const io = new Server(server, {
    cors: {
        origin: "https://myjournaly.quest", // Doit correspondre à l'origine dans app.use(cors)
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000; // Utiliser le port fourni par l'hébergeur

// Gestion des connexions Socket.IO
io.on('connection', (socket) => {
  console.log('Un utilisateur est connecté.');

  // Écouter l'événement 'chat message' du client
  socket.on('chat message', (data) => {
    // Renvoyer le message à TOUS les clients connectés
    io.emit('chat message', data);
  });

  socket.on('disconnect', () => {
    console.log('Un utilisateur s’est déconnecté.');
  });
});

// Le backend n'a pas besoin de servir de page HTML dans ce modèle
server.listen(PORT, () => {
  console.log(`Serveur en cours d'exécution sur le port ${PORT}`);
});
