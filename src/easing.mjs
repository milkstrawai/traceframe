// The browser pointer moves along this curve, and the rendered cursor is drawn along the same one.
export function easeOutCubic(progress) {
  return 1 - (1 - progress) ** 3
}

// easeOutCubic as an FFmpeg expression, given the progress as an expression.
export function easeOutCubicExpression(progress) {
  return `(1-pow(1-${progress},3))`
}
