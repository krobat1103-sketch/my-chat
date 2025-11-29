// -------------------- 기본 환경 --------------------
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const mime = require('mime-types');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const ADMIN_NICK = "크로바츠입니다";  // 관리자 닉네임
const MAX_HISTORY = 1000;

// -------------------- 데이터 구조 --------------------
let rooms = [];
let chatHistory = {};
let bannedIPs = new Set();          // IP 밴 목록
let connectedUsers = new Map();     // socket.id → { nickname, ip }

// -------------------- 파일 업로드 --------------------
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


// -------------------- 방 생성 / 목록 --------------------
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

function getRoom(id) {
  return rooms.find(r => r.id === id);
}

function addMessage(roomId, msg) {
  if (!chatHistory[roomId]) chatHistory[roomId] = [];
  chatHistory[roomId].push(msg);
  if (chatHistory[roomId].length > MAX_HISTORY) chatHistory[roomId].shift();
}


// -------------------- 업로드 API --------------------
app.post('/upload', upload.single('file'), (req, res) => {
  res.json({
    url: '/uploads/' + req.file.filename,
    mime: req.file.mimetype
  });
});


// -------------------- 소켓 통신 --------------------
io.on('connection', socket => {
  const ip = socket.handshake.address;

  // IP 밴 확인
  if (bannedIPs.has(ip)) {
    socket.emit('banned', '당신은 밴되었습니다.');
    socket.disconnect(true);
    return;
  }

  // 방 목록 전송
  broadcastRoomList();


  // -------------------- 닉네임 설정 + 관리자 인증 --------------------
  socket.on('setNickname', ({ nickname, isAdmin }) => {
    if (isAdmin && nickname === ADMIN_NICK) {
      socket.isAdmin = true;
    } else {
      socket.isAdmin = false;
    }

    socket.nickname = nickname;
    connectedUsers.set(socket.id, { nickname, ip });
    io.emit('userList', Array.from(connectedUsers.values()));
  });


  // -------------------- 방 검색 --------------------
  socket.on('searchRooms', keyword => {
    const result = rooms.filter(r => r.name.includes(keyword))
      .map(r => ({ id: r.id, name: r.name, hasPassword: r.hasPassword }));
    socket.emit('roomList', result);
  });


  // -------------------- 방 생성 --------------------
  socket.on('createRoom', ({ roomName, hasPassword, password }) => {

    // 관리자는 무조건 비밀번호 필요 없음
    if (socket.isAdmin) hasPassword = false;

    const room = createRoom(roomName, hasPassword, password, socket.nickname);
    room.users.push(socket.nickname);

    socket.join(room.id);
    socket.emit('joinSuccess', room.id);
    socket.emit('chatHistory', chatHistory[room.id]);
    io.to(room.id).emit('roomUsers', room.users);
  });


  // -------------------- 방 입장 --------------------
  socket.on('joinRoom', ({ roomId, password }) => {
    const room = getRoom(roomId);
    if (!room) return socket.emit('joinFailed', '해당 방이 없습니다.');

    if (bannedIPs.has(ip)) {
      socket.emit('joinFailed', '당신은 밴되었습니다.');
      return;
    }

    // 비번 체크
    if (room.hasPassword && !socket.isAdmin) {
      if (room.password !== password) {
        return socket.emit('joinFailed', '비밀번호가 틀립니다.');
      }
    }

    if (!room.users.includes(socket.nickname))
      room.users.push(socket.nickname);

    socket.join(roomId);
    socket.emit('joinSuccess', roomId);
    socket.emit('chatHistory', chatHistory[roomId]);
    io.to(roomId).emit('roomUsers', room.users);
    io.to(roomId).emit('systemMessage', `${socket.nickname}님이 입장했습니다.`);
  });


  // -------------------- 메시지 전송 --------------------
  socket.on('sendMessage', ({ roomId, message, type }) => {
    const data = {
      nickname: socket.nickname,
      type: type || "text",
      message,
      time: Date.now()
    };

    addMessage(roomId, data);
    io.to(roomId).emit('newMessage', data);
  });


  // -------------------- 경고 기능 --------------------
  socket.on('warnUser', ({ targetNick }) => {
    if (!socket.isAdmin) return;

    for (let [sid, obj] of connectedUsers) {
      if (obj.nickname === targetNick) {
        io.to(sid).emit('warn', "개발자한테 뭐하는지 걸렸어요 ㅋㅋ 1번만 더 그짓거리하면 밴됩니다.");
        break;
      }
    }
  });


  // -------------------- IP 밴 기능 --------------------
  socket.on('banUser', ({ targetNick }) => {
    if (!socket.isAdmin) return;

    let targetIP = null;
    let targetSID = null;

    for (let [sid, obj] of connectedUsers) {
      if (obj.nickname === targetNick) {
        targetIP = obj.ip;
        targetSID = sid;
      }
    }

    if (!targetIP) return;

    bannedIPs.add(targetIP);

    if (targetSID) {
      io.to(targetSID).emit('banned', "관리자에 의해 밴되었습니다.");
      io.sockets.sockets.get(targetSID)?.disconnect(true);
    }
  });


  // -------------------- 방 나가기 --------------------
  socket.on('leaveRoom', ({ roomId }) => {
    const room = getRoom(roomId);
    if (!room) return;

    room.users = room.users.filter(u => u !== socket.nickname);
    socket.leave(roomId);

    io.to(roomId).emit('roomUsers', room.users);
    io.to(roomId).emit('systemMessage', `${socket.nickname}님이 나갔습니다.`);
  });


  // -------------------- 연결 종료 --------------------
  socket.on("disconnect", () => {
    connectedUsers.delete(socket.id);
    io.emit("userList", Array.from(connectedUsers.values()));

    rooms.forEach(room => {
      if (room.users.includes(socket.nickname)) {
        room.users = room.users.filter(u => u !== socket.nickname);
        io.to(room.id).emit('roomUsers', room.users);
      }
    });
  });
});


// -------------------- 서버 시작 --------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Running on " + PORT));
