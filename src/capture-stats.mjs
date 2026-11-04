// Delivery cadence describes Chromium's exported frames. It cannot establish
// distinct pixels or smoothness: a static page legitimately sends few frames.
export function createCaptureStats() {
  let framesReceived = 0, earliestTimestamp, latestTimestamp, lastDelivery
  let maxFrameGapMs = 0, maxDeliveryGapMs = 0, outOfOrderFrames = 0
  return {
    observe(timestamp, delivery) {
      if (framesReceived === 0) earliestTimestamp = latestTimestamp = timestamp
      else {
        earliestTimestamp = Math.min(earliestTimestamp, timestamp)
        if (timestamp < latestTimestamp) outOfOrderFrames++
        else {
          maxFrameGapMs = Math.max(maxFrameGapMs, timestamp - latestTimestamp)
          latestTimestamp = timestamp
        }
        maxDeliveryGapMs = Math.max(maxDeliveryGapMs, delivery - lastDelivery)
      }
      lastDelivery = delivery
      framesReceived++
    },
    summary() {
      const sourceSpanSeconds = framesReceived > 1 ? (latestTimestamp - earliestTimestamp) / 1000 : 0
      return {
        framesReceived,
        sourceSpanSeconds,
        receivedFps: sourceSpanSeconds > 0 ? (framesReceived - 1) / sourceSpanSeconds : 0,
        maxFrameGapMs,
        maxDeliveryGapMs,
        outOfOrderFrames,
      }
    },
  }
}
