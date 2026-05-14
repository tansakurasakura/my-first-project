function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  })
}

function corsPreflight() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  })
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("")
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

async function handleRegister(env, body) {
  const { username, password, role } = body || {}
  if (!username || !password || !role) return json({ error: "缺少必填字段" }, 400)
  if (!["teacher", "student"].includes(role)) return json({ error: "角色无效" }, 400)
  if (username.length > 32 || password.length > 128) return json({ error: "用户名或密码过长" }, 400)

  const hash = await sha256(password)
  try {
    await env.DB.prepare(
      "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)"
    ).bind(username, hash, role, Date.now()).run()
  } catch (e) {
    const msg = String(e?.message || e)
    if (msg.includes("UNIQUE") || msg.includes("constraint")) return json({ error: "用户名已存在" }, 409)
    return json({ error: "注册失败" }, 500)
  }
  return json({ success: true, message: "注册成功" })
}

async function handleLogin(env, body) {
  const { username, password } = body || {}
  if (!username || !password) return json({ error: "缺少用户名或密码" }, 400)

  const hash = await sha256(password)
  const user = await env.DB.prepare(
    "SELECT username, role FROM users WHERE username = ? AND password_hash = ?"
  ).bind(username, hash).first()
  if (!user) return json({ error: "用户名或密码错误" }, 401)

  const token = crypto.randomUUID()
  const expires = Date.now() + 7 * 86400000
  await env.DB.prepare(
    "INSERT INTO tokens (token, username, role, expires) VALUES (?, ?, ?, ?)"
  ).bind(token, user.username, user.role, expires).run()

  return json({ token, username: user.username, role: user.role, message: "登录成功" })
}

async function verifyToken(env, token) {
  if (!token) return null
  const row = await env.DB.prepare(
    "SELECT username, role, expires FROM tokens WHERE token = ?"
  ).bind(token).first()
  if (!row) return null
  if (row.expires < Date.now()) {
    await env.DB.prepare("DELETE FROM tokens WHERE token = ?").bind(token).run().catch(() => {})
    return null
  }
  return { username: row.username, role: row.role }
}

export class ClassroomRoom {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.sessions = new Map()
    this.pendingUsers = new Map()
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

    try {
      await this.handle(ws, session, data)
    } catch (e) {
      try { ws.send(JSON.stringify({ type: "error", message: "服务器错误: " + (e?.message || e) })) } catch (_) {}
    }
  }

  async handle(ws, session, data) {
    const db = this.env.DB

    switch (data.type) {
      case "join": {
        if (!session) {
          this.sessions.set(ws, { name: data.name || "anonymous", role: data.role || "student" })
        }
        const s = this.sessions.get(ws)

        const st = await db.prepare("SELECT question, teacher_answer FROM classroom_state WHERE id = 1").first()
        const ansRes = await db.prepare(
          "SELECT id, name, role, text, time FROM classroom_answers ORDER BY created_at DESC LIMIT 200"
        ).all()
        const postRes = await db.prepare(
          "SELECT id, title, author_name, author_role, created_at, reply_count, last_reply_at FROM forum_posts ORDER BY last_reply_at DESC, created_at DESC LIMIT 100"
        ).all()

        ws.send(JSON.stringify({
          type: "sync",
          question: st?.question || "",
          teacherAnswer: st?.teacher_answer || "",
          answers: (ansRes?.results || []),
          posts: (postRes?.results || []).map(p => ({
            id: p.id, title: p.title,
            authorName: p.author_name, authorRole: p.author_role,
            createdAt: p.created_at, replyCount: p.reply_count, lastReplyAt: p.last_reply_at,
          })),
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
        const q = String(data.question || "").slice(0, 500)
        await db.prepare("UPDATE classroom_state SET question = ?, updated_at = ? WHERE id = 1")
          .bind(q, Date.now()).run()
        this.broadcast({ type: "question_update", question: q })
        break
      }

      case "teacher_answer": {
        if (!session || session.role !== "teacher") {
          ws.send(JSON.stringify({ type: "error", message: "只有老师可以作答" }))
          return
        }
        const a = String(data.answer || "").slice(0, 500)
        await db.prepare("UPDATE classroom_state SET teacher_answer = ?, updated_at = ? WHERE id = 1")
          .bind(a, Date.now()).run()
        this.broadcast({ type: "teacher_answer_update", teacherAnswer: a })
        break
      }

      case "submit_answer": {
        if (!session) return
        const text = String(data.answer || "").slice(0, 500)
        if (!text) return
        const ans = {
          id: newId(),
          name: session.name,
          role: session.role,
          text,
          time: new Date().toLocaleTimeString("zh-CN"),
        }
        await db.prepare(
          "INSERT INTO classroom_answers (id, name, role, text, time, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(ans.id, ans.name, ans.role, ans.text, ans.time, Date.now()).run()
        await db.prepare(
          "DELETE FROM classroom_answers WHERE id NOT IN (SELECT id FROM classroom_answers ORDER BY created_at DESC LIMIT 200)"
        ).run()
        this.broadcast({ type: "new_answer", answer: ans })
        break
      }

      case "clear_answers": {
        if (!session || session.role !== "teacher") {
          ws.send(JSON.stringify({ type: "error", message: "只有老师可以清空答案" }))
          return
        }
        await db.prepare("DELETE FROM classroom_answers").run()
        this.broadcast({ type: "answers_cleared" })
        break
      }

      case "clear_question": {
        if (!session || session.role !== "teacher") {
          ws.send(JSON.stringify({ type: "error", message: "只有老师可以清空题目" }))
          return
        }
        await db.prepare("UPDATE classroom_state SET question = '', teacher_answer = '', updated_at = ? WHERE id = 1")
          .bind(Date.now()).run()
        this.broadcast({ type: "question_cleared" })
        break
      }

      case "create_post": {
        if (!session) return
        const title = String(data.title || "").trim().slice(0, 200)
        const content = String(data.content || "").trim().slice(0, 5000)
        if (!title) {
          ws.send(JSON.stringify({ type: "error", message: "标题不能为空" }))
          return
        }
        const now = Date.now()
        const post = {
          id: newId(),
          title, content,
          authorName: session.name,
          authorRole: session.role,
          createdAt: now,
          replyCount: 0,
          lastReplyAt: now,
        }
        await db.prepare(
          "INSERT INTO forum_posts (id, title, content, author_name, author_role, created_at, reply_count, last_reply_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)"
        ).bind(post.id, title, content, session.name, session.role, now, now).run()
        this.broadcast({ type: "new_post", post: {
          id: post.id, title: post.title,
          authorName: post.authorName, authorRole: post.authorRole,
          createdAt: post.createdAt, replyCount: 0, lastReplyAt: post.lastReplyAt,
        }})
        break
      }

      case "load_post": {
        if (!session) return
        const postId = String(data.postId || "")
        const post = await db.prepare(
          "SELECT id, title, content, author_name, author_role, created_at FROM forum_posts WHERE id = ?"
        ).bind(postId).first()
        if (!post) {
          ws.send(JSON.stringify({ type: "error", message: "帖子不存在或已删除" }))
          return
        }
        const replies = await db.prepare(
          "SELECT id, content, author_name, author_role, created_at FROM forum_replies WHERE post_id = ? ORDER BY created_at ASC"
        ).bind(postId).all()
        ws.send(JSON.stringify({
          type: "post_detail",
          post: {
            id: post.id, title: post.title, content: post.content,
            authorName: post.author_name, authorRole: post.author_role,
            createdAt: post.created_at,
          },
          replies: (replies?.results || []).map(r => ({
            id: r.id, content: r.content,
            authorName: r.author_name, authorRole: r.author_role,
            createdAt: r.created_at,
          })),
        }))
        break
      }

      case "create_reply": {
        if (!session) return
        const postId = String(data.postId || "")
        const content = String(data.content || "").trim().slice(0, 2000)
        if (!content) {
          ws.send(JSON.stringify({ type: "error", message: "回复内容不能为空" }))
          return
        }
        const exists = await db.prepare("SELECT id FROM forum_posts WHERE id = ?").bind(postId).first()
        if (!exists) {
          ws.send(JSON.stringify({ type: "error", message: "帖子不存在或已删除" }))
          return
        }
        const now = Date.now()
        const reply = {
          id: newId(),
          postId,
          content,
          authorName: session.name,
          authorRole: session.role,
          createdAt: now,
        }
        await db.batch([
          db.prepare(
            "INSERT INTO forum_replies (id, post_id, content, author_name, author_role, created_at) VALUES (?, ?, ?, ?, ?, ?)"
          ).bind(reply.id, postId, content, session.name, session.role, now),
          db.prepare(
            "UPDATE forum_posts SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?"
          ).bind(now, postId),
        ])
        this.broadcast({ type: "new_reply", reply, postId, lastReplyAt: now })
        break
      }

      case "delete_post": {
        if (!session) return
        const postId = String(data.postId || "")
        const post = await db.prepare("SELECT author_name FROM forum_posts WHERE id = ?").bind(postId).first()
        if (!post) return
        if (session.role !== "teacher" && post.author_name !== session.name) {
          ws.send(JSON.stringify({ type: "error", message: "无权删除此帖" }))
          return
        }
        await db.batch([
          db.prepare("DELETE FROM forum_replies WHERE post_id = ?").bind(postId),
          db.prepare("DELETE FROM forum_posts WHERE id = ?").bind(postId),
        ])
        this.broadcast({ type: "post_deleted", postId })
        break
      }
    }
  }

  async webSocketClose(ws) {
    this.sessions.delete(ws)
    this.pendingUsers.delete(ws)
    this.broadcastUserCount()
  }

  async webSocketError(ws) {
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

    if (request.method === "OPTIONS") return corsPreflight()

    if (url.pathname === "/api/register" && request.method === "POST") {
      return handleRegister(env, await request.json().catch(() => ({})))
    }
    if (url.pathname === "/api/login" && request.method === "POST") {
      return handleLogin(env, await request.json().catch(() => ({})))
    }

    if (url.pathname === "/ws") {
      const token = url.searchParams.get("token")
      const user = await verifyToken(env, token)
      if (!user) return new Response("请先登录", { status: 401 })

      const headers = new Headers(request.headers)
      headers.set("X-User-Name", user.username)
      headers.set("X-User-Role", user.role)

      const roomId = url.searchParams.get("room") || "default"
      const classId = env.CLASSROOM.idFromName(roomId)
      const classStub = env.CLASSROOM.get(classId)

      const newReq = new Request(request.url, { method: request.method, headers })
      return classStub.fetch(newReq)
    }

    return env.ASSETS.fetch(request)
  },
}
