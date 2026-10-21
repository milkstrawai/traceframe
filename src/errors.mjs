export class TraceframeError extends Error {
  constructor(message, { code, ...options } = {}) {
    super(message, options)
    this.name = 'TraceframeError'
    this.code = code
  }
}
