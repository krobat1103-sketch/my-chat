//-----------------------------------------------------------
// Modern Chat Server (Full Feature)
//-----------------------------------------------------------
const helmet = require("helmet");
app.use(helmet());
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const mime = require("mime-types");
const fs = require("fs");
const helmet = require("helmet");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 보안 설정
app.disable("x-powered-by");
app.use(helmet());

// 관리자 정보
const ADMIN_NAME = "크로바츠";
const ADMIN_PASSWORD = "여기에_관리자비번_넣기";

// 데이터
let rooms = [];
let chatHistory = {};
let nickToSocket = new Map();
let bannedIPs = new Set();

//-----------------------------------------------------------
// Helper: 유저 IP 가져오기
//-----------------------------------------------------------
function getClientIP(socket) {
  return (
    socket.handshake.headers["x-forwarded-for"] ||
    socket.handshake.address ||
    socket.request.connection.remoteAddress ||
    "unknown"
  );
}

//-----------------------------------------------------------
// XSS 방지용 간단한 Sanitizer
//-----------------------------------------------------------
function clean(str) {
  if (!str) return "";
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

//-----------------------------------------------------------
// 파일 업로드 설정
//-----------------------------------------------------------
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads"),
    filename: (req, file, cb) =>
      cb(null, Date.now() + "." + (mime.extension(file.mimetype) || "bin")),
  }),
});

// 업로드 API
app.post("/upload", upload.single("file"), (req, res) => {
  res.json({
    url: "/uploads/" + req.file.filename,
    mime: req.file.mimetype,
  });
});

// Static 제공
app.use("/uploads", express.static("uploads"));
app.use(express.static("public"));

//-----------------------------------------------------------
// 방 생성
//-----------------------------------------------------------
function createRoom(name, hasPassword, password, owner) {
  const id = Date.now().toString();

  rooms.push({
    id,
    name: clean(name),
    hasPassword,
    password,
    owner,
    users: [],
  });

  chatHistory[id] = [];

  broadcastRooms();

  return id;
}

function broadcastRooms() {
  io.emit(
    "roomList",
    rooms.map((r) => ({
      id: r.id,
      name: r.name,
      owner: r.owner,
      hasPassword: r.hasPassword,
    }))
  );
}

//-----------------------------------------------------------
// Socket.io 연결
//-----------------------------------------------------------
io.on("connection", (socket) => {
  const ip = getClientIP(socket);

  // ───── IP 밴 차단 ─────
  if (bannedIPs.has(ip)) {
    socket.emit("banned", "IP가 차단됨.");
    return socket.disconnect(true);
  }

  broadcastRooms();

  //---------------------------------------------------------
  // 관리자 로그인
  //---------------------------------------------------------
  socket.on("adminLogin", ({ nickname, password }) => {
    if (nickname !== ADMIN_NAME) return socket.emit("adminFailed");
    if (password !== ADMIN_PASSWORD) return socket.emit("adminFailed");

    socket.isAdmin = true;
    socket.emit("adminSuccess");
    socket.emit("banList", Array.from(bannedIPs));
  });

  //---------------------------------------------------------
  // 방 생성
  //---------------------------------------------------------
  socket.on("createRoom", ({ roomName, hasPassword, password, nickname }) => {
    nickname = clean(nickname);
    roomName = clean(roomName);

    if (!nickname) return;

    // 닉 중복 검사
    if (nickToSocket.has(nickname)) {
      return socket.emit("createFailed", "이미 사용 중인 닉네임");
    }

    socket.nickname = nickname;
    nickToSocket.set(nickname, socket.id);

    const id = createRoom(roomName, hasPassword, password, nickname);
    const room = rooms.find((r) => r.id === id);

    room.users.push(nickname);
    socket.join(id);

    socket.emit("joinSuccess", id);
    socket.emit("chatHistory", chatHistory[id]);

    io.to(id).emit("roomUsers", room.users);
  });

  //---------------------------------------------------------
  // 방 입장
  //---------------------------------------------------------
  socket.on("joinRoom", ({ roomId, nickname, password }) => {
    nickname = clean(nickname);

    const room = rooms.find((r) => r.id === roomId);
    if (!room) return socket.emit("joinFailed", "방이 존재하지 않습니다.");

    if (room.hasPassword && room.password !== password) {
      return socket.emit("joinFailed", "비밀번호가 올바르지 않습니다.");
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
    io.to(roomId).emit("systemMessage", `${nickname} 님이 입장했습니다.`);
  });

  //---------------------------------------------------------
  // 메시지
  //---------------------------------------------------------
  socket.on("sendMessage", ({ roomId, nickname, message, type }) => {
    if (!chatHistory[roomId]) return;

    const item = {
      nickname,
      message: type === "text" ? clean(message) : message,
      time: Date.now(),
      type,
    };

    chatHistory[roomId].push(item);

    io.to(roomId).emit("newMessage", item);
  });

  //---------------------------------------------------------
  // 관리자 IP 밴
  //---------------------------------------------------------
  socket.on("banUser", ({ targetNick }) => {
    if (!socket.isAdmin) return;

    const sid = nickToSocket.get(targetNick);
    if (!sid) return;

    const t = io.sockets.sockets.get(sid);
    if (!t) return;

    const targetIP = getClientIP(t);
    bannedIPs.add(targetIP);

    t.emit("banned", "관리자에 의해 차단되었습니다.");
    t.disconnect(true);

    // 전체에게 갱신
    io.emit("banList", Array.from(bannedIPs));
  });

  //---------------------------------------------------------
  // 방 삭제
  //---------------------------------------------------------
  socket.on("deleteRoom", ({ roomId, nickname }) => {
    const room = rooms.find((r) => r.id === roomId);
    if (!room) return;
    if (room.owner !== nickname) return;

    rooms = rooms.filter((r) => r.id !== roomId);
    delete chatHistory[roomId];

    broadcastRooms();
  });

  //---------------------------------------------------------
  // 유저 나가기
  //---------------------------------------------------------
  socket.on("leaveRoom", ({ roomId, nickname }) => {
    const room = rooms.find((r) => r.id === roomId);
    if (!room) return;

    room.users = room.users.filter((u) => u !== nickname);
    socket.leave(roomId);

    io.to(roomId).emit("roomUsers", room.users);
    io.to(roomId).emit("systemMessage", `${nickname} 님이 나갔습니다.`);
  });

  //---------------------------------------------------------
  // 접속 종료
  //---------------------------------------------------------
  socket.on("disconnect", () => {
    const nick = socket.nickname;
    if (!nick) return;

    nickToSocket.delete(nick);

    rooms.forEach((room) => {
      if (room.users.includes(nick)) {
        room.users = room.users.filter((u) => u !== nick);
        io.to(room.id).emit("roomUsers", room.users);
        io.to(room.id).emit("systemMessage", `${nick} 님이 나갔습니다.`);
      }
    });

    broadcastRooms();
  });
});

//-----------------------------------------------------------
server.listen(process.env.PORT || 3000, () =>
  console.log("SERVER RUNNING")
);
