const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const mime = require('mime-types');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const ADMIN_NAME = "크로바츠";
const MAX_HISTORY = 1000;

let rooms = [];
let chatHistory = {};
let connectedNickToSocket = new Map();
let bannedUsers = new Set();

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
  broadcastRoomList();

  socket.on('searchRooms', (keyword) => {
    const result = rooms.filter(r => r.name.includes(keyword)).map(r => ({ id: r.id, name: r.name, hasPassword: r.hasPassword, owner: r.owner }));
    socket.emit('roomList', result);
  });

  socket.on('createRoom', ({ roomName, hasPassword, password, nickname }) => {
    if (!nickname) { socket.emit('createFailed', '닉네임이 필요합니다.'); return; }
    if (bannedUsers.has(nickname)) { socket.emit('createFailed', '밴 된 사용자입니다.'); return; }
    const room = createRoom(roomName, hasPassword, password, nickname);
    connectedNickToSocket.set(nickname, socket.id);
    socket.nickname = nickname;
    room.users.push(nickname);
    socket.join(room.id);
    socket.emit('joinSuccess', room.id);
    socket.emit('chatHistory', chatHistory[room.id] || []);
    io.to(room.id).emit('roomUsers', room.users);
  });

  socket.on('joinRoom', ({ roomId, nickname, password }) => {
    if (!roomId || !nickname) { socket.emit('joinFailed', '방 ID와 닉네임이 필요합니다.'); return; }
    if (bannedUsers.has(nickname)) { socket.emit('joinFailed', '당신은 밴되어 있습니다.'); return; }
    const existingSocketId = connectedNickToSocket.get(nickname);
    if (existingSocketId && existingSocketId !== socket.id) { socket.emit('joinFailed', '이 닉네임은 이미 사용 중입니다.'); return; }
    const room = getRoomById(roomId);
    if (!room) { socket.emit('joinFailed', '해당 방이 없습니다.'); return; }
    if (room.hasPassword && room.password !== password) { socket.emit('joinFailed', '비밀번호가 틀립니다.'); return; }
    connectedNickToSocket.set(nickname, socket.id);
    socket.nickname = nickname;
    if (!room.users.includes(nickname)) room.users.push(nickname);
    socket.join(roomId);
    socket.emit('joinSuccess', roomId);
    socket.emit('chatHistory', chatHistory[roomId] || []);
    io.to(roomId).emit('roomUsers', room.users);
    io.to(roomId).emit('systemMessage', `${nickname}님이 입장했습니다.`);
    broadcastRoomList();
  });

  socket.on('leaveRoom', ({ roomId, nickname }) => {
    const room = getRoomById(roomId);
    if (!room) return;
    room.users = room.users.filter(u => u !== nickname);
    socket.leave(roomId);
    io.to(roomId).emit('roomUsers', room.users);
    io.to(roomId).emit('systemMessage', `${nickname}님이 나갔습니다.`);
    broadcastRoomList();
  });

  socket.on('sendMessage', ({ roomId, nickname, message, type }) => {
    const time = Date.now();
    const item = { nickname, type: type || 'text', message, time };
    addMessageToHistory(roomId, item);
    io.to(roomId).emit('newMessage', item);
  });

  socket.on('deleteRoom', ({ roomId, nickname }) => {
    const room = getRoomById(roomId);
    if (!room) { socket.emit('deleteFailed', '방이 존재하지 않습니다.'); return; }
    if (room.owner !== nickname) { socket.emit('deleteFailed', '방 소유자만 삭제할 수 있습니다.'); return; }
    rooms = rooms.filter(r => r.id !== roomId);
    delete chatHistory[roomId];
    io.to(roomId).emit('systemMessage', '방이 삭제되었습니다.');
    const sockets = io.sockets.adapter.rooms.get(roomId);
    if (sockets) {
      for (const sid of sockets) {
        const s = io.sockets.sockets.get(sid);
        if (s) s.leave(roomId);
      }
    }
    broadcastRoomList();
  });

  socket.on('banUser', ({ targetNick, adminNick }) => {
    if (adminNick !== ADMIN_NAME) { socket.emit('banFailed', '관리자만 사용할 수 있습니다.'); return; }
    if (targetNick === ADMIN_NAME) { socket.emit('banFailed', '관리자는 밴할 수 없습니다.'); return; }
    bannedUsers.add(targetNick);
    const targetSid = connectedNickToSocket.get(targetNick);
    if (targetSid) {
      const targetSocket = io.sockets.sockets.get(targetSid);
      if (targetSocket) {
        targetSocket.emit('banned', '관리자에 의해 밴되었습니다.');
        targetSocket.disconnect(true);
      }
    }
    io.emit('banList', Array.from(bannedUsers));
  });

  socket.on('unbanUser', ({ targetNick, adminNick }) => {
    if (adminNick !== ADMIN_NAME) { socket.emit('unbanFailed', '관리자만 사용할 수 있습니다.'); return; }
    bannedUsers.delete(targetNick);
    io.emit('banList', Array.from(bannedUsers));
  });

  socket.on('requestRoomUsers', (roomId) => {
    const room = getRoomById(roomId);
    if (!room) return;
    socket.emit('roomUsers', room.users);
  });

  socket.on('disconnect', () => {
    const nick = socket.nickname;
    if (nick) {
      const sid = connectedNickToSocket.get(nick);
      if (sid === socket.id) connectedNickToSocket.delete(nick);
      rooms.forEach(room => {
        if (room.users.includes(nick)) {
          room.users = room.users.filter(u => u !== nick);
          io.to(room.id).emit('roomUsers', room.users);
          io.to(room.id).emit('systemMessage', `${nick}님이 연결이 끊겼습니다.`);
        }
      });
      broadcastRoomList();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Running on ${PORT}`);
});
