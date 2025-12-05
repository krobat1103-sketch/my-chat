//-----------------------------------------------------------
// Modern Chat Client Script
//-----------------------------------------------------------
const socket = io();
let currentRoomId = null;
const ADMIN_NAME = "크로바츠";
let isAdmin = false;

// HTML 요소 가져오기
const nicknameEl = document.getElementById("nickname");
const saveNickBtn = document.getElementById("saveNick");
const changeNickBtn = document.getElementById("changeNick");

const searchEl = document.getElementById("search");
const searchBtn = document.getElementById("btnSearch");

const roomListEl = document.getElementById("roomList");
const createRoomBtn = document.getElementById("createRoom");

const msgInput = document.getElementById("msgInput");
const sendBtn = document.getElementById("sendBtn");

const chatTitle = document.getElementById("chatTitle");
const chatBox = document.getElementById("messages");

const chatContainer = document.getElementById("chat");
const roomUsersEl = document.getElementById("roomUsers");
const banListEl = document.getElementById("banList");

const uploadBtn = document.getElementById("uploadBtn");
const leaveBtn = document.getElementById("leaveBtn");

const adminMenu = document.getElementById("adminMenu");
const adminLoginBtn = document.getElementById("adminLoginBtn");

//-----------------------------------------------------------
// Helper : XSS 필터
//-----------------------------------------------------------
function safeText(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

//-----------------------------------------------------------
// 닉네임 로드
//-----------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  const saved = localStorage.getItem("nickname");
  if (saved) nicknameEl.value = saved;

  if (saved === ADMIN_NAME) {
    adminMenu.style.display = "block";
  }
});

//-----------------------------------------------------------
// 닉네임 저장
//-----------------------------------------------------------
saveNickBtn.addEventListener("click", () => {
  const nick = nicknameEl.value.trim();
  if (!nick) return alert("닉네임을 입력하세요.");
  localStorage.setItem("nickname", nick);

  if (nick === ADMIN_NAME) adminMenu.style.display = "block";
  else adminMenu.style.display = "none";

  alert("닉네임 저장됨");
});

//-----------------------------------------------------------
// 닉네임 변경
//-----------------------------------------------------------
changeNickBtn.addEventListener("click", () => {
  const now = nicknameEl.value;
  const n = prompt("새 닉네임 입력", now);
  if (n !== null) {
    nicknameEl.value = n;
    localStorage.setItem("nickname", n);
    if (n === ADMIN_NAME) adminMenu.style.display = "block";
    else adminMenu.style.display = "none";
  }
});

//-----------------------------------------------------------
// 관리자 로그인 (비밀번호 2회 입력)
//-----------------------------------------------------------
adminLoginBtn.addEventListener("click", () => {
  const nickname = nicknameEl.value;
  if (nickname !== ADMIN_NAME) return alert("관리자 닉네임이 아닙니다.");

  let pw1 = prompt("관리자 비밀번호 입력");
  if (!pw1) return;

  let pw2 = prompt("다시 한 번 비밀번호 입력");
  if (!pw2) return;

  if (pw1 !== pw2) return alert("두 비밀번호가 일치하지 않습니다.");

  socket.emit("adminLogin", { nickname, password: pw1 });
});

socket.on("adminSuccess", () => {
  isAdmin = true;
  alert("관리자 로그인 성공!");

  socket.emit("requestBanList");

  banListEl.style.display = "block";
});

socket.on("adminFailed", () => {
  alert("관리자 로그인 실패");
});

//-----------------------------------------------------------
// 방 목록 렌더링
//-----------------------------------------------------------
socket.on("roomList", (rooms) => {
  roomListEl.innerHTML = "";
  rooms.forEach((r) => {
    const div = document.createElement("div");
    div.className = "roomItem";

    div.innerHTML = `
      <b>${safeText(r.name)}</b> ${r.hasPassword ? "(비번)" : ""}<br>
      방장: ${safeText(r.owner)}
      <br>
      <button onclick="joinPrompt('${r.id}')">입장</button>
      ${
        localStorage.getItem("nickname") === r.owner
          ? `<button class="deleteBtn" onclick="deleteRoom('${r.id}')">삭제</button>`
          : ""
      }
    `;

    roomListEl.appendChild(div);
  });
});

// 검색 버튼
searchBtn.addEventListener("click", () => {
  socket.emit("searchRooms", searchEl.value);
});

//-----------------------------------------------------------
// 방 생성
//-----------------------------------------------------------
createRoomBtn.addEventListener("click", () => {
  const nick = nicknameEl.value.trim();
  if (!nick) return alert("닉네임을 먼저 저장하세요.");

  const name = document.getElementById("newRoomName").value.trim();
  const usePw = document.getElementById("usePassword").checked;
  const pw = document.getElementById("roomPassword").value;

  socket.emit("createRoom", {
    roomName: name,
    hasPassword: usePw,
    password: pw,
    nickname: nick,
  });
});

//-----------------------------------------------------------
// 방 참여
//-----------------------------------------------------------
window.joinPrompt = function (roomId) {
  const nickname = nicknameEl.value.trim();
  if (!nickname) return alert("닉네임을 먼저 입력하세요.");

  const pw = prompt("비밀번호 (필요 시 입력)");
  socket.emit("joinRoom", { roomId, nickname, password: pw });
};

socket.on("joinFailed", (msg) => {
  alert(msg);
  localStorage.removeItem("currentRoom");
});

socket.on("joinSuccess", (roomId) => {
  currentRoomId = roomId;
  chatContainer.style.display = "block";
  chatTitle.textContent = `방: ${roomId}`;
  localStorage.setItem("currentRoom", roomId);

  socket.emit("requestRoomUsers", roomId);
});

//-----------------------------------------------------------
// 채팅 기록 표시
//-----------------------------------------------------------
socket.on("chatHistory", (history) => {
  chatBox.innerHTML = "";
  history.forEach((item) => appendMessage(item));
  chatBox.scrollTop = chatBox.scrollHeight;
});

// 시스템 메시지
socket.on("systemMessage", (txt) => {
  const div = document.createElement("div");
  div.style.fontStyle = "italic";
  div.textContent = txt;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
});

//-----------------------------------------------------------
// 접속자 목록
//-----------------------------------------------------------
socket.on("roomUsers", (users) => {
  roomUsersEl.innerHTML = "";
  const myNick = nicknameEl.value.trim();

  users.forEach((u) => {
    const div = document.createElement("div");
    div.textContent = u;

    if (isAdmin && u !== ADMIN_NAME) {
      const b = document.createElement("button");
      b.className = "adminBtn";
      b.textContent = "밴";
      b.onclick = () => {
        if (confirm(`${u} 님을 밴하시겠습니까?`)) {
          socket.emit("banUser", { targetNick: u });
        }
      };
      div.appendChild(b);
    }

    roomUsersEl.appendChild(div);
  });
});

//-----------------------------------------------------------
// 밴 목록
//-----------------------------------------------------------
socket.on("banList", (list) => {
  banListEl.innerHTML = "";
  list.forEach((ip) => {
    const div = document.createElement("div");
    div.textContent = ip;
    banListEl.appendChild(div);
  });
});

socket.on("banned", (msg) => {
  alert(msg || "밴되었습니다.");
  localStorage.clear();
  location.reload();
});

//-----------------------------------------------------------
// 메시지 전송
//-----------------------------------------------------------
sendBtn.addEventListener("click", sendText);
function sendText() {
  const nick = nicknameEl.value.trim();
  const txt = msgInput.value.trim();
  if (!currentRoomId) return alert("방에 먼저 입장하세요");

  socket.emit("sendMessage", {
    roomId: currentRoomId,
    nickname: nick,
    message: txt,
    type: "text",
  });

  msgInput.value = "";
}

//-----------------------------------------------------------
// 파일 업로드
//-----------------------------------------------------------
uploadBtn.addEventListener("click", () => {
  const f = document.getElementById("fileInput").files[0];
  if (!f) return alert("파일을 선택하세요");

  const fd = new FormData();
  fd.append("file", f);

  fetch("/upload", { method: "POST", body: fd })
    .then((r) => r.json())
    .then((data) => {
      const nick = nicknameEl.value.trim();
      socket.emit("sendMessage", {
        roomId: currentRoomId,
        nickname: nick,
        message: data,
        type: "file",
      });
    })
    .catch(() => alert("업로드 실패"));
});

//-----------------------------------------------------------
// 메시지 출력 함수
//-----------------------------------------------------------
socket.on("newMessage", appendMessage);

function appendMessage(item) {
  const div = document.createElement("div");
  const t = new Date(item.time).toLocaleTimeString();

  if (item.type === "text") {
    div.textContent = `${t} ${item.nickname}: ${item.message}`;
  } else if (item.type === "file") {
    const m = item.message;

    if (m.mime?.startsWith("image")) {
      div.innerHTML = `${t} ${item.nickname}:<br><img src="${m.url}" style="max-width:200px;">`;
    } else if (m.mime?.startsWith("video")) {
      div.innerHTML = `${t} ${item.nickname}:<br><video src="${m.url}" controls style="max-width:260px;"></video>`;
    } else {
      div.innerHTML = `${t} ${item.nickname}: <a href="${m.url}" download>파일 다운로드</a>`;
    }
  }

  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

//-----------------------------------------------------------
// 방 삭제 (방장 전용)
//-----------------------------------------------------------
window.deleteRoom = function (roomId) {
  const nick = nicknameEl.value.trim();
  if (!nick) return;

  if (confirm("정말 이 방을 삭제하시겠습니까?")) {
    socket.emit("deleteRoom", { roomId, nickname: nick });
  }
};

//-----------------------------------------------------------
// 방 나가기
//-----------------------------------------------------------
leaveBtn.addEventListener("click", () => {
  const nick = nicknameEl.value.trim();

  socket.emit("leaveRoom", { roomId: currentRoomId, nickname: nick });

  currentRoomId = null;
  chatContainer.style.display = "none";
  localStorage.removeItem("currentRoom");
});

//-----------------------------------------------------------
// 자동 재입장
//-----------------------------------------------------------
window.addEventListener("load", () => {
  const savedRoom = localStorage.getItem("currentRoom");
  const savedNick = localStorage.getItem("nickname");

  if (savedRoom && savedNick) {
    socket.emit("joinRoom", { roomId: savedRoom, nickname: savedNick });
  }
});
