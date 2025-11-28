const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const mime = require('mime-types');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const ADMIN_NICK = "크로바츠입니다";     // 보호되는 닉네임
const ADMIN_PASSWORD = "여기에_넣어";   // 너가 원하는 비밀번호로 바꿔라
const MAX_HISTORY = 1000;

let rooms = [];
let chatHistory = {};
let connectedNickToSocket = new Map();
let bannedUsers = new Set();

// 파일 업로드 설정
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

// 방 생성 함수
function createRoom(name, hasPassword, password, owner) {
  const room = {
    id: Date.now().toString(),
    name,
    hasPassword,
    password: hasPassword ? password : null,
    owner,
    users: []
  };
  rooms.push(room);
  chatHistory[room.id] = [];
  broadcastRoomList();
  return room;
}

function broadcastRoomList() {
  const list = rooms.map(r => ({
    id: r.id,
    name: r.name,
    hasPassword: r.hasPassword,
    owner: r.owner
  }));
  io.emit('roomList', list);
}

function getRoomById(id) {
  return rooms.find(r => r.id === id);
}

function addMessageToHistory(roomId, item) {
  if (!chatHistory[roomId]) chatHistory[roomId] = [];
  chatHistory[roomId].push(item);
  if (chatHistory[roomId].length > MAX_HISTORY) chatHistory[roomId].shift();
}

// 파일 업로드 API
app.post('/upload', upload.single('file'), (req, res) => {
  res.json({
    url: '/uploads/' + req.file.filename,
    mime: req.file.mimetype
  });
});

// 소켓 연결
io.on('connection', (socket) => {
  // 새 유저 접속 → 방 목록 즉시 전송
  broadcastRoomList();

  // 방 검색
  socket.on('searchRooms', (keyword) => {
    const result = rooms
      .filter(r => r.name.includes(keyword))
      .map(r => ({
        id: r.id,
        name: r.name,
        hasPassword: r.hasPassword,
        owner: r.owner
      }));
    socket.emit('roomList', result);
  });

  // 방 생성
  socket.on('createRoom', ({ roomName, hasPassword, password, nickname }) => {
    if (!nickname) return socket.emit('createFailed', '닉네임이 필요함.');
    if (bannedUsers.has(nickname)) return socket.emit('createFailed', '밴된 사용자.');

    // 관리자 닉네임 보호
    if (nickname === ADMIN_NICK) {
      if (password !== ADMIN_PASSWORD)
        return socket.emit('createFailed', '관리자 비밀번호가 틀림.');
    }

    const room = createRoom(roomName, hasPassword, password, nickname);

    connectedNickToSocket.set(nickname, socket.id);
    socket.nickname = nickname;
    room.users.push(nickname);
    socket.join(room.id);

    socket.emit('joinSuccess', room.id);
    socket.emit('chatHistory', chatHistory[room.id]);
    io.to(room.id).emit('roomUsers', room.users);
  });

  // 방 입장
  socket.on('joinRoom', ({ roomId, nickname, password, adminPass }) => {
    if (!roomId || !nickname)
      return socket.emit('joinFailed', '방 ID/닉네임 필요');

    if (bannedUsers.has(nickname))
      return socket.emit('joinFailed', '당신은 밴됨.');

    // 닉네임 중복 금지
    const existingSocketId = connectedNickToSocket.get(nickname);
    if (existingSocketId && existingSocketId !== socket.id)
      return socket.emit('joinFailed', '이미 사용 중인 닉네임');

    // 관리자 닉네임 보호
    if (nickname === ADMIN_NICK) {
      if (adminPass !== ADMIN_PASSWORD)
        return socket.emit('joinFailed', '관리자 비밀번호 틀림.');
    }

    const room = getRoomById(roomId);
    if (!room) return socket.emit('joinFailed', '없는 방');

    if (room.hasPassword && room.password !== password)
      return socket.emit('joinFailed', '방 비밀번호 틀림');

    connectedNickToSocket.set(nickname, socket.id);
    socket.nickname = nickname;

    if (!room.users.includes(nickname)) room.users.push(nickname);
    socket.join(roomId);

    socket.emit('joinSuccess', roomId);
    socket.emit('chatHistory', chatHistory[roomId]);

    io.to(roomId).emit('roomUsers', room.users);
    io.to(roomId).emit('systemMessage', `${nickname}이(가) 입장함`);
    broadcastRoomList();
  });

  // 메시지 전송
  socket.on('sendMessage', ({ roomId, nickname, message, type }) => {
    const time = Date.now();
    const item = { nickname, type: type || 'text', message, time };
    addMessageToHistory(roomId, item);
    io.to(roomId).emit('newMessage', item);
  });

  // 방 나가기
  socket.on('leaveRoom', ({ roomId, nickname }) => {
    const room = getRoomById(roomId);
    if (!room) return;

    room.users = room.users.filter(u => u !== nickname);
    socket.leave(roomId);

    io.to(roomId).emit('roomUsers', room.users);
    io.to(roomId).emit('systemMessage', `${nickname}이(가) 나감`);

    broadcastRoomList();
  });

  // 방 삭제
  socket.on('deleteRoom', ({ roomId, nickname }) => {
    const room = getRoomById(roomId);
    if (!room) return socket.emit('deleteFailed', '방 없음');
    if (room.owner !== nickname) return socket.emit('deleteFailed', '방장은 본인');

    rooms = rooms.filter(r => r.id !== roomId);
    delete chatHistory[roomId];

    io.to(roomId).emit('systemMessage', '방이 삭제됨');

    const sockets = io.sockets.adapter.rooms.get(roomId);
    if (sockets) {
      for (const sid of sockets) {
        const s = io.sockets.sockets.get(sid);
        if (s) s.leave(roomId);
      }
    }

    broadcastRoomList();
  });

  // 사용자 차단
  socket.on('banUser', ({ targetNick, adminNick, adminPass }) => {
    if (adminNick !== ADMIN_NICK)
      return socket.emit('banFailed', '관리자만 가능');

    if (adminPass !== ADMIN_PASSWORD)
      return socket.emit('banFailed', '관리자 비밀번호 틀림');

    if (targetNick === ADMIN_NICK)
      return socket.emit('banFailed', '관리자는 밴 불가');

    bannedUsers.add(targetNick);

    const targetSid = connectedNickToSocket.get(targetNick);
    if (targetSid) {
      const targetSocket = io.sockets.sockets.get(targetSid);
      if (targetSocket) {
        targetSocket.emit('banned', '관리자에 의해 밴됨');
        targetSocket.disconnect(true);
      }
    }

    io.emit('banList', Array.from(bannedUsers));
  });

  socket.on('unbanUser', ({ targetNick, adminNick, adminPass }) => {
    if (adminNick !== ADMIN_NICK)
      return socket.emit('unbanFailed', '관리자만 가능');

    if (adminPass !== ADMIN_PASSWORD)
      return socket.emit('unbanFailed', '관리자 비밀번호 틀림');

    bannedUsers.delete(targetNick);
    io.emit('banList', Array.from(bannedUsers));
  });

  // 유저 목록 요청
  socket.on('requestRoomUsers', (roomId) => {
    const room = getRoomById(roomId);
    if (room) socket.emit('roomUsers', room.users);
  });

  // 연결 끊김 처리
  socket.on('disconnect', () => {
    const nick = socket.nickname;
    if (!nick) return;

    const sid = connectedNickToSocket.get(nick);
    if (sid === socket.id) connectedNickToSocket.delete(nick);

    rooms.forEach(room => {
      if (room.users.includes(nick)) {
        room.users = room.users.filter(u => u !== nick);
        io.to(room.id).emit('roomUsers', room.users);
        io.to(room.id).emit('systemMessage', `${nick} 연결 끊김`);
      }
    });

    broadcastRoomList();
  });
});

// 서버 실행
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Running on ${PORT}`));
