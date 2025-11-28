const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const mime = require('mime-types');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ==============================
// 🔒 관리자 설정
// ==============================
const ADMIN_NAME = "크로바츠입니다";
const ADMIN_PASSWORD = "";   // ← ← ← 여기에 너가 직접 비번 넣으면 됨 (현재는 비어 있음)
const MAX_HISTORY = 1000;

// ==============================
// 기본 변수
// ==============================
let rooms = [];
let chatHistory = {};
let connectedUsers = {}; // socket.id -> { nickname, ip }
let bannedIPs = new Set();

// ==============================
// 파일 업로드 기본 설정
// ==============================
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = 'uploads';
      if (!fs.existsSync(dir)) fs.mkdirSync(dir);
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = mime.extension(file.mimetype) || 'bin';
      cb(null, Date.now() + "." + ext);
    }
  })
});

app.use('/uploads', express.static('uploads'));
app.use(express.static('public'));

// ==============================
// 방 생성 함수
// ==============================
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
  io.emit("roomList", list);
}

function getRoomById(id) {
  return rooms.find(r => r.id === id);
}

function addMessageToHistory(roomId, item) {
  if (!chatHistory[roomId]) chatHistory[roomId] = [];
  chatHistory[roomId].push(item);
  if (chatHistory[roomId].length > MAX_HISTORY) chatHistory[roomId].shift();
}

// ==============================
// 파일 업로드 API
// ==============================
app.post('/upload', upload.single('file'), (req, res) => {
  res.json({
    url: '/uploads/' + req.file.filename,
    mime: req.file.mimetype
  });
});

// ==============================
// 소켓 통신 시작
// ==============================
io.on("connection", socket => {

  const ip = socket.handshake.address;

  // 차단된 IP는 즉시 강퇴
  if (bannedIPs.has(ip)) {
    socket.emit("banned", "당신은 관리자에 의해 차단된 IP입니다.");
    socket.disconnect(true);
    return;
  }

  broadcastRoomList();

  // ============================
  // 👤 닉네임 설정 + 관리자 로그인
  // ============================
  socket.on("setNickname", ({ nickname, password }) => {

    // 관리자 닉네임인데 비번 틀림
    if (nickname === ADMIN_NAME && password !== ADMIN_PASSWORD) {
      socket.emit("loginFailed", "관리자 비밀번호가 틀렸습니다.");
      return;
    }

    // 관리자 로그인 성공
    if (nickname === ADMIN_NAME && password === ADMIN_PASSWORD) {
      socket.emit("adminLogin", true);
    }

    socket.nickname = nickname;
    connectedUsers[socket.id] = { nickname, ip };

    io.emit("userList", Object.values(connectedUsers).map(u => u.nickname));
  });

  // ============================
  // ⭐ 방 만들기
  // ============================
  socket.on("createRoom", ({ roomName, hasPassword, password, nickname }) => {
    const room = createRoom(roomName, hasPassword, password, nickname);
    room.users.push(nickname);

    socket.join(room.id);
    socket.emit("joinSuccess", room.id);
    socket.emit("chatHistory", chatHistory[room.id]);

    io.to(room.id).emit("roomUsers", room.users);
  });

  // ============================
  // ⏺ 방 입장
  // ============================
  socket.on("joinRoom", ({ roomId, nickname, password }) => {
    const room = getRoomById(roomId);
    if (!room) return socket.emit("joinFailed", "방이 존재하지 않습니다.");

    if (room.hasPassword && room.password !== password) {
      return socket.emit("joinFailed", "비밀번호가 틀렸습니다.");
    }

    if (!room.users.includes(nickname)) room.users.push(nickname);

    socket.join(roomId);
    socket.emit("joinSuccess", roomId);
    socket.emit("chatHistory", chatHistory[roomId]);

    io.to(roomId).emit("roomUsers", room.users);
    io.to(roomId).emit("systemMessage", `${nickname}님이 입장했습니다.`);
  });

  // ============================
  // 💬 메시지 보내기
  // ============================
  socket.on("sendMessage", ({ roomId, nickname, message, type }) => {
    const item = {
      nickname,
      type: type || 'text',
      message,
      time: Date.now()
    };
    addMessageToHistory(roomId, item);
    io.to(roomId).emit("newMessage", item);
  });

  // ============================
  // ⚠ 관리자: 경고 띄우기
  // ============================
  socket.on("warnUser", ({ target }) => {
    const found = Object.entries(connectedUsers).find(([id, u]) => u.nickname === target);
    if (!found) return;

    const ts = io.sockets.sockets.get(found[0]);
    if (ts) {
      ts.emit("warned", true);
    }
  });

  // ============================
  // 🔨 관리자: IP 밴
  // ============================
  socket.on("banUser", ({ target }) => {
    const found = Object.entries(connectedUsers).find(([id, u]) => u.nickname === target);
    if (!found) return;

    const targetId = found[0];
    const targetIP = connectedUsers[targetId].ip;

    bannedIPs.add(targetIP);

    const ts = io.sockets.sockets.get(targetId);

    if (ts) {
      ts.emit("banned", "당신은 관리자에 의해 차단되었습니다.");
      ts.disconnect(true);
    }
  });

  // ============================
  // 🔌 연결 종료
  // ============================
  socket.on("disconnect", () => {
    delete connectedUsers[socket.id];
    io.emit("userList", Object.values(connectedUsers).map(u => u.nickname));
  });

});


// ==============================
// 서버 시작
// ==============================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("🚀 Server running on " + PORT));
