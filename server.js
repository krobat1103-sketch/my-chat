const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const mime = require('mime-types');
const fs = require('fs');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const ADMIN_NAME = "크로바츠입니다";
const ADMIN_PASSWORD = "khjs0070@@"; // 🔒 여기를 직접 수정해줘
const MAX_HISTORY = 1000;

let rooms = [];
let chatHistory = {};
let connectedUsers = {}; // socket.id -> {nickname, ip}
let bannedIPs = new Set();

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

function createRoom(name, hasPassword, password, owner) {
  const room = { id: Date.now().toString(), name, hasPassword, password: hasPassword ? password : null, owner, users: [] };
  rooms.push(room);
  chatHistory[room.id] = [];
  broadcastRoomList();
  return room;
}

function broadcastRoomList() {
  const list = rooms.map(r => ({ id: r.id, name: r.name, hasPassword: r.hasPassword, owner: r.owner }));
  io.emit('roomList', list);
}

function getRoomById(id) { return rooms.find(r => r.id === id); }

function addMessageToHistory(roomId, item) {
  if (!chatHistory[roomId]) chatHistory[roomId] = [];
  chatHistory[roomId].push(item);
  if (chatHistory[roomId].length > MAX_HISTORY) chatHistory[roomId].shift();
}

app.post('/upload', upload.single('file'), (req, res) => {
  res.json({ url: '/uploads/' + req.file.filename, mime: req.file.mimetype });
});

io.on('connection', (socket) => {
  const ip = socket.handshake.address;
  if (bannedIPs.has(ip)) {
    socket.emit('banned', '관리자에 의해 접속이 차단되었습니다.');
    socket.disconnect(true);
    return;
  }

  broadcastRoomList();

  socket.on('setNickname', ({ nickname, password }) => {
    if (nickname === ADMIN_NAME && password !== ADMIN_PASSWORD) {
      socket.emit('loginFailed', '관리자 비밀번호가 틀렸습니다.');
      return;
    }
    if (nickname === ADMIN_NAME && password === ADMIN_PASSWORD) {
      socket.emit('adminLogin', true);
    }
    socket.nickname = nickname;
    connectedUsers[socket.id] = { nickname, ip };
    io.emit('userList', Object.values(connectedUsers).map(u => u.nickname));
  });

  socket.on('createRoom', ({ roomName, hasPassword, password, nickname }) => {
    const room = createRoom(roomName, hasPassword, password, nickname);
    room.users.push(nickname);
    socket.join(room.id);
    socket.emit('joinSuccess', room.id);
    socket.emit('chatHistory', chatHistory[room.id] || []);
    io.to(room.id).emit('roomUsers', room.users);
  });

  socket.on('joinRoom', ({ roomId, nickname, password }) => {
    const room = getRoomById(roomId);
    if (!room) return socket.emit('joinFailed', '해당 방이 없습니다.');
    if (room.hasPassword && room.password !== password) {
      return socket.emit('joinFailed', '비밀번호가 틀립니다.');
    }
    if (!room.users.includes(nickname)) room.users.push(nickname);
    socket.join(roomId);
    socket.emit('joinSuccess', roomId);
    socket.emit('chatHistory', chatHistory[roomId] || []);
    io.to(roomId).emit('roomUsers', room.users);
    io.to(roomId).emit('systemMessage', `${nickname}님이 입장했습니다.`);
  });

  socket.on('sendMessage', ({ roomId, nickname, message, type }) => {
    const time = Date.now();
    const item = { nickname, type: type || 'text', message, time };
    addMessageToHistory(roomId, item);
    io.to(roomId).emit('newMessage', item);
  });

  socket.on('warnUser', ({ target }) => {
    const targetSocket = Object.entries(connectedUsers).find(([id, u]) => u.nickname === target);
    if (targetSocket) {
      const ts = io.sockets.sockets.get(targetSocket[0]);
      if (ts) ts.emit('warned', true);
    }
  });

  socket.on('banUser', ({ target }) => {
    const targetSocket = Object.entries(connectedUsers).find(([id, u]) => u.nickname === target);
    if (targetSocket) {
      const ip = connectedUsers[targetSocket[0]].ip;
      bannedIPs.add(ip);
      const ts = io.sockets.sockets.get(targetSocket[0]);
      if (ts) {
        ts.emit('banned', '관리자에 의해 밴되었습니다.');
        ts.disconnect(true);
      }
    }
  });

  socket.on('disconnect', () => {
    delete connectedUsers[socket.id];
    io.emit('userList', Object.values(connectedUsers).map(u => u.nickname));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Running on ${PORT}`));
