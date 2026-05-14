export class ClassroomHandler {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
    this.ready = false
  }

  firstRow(query, ...params) {
    const rows = this.ctx.storage.sql.exec(query, ...params).toArray()
    return rows.length > 0 ? rows[0] : null
  }

  async ensureReady() {
    if (this.ready) return
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        role TEXT NOT NULL
      )
    `)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        username TEXT NOT NULL
      )
    `)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS question (
        id INTEGER PRIMARY KEY DEFAULT 1,
        text TEXT NOT NULL,
        set_by TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS answers (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        answer TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `)
    const row = this.firstRow("SELECT text FROM question WHERE id = 1")
    if (!row) {
      this.ctx.storage.sql.exec(
        "INSERT INTO question (id, text, set_by, timestamp) VALUES (1, '请等待老师出题...', '', ?)",
        Date.now()
      )
    }
    this.ready = true
  }

  async fetch(request) {
    const body = await request.json()
    const { action } = body

    await this.ensureReady()

    switch (action) {
      case 'register':
        return this.handleRegister(body)
      case 'login':
        return this.handleLogin(body)
      case 'getQuestion':
        return this.handleGetQuestion()
      case 'setQuestion':
        return this.handleSetQuestion(body)
      case 'submitAnswer':
        return this.handleSubmitAnswer(body)
      case 'getAnswers':
        return this.handleGetAnswers()
      case 'clearAnswers':
        return this.handleClearAnswers(body)
      case 'getMe':
        return this.handleGetMe(body)
      case 'getOnlineCount':
        return this.handleGetOnlineCount()
      default:
        return json({ error: '未知操作' }, 404)
    }
  }

  async handleRegister(body) {
    const { username, password, role } = body

    const existing = this.firstRow(
      "SELECT username FROM users WHERE username = ?", username
    )
    if (existing) {
      return json({ error: '用户名已存在' }, 409)
    }

    this.ctx.storage.sql.exec(
      "INSERT INTO users (username, password, role) VALUES (?, ?, ?)",
      username, password, role
    )

    const token = crypto.randomUUID()
    this.ctx.storage.sql.exec(
      "INSERT INTO sessions (token, username) VALUES (?, ?)",
      token, username
    )

    return json({ token, role, username }, 201)
  }

  async handleLogin(body) {
    const { username, password } = body

    const user = this.firstRow(
      "SELECT username, password, role FROM users WHERE username = ?", username
    )

    if (!user || user.password !== password) {
      return json({ error: '用户名或密码错误' }, 401)
    }

    const token = crypto.randomUUID()
    this.ctx.storage.sql.exec(
      "INSERT INTO sessions (token, username) VALUES (?, ?)",
      token, username
    )

    return json({ token, role: user.role, username })
  }

  async handleGetQuestion() {
    const row = this.firstRow(
      "SELECT text, set_by, timestamp FROM question WHERE id = 1"
    )

    if (!row) {
      return json({ text: '请等待老师出题...', setBy: '', timestamp: Date.now() })
    }

    return json({ text: row.text, setBy: row.set_by, timestamp: row.timestamp })
  }

  async handleSetQuestion(body) {
    const { token, question } = body

    const user = this.getUserFromToken(token)
    if (!user) return json({ error: '请先登录' }, 401)
    if (user.role !== 'teacher') return json({ error: '仅教师可设置题目' }, 403)

    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO question (id, text, set_by, timestamp) VALUES (1, ?, ?, ?)",
      question, user.username, Date.now()
    )

    return json({ text: question, setBy: user.username, timestamp: Date.now() })
  }

  async handleSubmitAnswer(body) {
    const { token, answer } = body

    const user = this.getUserFromToken(token)
    if (!user) return json({ error: '请先登录' }, 401)
    if (user.role !== 'student') return json({ error: '仅学生可提交答案' }, 403)

    const id = crypto.randomUUID()
    const ts = Date.now()
    this.ctx.storage.sql.exec(
      "INSERT INTO answers (id, username, answer, timestamp) VALUES (?, ?, ?, ?)",
      id, user.username, answer, ts
    )

    // 超过 200 条清旧数据
    const count = this.firstRow("SELECT COUNT(*) as c FROM answers")
    if (count && count.c > 200) {
      this.ctx.storage.sql.exec(
        "DELETE FROM answers WHERE id NOT IN (SELECT id FROM answers ORDER BY timestamp DESC LIMIT 200)"
      )
    }

    return json({ id, username: user.username, answer, timestamp: ts }, 201)
  }

  async handleGetAnswers() {
    const rows = this.ctx.storage.sql.exec(
      "SELECT id, username, answer, timestamp FROM answers ORDER BY timestamp DESC LIMIT 200"
    ).toArray()

    return json(rows.map(r => ({
      id: r.id,
      username: r.username,
      answer: r.answer,
      timestamp: r.timestamp,
    })))
  }

  async handleClearAnswers(body) {
    const { token } = body

    const user = this.getUserFromToken(token)
    if (!user) return json({ error: '请先登录' }, 401)
    if (user.role !== 'teacher') return json({ error: '仅教师可清空答案' }, 403)

    this.ctx.storage.sql.exec("DELETE FROM answers")
    return json({ success: true })
  }

  async handleGetMe(body) {
    const { token } = body

    const user = this.getUserFromToken(token)
    if (!user) return json({ error: '未登录' }, 401)

    return json({ username: user.username, role: user.role })
  }

  async handleGetOnlineCount() {
    const result = this.ctx.storage.sql.exec(
      "SELECT u.role, COUNT(DISTINCT s.username) as cnt FROM sessions s INNER JOIN users u ON s.username = u.username GROUP BY u.role"
    ).toArray()

    let students = 0
    let teachers = 0
    for (const r of result) {
      if (r.role === 'student') students = r.cnt
      if (r.role === 'teacher') teachers = r.cnt
    }

    return json({ students, teachers, total: students + teachers })
  }

  getUserFromToken(token) {
    if (!token) return null
    const row = this.firstRow(
      "SELECT u.username, u.role FROM sessions s INNER JOIN users u ON s.username = u.username WHERE s.token = ?", token
    )
    return row || null
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    if (!path.startsWith('/api/')) {
      return env.ASSETS.fetch(request)
    }

    const doId = env.CLASSROOM.idFromName('main')
    const stub = env.CLASSROOM.get(doId)

    try {
      let body
      let token = null

      const auth = request.headers.get('Authorization')
      if (auth && auth.startsWith('Bearer ')) {
        token = auth.slice(7)
      }

      if (request.method === 'POST' || request.method === 'PUT') {
        body = await request.json()
      }

      let doBody = {}

      if (path === '/api/register') {
        if (!body.username || !body.password || !body.role) {
          return json2({ error: '请填写所有字段' }, 400, corsHeaders)
        }
        if (body.username.length < 2 || body.username.length > 20) {
          return json2({ error: '用户名长度需在2-20个字符之间' }, 400, corsHeaders)
        }
        if (body.password.length < 4) {
          return json2({ error: '密码长度至少4位' }, 400, corsHeaders)
        }
        if (!['student', 'teacher'].includes(body.role)) {
          return json2({ error: '无效的身份类型' }, 400, corsHeaders)
        }
        doBody = { action: 'register', username: body.username, password: body.password, role: body.role }
      } else if (path === '/api/login') {
        if (!body.username || !body.password) {
          return json2({ error: '请输入用户名和密码' }, 400, corsHeaders)
        }
        doBody = { action: 'login', username: body.username, password: body.password }
      } else if (path === '/api/question' && request.method === 'GET') {
        doBody = { action: 'getQuestion' }
      } else if (path === '/api/question' && request.method === 'POST') {
        if (!body.question || !body.question.trim()) {
          return json2({ error: '题目不能为空' }, 400, corsHeaders)
        }
        doBody = { action: 'setQuestion', token, question: body.question.trim() }
      } else if (path === '/api/answer') {
        if (!body.answer || !body.answer.trim()) {
          return json2({ error: '答案不能为空' }, 400, corsHeaders)
        }
        doBody = { action: 'submitAnswer', token, answer: body.answer.trim() }
      } else if (path === '/api/answers' && request.method === 'GET') {
        doBody = { action: 'getAnswers' }
      } else if (path === '/api/answers' && request.method === 'DELETE') {
        doBody = { action: 'clearAnswers', token }
      } else if (path === '/api/me') {
        doBody = { action: 'getMe', token }
      } else if (path === '/api/online') {
        doBody = { action: 'getOnlineCount' }
      } else {
        return json2({ error: '未知请求' }, 404, corsHeaders)
      }

      const doReq = new Request('http://do/action', {
        method: 'POST',
        body: JSON.stringify(doBody),
      })
      const doRes = await stub.fetch(doReq)

      return new Response(doRes.body, {
        status: doRes.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    } catch (err) {
      return json2({ error: '服务器错误: ' + err.message }, 500, corsHeaders)
    }
  },
}

function json2(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}
