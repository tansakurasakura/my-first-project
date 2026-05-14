export class ClassroomRoom {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.sessions = new Map()
    this.question = ""
    this.answers = []
    this.teacherAnswer = ""
  }

  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      this.state.acceptWebSocket(server)
      return new Response(null, { status: 101, webSocket: client })
    }

    return new Response("Not found", { status: 404 })
  }

  async webSocketMessage(ws, message) {
    const data = JSON.parse(message)

    switch (data.type) {
      case "join": {
        this.sessions.set(ws, {
          role: data.role,
          name: data.name || data.role,
        })
        ws.send(JSON.stringify({
          type: "sync",
          question: this.question,
          answers: this.answers,
          teacherAnswer: this.teacherAnswer,
        }))
        this.broadcast({ type: "user_count", count: this.sessions.size })
        break
      }

      case "set_question": {
        const session = this.sessions.get(ws)
        if (!session || session.role !== "teacher") {
          ws.send(JSON.stringify({ type: "error", message: "只有老师可以发布题目" }))
          return
        }
        this.question = data.question
        this.broadcast({ type: "question_update", question: this.question })
        break
      }

      case "teacher_answer": {
        const session = this.sessions.get(ws)
        if (!session || session.role !== "teacher") {
          ws.send(JSON.stringify({ type: "error", message: "只有老师可以作答" }))
          return
        }
        this.teacherAnswer = data.answer
        this.broadcast({ type: "teacher_answer_update", teacherAnswer: this.teacherAnswer })
        break
      }

      case "submit_answer": {
        const session = this.sessions.get(ws)
        if (!session) return
        const answer = {
          id: Date.now().toString(),
          name: session.name,
          role: session.role,
          text: data.answer,
          time: new Date().toLocaleTimeString("zh-CN"),
        }
        this.answers.unshift(answer)
        if (this.answers.length > 100) {
          this.answers = this.answers.slice(0, 100)
        }
        this.broadcast({ type: "new_answer", answer })
        break
      }

      case "clear_answers": {
        const session = this.sessions.get(ws)
        if (!session || session.role !== "teacher") {
          ws.send(JSON.stringify({ type: "error", message: "只有老师可以清空答案" }))
          return
        }
        this.answers = []
        this.broadcast({ type: "answers_cleared" })
        break
      }
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    this.sessions.delete(ws)
    this.broadcast({ type: "user_count", count: this.sessions.size })
  }

  broadcast(msg) {
    const text = JSON.stringify(msg)
    for (const ws of this.sessions.keys()) {
      try {
        ws.send(text)
      } catch (e) {
        // ignore disconnected clients
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === "/ws") {
      const roomId = url.searchParams.get("room") || "default"
      const id = env.CLASSROOM.idFromName(roomId)
      const stub = env.CLASSROOM.get(id)
      return stub.fetch(request)
    }

    if (url.pathname === "/" || url.pathname === "") {
      return env.ASSETS.fetch(request)
    }

    return env.ASSETS.fetch(request)
  },
}
