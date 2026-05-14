function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  })
}

export class UserStore {
  constructor(state, env) {
    this.state = state
  }

  async fetch(request) {
    const url = new URL(request.url)

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" },
      })
    }

    if (url.pathname === "/api/register" && request.method === "POST") {
      const body = await request.json()
      const { username, password, role } = body
      if (!username || !password || !role) return json({ error: "缺少必填字段" }, 400)
      if (!["teacher", "student"].includes(role)) return json({ error: "角色无效" }, 400)

      let users = await this.state.storage.get("users") || {}
      if (users[username]) return json({ error: "用户名已存在" }, 409)

      users[username] = { password, role }
      await this.state.storage.put("users", users)
      return json({ success: true, message: "注册成功" })
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      const body = await request.json()
      const { username, password } = body
      if (!username || !password) return json({ error: "缺少用户名或密码" }, 400)

      let users = await this.state.storage.get("users") || {}
      const user = users[username]
      if (!user || user.password !== password) return json({ error: "用户名或密码错误" }, 401)

      let tokens = await this.state.storage.get("tokens") || {}
      const token = crypto.randomUUID()
      tokens[token] = { username, role: user.role, expires: Date.now() + 86400000 * 7 }
      await this.state.storage.put("tokens", tokens)

      return json({ token, username, role: user.role, message: "登录成功" })
    }

    if (url.pathname === "/api/verify" && request.method === "GET") {
      const token = url.searchParams.get("token")
      if (!token) return json({ valid: false }, 401)

      let tokens = await this.state.storage.get("tokens") || {}
      const info = tokens[token]
      if (!info || info.expires < Date.now()) return json({ valid: false }, 401)

      return json({ valid: true, username: info.username, role: info.role })
    }

    return json({ error: "Not found" }, 404)
  }
}

export class ClassroomRoom {
  constructor(state, env) {
    this.state = state
    this.sessions = new Map()
    this.pendingUsers = new Map()
    this.question = ""
    this.answers = []
    this.teacherAnswer = ""
  }

  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === "/ws") {
      const userName = request.headers.get("X-User-Name") || "anonymous"
      const userRole = request.headers.get("X-User-Role") || "student"

      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)

      this.pendingUsers.set(server, { name: userName, role: userRole })
      this.state.acceptWebSocket(server)

      return new Response(null, { status: 101, webSocket: client })
    }

    return new Response("Not found", { status: 404 })
  }

  async webSocketMessage(ws, message) {
    let data
    try { data = JSON.parse(message) } catch (e) { return }

    const pending = this.pendingUsers.get(ws)
    if (pending) {
      this.sessions.set(ws, pending)
      this.pendingUsers.delete(ws)
    }

    const session = this.sessions.get(ws)

    switch (data.type) {
      case "join": {
        if (!session) {
          this.sessions.set(ws, { name: data.name || "anonymous", role: data.role || "student" })
        }
        const s = this.sessions.get(ws)
        ws.send(JSON.stringify({
          type: "sync",
          question: this.question,
          answers: this.answers,
          teacherAnswer: this.teacherAnswer,
          myRole: s.role,
          myName: s.name,
        }))
        this.broadcastUserCount()
        break
      }

      case "set_question": {
        if (!session || session.role !== "teacher") {
          ws.send(JSON.stringify({ type: "error", message: "只有老师可以发布题目" }))
          return
        }
        this.question = data.question
        this.broadcast({ type: "question_update", question: this.question })
        break
      }

      case "teacher_answer": {
        if (!session || session.role !== "teacher") {
          ws.send(JSON.stringify({ type: "error", message: "只有老师可以作答" }))
          return
        }
        this.teacherAnswer = data.answer
        this.broadcast({ type: "teacher_answer_update", teacherAnswer: this.teacherAnswer })
        break
      }

      case "submit_answer": {
        if (!session) return
        const answer = {
          id: Date.now().toString() + Math.random().toString(36).slice(2, 8),
          name: session.name,
          role: session.role,
          text: data.answer,
          time: new Date().toLocaleTimeString("zh-CN"),
        }
        this.answers.unshift(answer)
        if (this.answers.length > 200) {
          this.answers = this.answers.slice(0, 200)
        }
        this.broadcast({ type: "new_answer", answer })
        break
      }

      case "clear_answers": {
        if (!session || session.role !== "teacher") {
          ws.send(JSON.stringify({ type: "error", message: "只有老师可以清空答案" }))
          return
        }
        this.answers = []
        this.broadcast({ type: "answers_cleared" })
        break
      }

      case "clear_question": {
        if (!session || session.role !== "teacher") {
          ws.send(JSON.stringify({ type: "error", message: "只有老师可以清空题目" }))
          return
        }
        this.question = ""
        this.teacherAnswer = ""
        this.broadcast({ type: "question_cleared" })
        break
      }
    }
  }

  async webSocketClose(ws) {
    this.sessions.delete(ws)
    this.pendingUsers.delete(ws)
    this.broadcastUserCount()
  }

  broadcast(msg) {
    const text = JSON.stringify(msg)
    for (const ws of this.sessions.keys()) {
      try { ws.send(text) } catch (e) { /* ignore */ }
    }
  }

  broadcastUserCount() {
    const users = []
    for (const s of this.sessions.values()) {
      users.push({ name: s.name, role: s.role })
    }
    this.broadcast({ type: "user_count", count: this.sessions.size, users })
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      })
    }

    const userStoreId = env.USER_STORE.idFromName("global")
    const userStore = env.USER_STORE.get(userStoreId)

    if (url.pathname === "/api/register" || url.pathname === "/api/login") {
      return userStore.fetch(request)
    }

    if (url.pathname === "/ws") {
      const token = url.searchParams.get("token")
      if (!token) {
        return new Response("请先登录", { status: 401 })
      }

      const verifyUrl = new URL("http://internal/api/verify")
      verifyUrl.searchParams.set("token", token)
      const verifyReq = new Request(verifyUrl.toString())
      const verifyResp = await userStore.fetch(verifyReq)
      const verifyData = await verifyResp.json()

      if (!verifyData.valid) {
        return new Response("登录已过期，请重新登录", { status: 401 })
      }

      const headers = new Headers(request.headers)
      headers.set("X-User-Name", verifyData.username)
      headers.set("X-User-Role", verifyData.role)

      const roomId = url.searchParams.get("room") || "default"
      const classId = env.CLASSROOM.idFromName(roomId)
      const classStub = env.CLASSROOM.get(classId)

      const newReq = new Request(request.url, {
        method: request.method,
        headers: headers,
      })
      return classStub.fetch(newReq)
    }

    return env.ASSETS.fetch(request)
  },
}
