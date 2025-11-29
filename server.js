const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const mime = require('mime-types');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

/* -----------------------------
    관리자 설정
------------------------------*/
const ADMIN_NAME = "크로바츠";
const ADMIN_PASSWORD = "여기에_너가_원하는_비밀번호";

/* -----------------------------
    데이터 저장
------------------------------*/
let rooms = [];
let chatHistory = {};
let nickToSocket = new Map();

// IP 밴
let bannedIPs = new Set();

/* -----------------------------
    유저 실제 IP 얻기
------------------------------*/
function getClientIP(socket) {
  return (
    socket.handshake.headers['x-forwarded-for'] ||
    socket.handshake.address ||
    socket.request.connection.remoteAddress ||
    "unknown"
  );
}

/* -----------------------------
    파일 업로드 설정
------------------------------*/
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
      cb(null, "uploads");
    },
    filename: (req, file, cb) => {
      const ext = mime.extension(file.mimetype) || "bin";
      cb(null, Date.now() + "." + ext);
    }
  })
});

/* -----------------------------
    Static
------------------------------*/
app.use("/uploads", express.static("uploads"));
app.use(express.static("public"));

/* -----------------------------
    Upload API
------------------------------*/
app.post("/upload", upload.single("file"), (req, res) => {
  res.json({
    url: "/uploads/" + req.file.filename,
    mime: req.file.mimetype
  });
});

/* -----------------------------
    방 생성 함수
------------------------------*/
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

/* -----------------------------
    소켓 연결
------------------------------*/
io.on("connection", socket => {
  const userIP = getClientIP(socket);

  // IP BAN 체크
  if (bannedIPs.has(userIP)) {
    socket.emit("banned", "IP가 관리자에 의해 밴되었습니다.");
    return socket.disconnect(true);
  }

  broadcastRoomList();

  /* -----------------------------
        관리자 로그인 처리
  ------------------------------*/
  socket.on("adminLogin", ({ nickname, password }) => {
    if (nickname === ADMIN_NAME && password === ADMIN_PASSWORD) {
      socket.isAdmin = true;
      socket.emit("adminSuccess");
    } else {
      socket.emit("adminFailed");
    }
  });

  /* -----------------------------
        전체 접속자 목록 요청
  ------------------------------*/
  socket.on("requestUserList", () => {
    if (!socket.isAdmin) return;
    const list = [];
    for (let [nick, sid] of nickToSocket.entries()) {
      list.push(nick);
    }
    socket.emit("allUsers", list);
  });

  /* -----------------------------
        방 생성
  ------------------------------*/
  socket.on("createRoom", ({ roomName, hasPassword, password, nickname }) => {

    if (nickToSocket.has(nickname)) {
      return socket.emit("createFailed", "이미 사용 중인 닉네임입니다.");
    }

    socket.nickname = nickname;
    nickToSocket.set(nickname, socket.id);

    const room = createRoom(roomName, hasPassword, password, nickname);
    room.users.push(nickname);

    socket.join(room.id);
    socket.emit("joinSuccess", room.id);
    socket.emit("chatHistory", chatHistory[room.id]);
    io.to(room.id).emit("roomUsers", room.users);
  });

  /* -----------------------------
        방 입장
  ------------------------------*/
  socket.on("joinRoom", ({ roomId, nickname, password }) => {
    const room = rooms.find(r => r.id === roomId);
    if (!room) return socket.emit("joinFailed", "방이 존재하지 않습니다.");

    if (room.hasPassword && room.password !== password) {
      return socket.emit("joinFailed", "비밀번호가 틀렸습니다.");
    }

    if (nickToSocket.has(nickname) && nickToSocket.get(nickname) !== socket.id) {
      return socket.emit("joinFailed", "이미 사용 중인 닉네임입니다.");
    }

    socket.nickname = nickname;
    nickToSocket.set(nickname, socket.id);

    if (!room.users.includes(nickname)) room.users.push(nickname);

    socket.join(roomId);
    socket.emit("joinSuccess", roomId);
    socket.emit("chatHistory", chatHistory[roomId]);

    io.to(roomId).emit("roomUsers", room.users);
    io.to(roomId).emit("systemMessage", `${nickname}님이 입장했습니다.`);
  });

  /* -----------------------------
        메시지
  ------------------------------*/
  socket.on("sendMessage", ({ roomId, nickname, message, type }) => {
    const item = {
      nickname,
      type: type || "text",
      message,
      time: Date.now()
    };
    chatHistory[roomId].push(item);
    io.to(roomId).emit("newMessage", item);
  });

  /* -----------------------------
        관리자 전용 IP 밴
  ------------------------------*/
  socket.on("banIP", ({ targetNick }) => {
    if (!socket.isAdmin) return;

    const targetSid = nickToSocket.get(targetNick);
    if (!targetSid) return;

    const targetSocket = io.sockets.sockets.get(targetSid);
    if (!targetSocket) return;

    const targetIP = getClientIP(targetSocket);

    bannedIPs.add(targetIP);

    targetSocket.emit("banned", "IP가 관리자에 의해 차단되었습니다.");
    targetSocket.disconnect(true);

    io.emit("banList", Array.from(bannedIPs));
  });

  /* -----------------------------
        연결 종료
  ------------------------------*/
  socket.on("disconnect", () => {
    const nick = socket.nickname;
    if (nick) {
      nickToSocket.delete(nick);

      rooms.forEach(room => {
        if (room.users.includes(nick)) {
          room.users = room.users.filter(u => u !== nick);
          io.to(room.id).emit("roomUsers", room.users);
          io.to(room.id).emit("systemMessage", `${nick}님이 나갔습니다.`);
        }
      });

      broadcastRoomList();
    }
  });
});

/* -----------------------------
    서버 시작
------------------------------*/
server.listen(process.env.PORT || 3000, () => {
  console.log("SERVER RUNNING");
});
