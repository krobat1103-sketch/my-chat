
const express = require("express");
const helmet = require("helmet");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const ADMIN_NAME = "크로바츠입니다";
const ADMIN_PASSWORD = "myadminpw";

const app = express();
app.use(helmet());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server);

let rooms = {};
let bannedIPs = [];

function clean(text){
  return text.replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/&/g,"&amp;").replace(/"/g,"&#34;");
}

io.on("connection", (socket)=>{
  const ip = socket.handshake.address;

  if(bannedIPs.includes(ip)){
    socket.emit("banned","밴됨");
    socket.disconnect();
    return;
  }

  socket.on("adminLogin", (data)=>{
    if(data.nickname !== ADMIN_NAME) return;
    if(data.password === ADMIN_PASSWORD){
      socket.isAdmin = true;
      socket.emit("adminSuccess");
    }else socket.emit("adminFailed");
  });

  socket.on("createRoom",(d)=>{
    const id = Date.now().toString();
    rooms[id] = {
      id,
      name: clean(d.roomName),
      owner: clean(d.nickname),
      hasPassword: d.hasPassword,
      password: d.password || "",
      users: [],
      chat:[]
    };
    io.emit("roomList", Object.values(rooms));
  });

  socket.on("searchRooms",(txt)=>{
    txt = clean(txt);
    const list = Object.values(rooms).filter(r=>r.name.includes(txt));
    socket.emit("roomList", list);
  });

  socket.on("joinRoom",(d)=>{
    const r = rooms[d.roomId];
    if(!r) return socket.emit("joinFailed","존재하지 않는 방");
    if(r.hasPassword && r.password !== d.password){
      return socket.emit("joinFailed","비밀번호 틀림");
    }
    socket.join(r.id);
    r.users.push(d.nickname);
    socket.currentRoom = r.id;
    socket.nickname = d.nickname;
    socket.emit("joinSuccess", r.id);
    socket.emit("chatHistory", r.chat);
    io.to(r.id).emit("roomUsers", r.users);
  });

  socket.on("sendMessage",(d)=>{
    const r = rooms[d.roomId];
    if(!r) return;
    const msg = {
      time: Date.now(),
      type: d.type,
      nickname: clean(d.nickname),
      message: clean(d.message)
    };
    r.chat.push(msg);
    io.to(r.id).emit("newMessage", msg);
  });

  socket.on("banUser",(data)=>{
    if(!socket.isAdmin) return;
    const target = [...io.sockets.sockets.values()].find(s=>s.nickname === data.targetNick);
    if(target){
      bannedIPs.push(target.handshake.address);
      target.emit("banned","관리자에 의해 밴됨");
      target.disconnect();
      io.emit("banList", bannedIPs);
    }
  });

  socket.on("disconnect", ()=>{
    const r = rooms[socket.currentRoom];
    if(r){
      r.users = r.users.filter(u=>u!==socket.nickname);
      io.to(r.id).emit("roomUsers", r.users);
    }
  });

  io.emit("roomList", Object.values(rooms));
});

server.listen(3000, ()=> console.log("SERVER RUNNING on 3000"));
