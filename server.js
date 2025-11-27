
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const mime = require('mime-types');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Simple in-memory storage (for demo)
// rooms: same as before
let rooms = []; // { id, name, hasPassword, password, users: [] }
// chatHistory: { roomId: [ { nickname, type, message, time }, ... ] }
const chatHistory = {};
const MAX_HISTORY = 500;

function createRoom(name, hasPassword, password) {
  const room = {
    id: Date.now().toString(),
    name,
    hasPassword,
    password: hasPassword ? password : null,
    users: []
  };
  rooms.push(room);
  chatHistory[room.id] = [];
  return room;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = 'uploads';
      if (!fs.existsSync(dir)) fs.mkdirSync(dir);
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = mime.extension(file.mimetype) || 'bin';
      cb(null, Date.now() + '.' + ext);
    }
  })
});

app.use('/uploads', express.static('uploads'));
app.use(express.static('public'));

// API to list rooms (optional)
app.get('/rooms', (req, res) => {
  res.json(rooms.map(r => ({ id: r.id, name: r.name, hasPassword: r.hasPassword })));
});

// File upload route
app.post('/upload', upload.single('file'), (req, res) => {
  res.json({ url: '/uploads/' + req.file.filename, mime: req.file.mimetype });
});

io.on('connection', (socket) => {
  // send room list on connect
  socket.emit('roomList', rooms);

  socket.on('searchRooms', (keyword) => {
    const result = rooms.filter(r => r.name.includes(keyword));
    socket.emit('roomList', result);
  });

  socket.on('createRoom', ({ roomName, hasPassword, password }) => {
    const newRoom = createRoom(roomName, hasPassword, password);
    io.emit('roomList', rooms);
  });

  socket.on('joinRoom', ({ roomId, nickname, password }) => {
    const room = rooms.find(r => r.id === roomId);
    if (!room) {
      socket.emit('joinFailed', '해당 방이 없습니다.');
      return;
    }
    if (room.hasPassword && room.password !== password) {
      socket.emit('joinFailed', '비밀번호가 틀립니다');
      return;
    }
    socket.join(roomId);
    // add user to room.users if not already
    if (!room.users.includes(nickname)) room.users.push(nickname);
    socket.emit('joinSuccess', roomId);
    // send existing history to the joining client
    socket.emit('chatHistory', chatHistory[roomId] || []);
    // notify others about join (optional)
    io.to(roomId).emit('systemMessage', `${nickname}님이 입장했습니다.`);
  });

  socket.on('leaveRoom', ({ roomId, nickname }) => {
    const room = rooms.find(r => r.id === roomId);
    if (!room) return;
    room.users = room.users.filter(u => u !== nickname);
    socket.leave(roomId);
    io.to(roomId).emit('systemMessage', `${nickname}님이 나갔습니다.`);
  });

  socket.on('sendMessage', ({ roomId, nickname, message, type }) => {
    const time = Date.now();
    const item = { nickname, type: type || 'text', message, time };
    // store to history
    if (!chatHistory[roomId]) chatHistory[roomId] = [];
    chatHistory[roomId].push(item);
    // limit size
    if (chatHistory[roomId].length > MAX_HISTORY) chatHistory[roomId].shift();
    // broadcast to room
    io.to(roomId).emit('newMessage', item);
  });

  socket.on('disconnecting', () => {
    // Optional: remove socket user from rooms if we stored socket->nick mapping
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Running on ${PORT}`);
});
