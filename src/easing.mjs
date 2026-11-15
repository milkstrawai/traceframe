// The browser pointer moves along this curve, and the rendered cursor is drawn along the same one.
export function easeOutCubic(progress) {
  return 1 - (1 - progress) ** 3
}

// The point `progress` (0 to 1) of the way along an eased move.
export function easePoint(from, to, progress) {
  const eased = easeOutCubic(progress)
  return { x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased }
}

// easeOutCubic as an FFmpeg expression, given the progress as an expression.
export function easeOutCubicExpression(progress) {
  return `(1-pow(1-${progress},3))`
}
