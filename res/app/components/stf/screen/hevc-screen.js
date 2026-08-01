/**
 * HEVC/WebCodecs decoder for iOS devices served by mcloud-ios-agent.
 *
 * The agent streams hardware-encoded HEVC straight off the device's
 * CoreDevice display service instead of MJPEG from WebDriverAgent, so there is
 * no server-side transcode anywhere in the pipeline and the browser's own
 * hardware decoder does the work.
 *
 * PROTOCOL (see agent/screen_ws.py)
 *
 *   1. First message, text/JSON — the decoder configuration:
 *
 *        {"type": "codec", "codec": "hev1.1.6.L120.90", "description": "<base64 hvcC>"}
 *
 *      `description` is an hvcC decoder-configuration record. Passing it to
 *      VideoDecoder keeps parameter sets out-of-band and payloads as
 *      length-prefixed NALUs; the Annex-B start-code path tears under motion
 *      in Chrome.
 *
 *   2. Every later message, binary — one access unit prefixed by a type byte:
 *
 *        0 = key (IDR)
 *        1 = delta
 *        2 = key WITH RESET — the server detected an upstream drop, so the
 *            decoder's reference state may be silently stale. Rebuild before
 *            decoding. VideoToolbox renders torn frames without ever firing
 *            its error callback, which is the failure this guards against.
 *
 * SEPARATION OF CONCERNS
 *
 * This module owns the decode pipeline only: protocol parsing, decoder
 * lifecycle, resolution-collapse detection, and rAF coalescing. It never
 * touches the canvas. Painting stays in screen-directive.js, which already
 * owns canvas sizing, retina scaling and rotation — duplicating that here
 * would put two writers on the same canvas.
 *
 * REQUIREMENTS
 *
 * - HEVC decode in WebCodecs. Safari has it; Chrome enables it when the host
 *   OS decoder does. There is deliberately no software fallback.
 * - A secure context: browsers refuse WebCodecs over plain http from any
 *   non-loopback origin, so the farm must be served over https.
 */

/* global VideoDecoder, EncodedVideoChunk */

/**
 * Height of the scratch canvas used to find the collapse boundary.
 *
 * This runs on every decoded frame, and getImageData() is a synchronous GPU
 * readback — the main thread blocks until the pixels come back. At 344 (the
 * value pymobiledevice3's standalone viewer uses) a 1264x2752 frame means a
 * 158x344 readback, ~217KB, plus ~27k sampling iterations, sixty times a
 * second. That is affordable on a bare viewer page and much less so on STF's,
 * where Angular and the rest of the UI share the thread. It matters beyond
 * smoothness: a main thread that falls behind stops draining the screen
 * socket, and the frames the agent sheds in response cost a decoder resync.
 *
 * All we need is one edge between content and flat gray padding. At 192 the
 * same frame is an 88x192 readback (~68KB) and ~8k iterations — 3x cheaper —
 * and still locates the edge to ~1% of the frame width, which is well inside
 * what the subsequent stretch can show.
 */
const DETECTION_HEIGHT = 192

function base64ToBytes(b64) {
  const raw = atob(b64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw.charCodeAt(i)
  }
  return out
}

/**
 * True if `data` is the agent's codec handshake.
 *
 * Parses rather than string-matching: the socket also carries STF's own text
 * frames ('secure_on', 'start {...}', the legacy 'swiping' notice) and a
 * substring test would misfire on any of them.
 */
function isCodecMessage(data) {
  if (typeof data !== 'string' || data.charAt(0) !== '{') {
    return false
  }
  try {
    const parsed = JSON.parse(data)
    return Boolean(parsed) && parsed.type === 'codec'
  }
  catch (err) {
    return false
  }
}

/**
 * Minimum gap between keyframe requests. The device's encoder answers the odd
 * PLI happily and degrades under a stream of them, so asking once and waiting
 * beats asking repeatedly.
 */
const RECOVERY_INTERVAL_MS = 1500

/**
 * @param {object}   options
 * @param {function} options.onFrame     (VideoFrame, crop) => void — paint it
 * @param {function} [options.onFirstFrame]
 * @param {function} [options.onError]
 * @param {function} [options.onRecoveryNeeded] ask the agent for a fresh IDR
 * @param {boolean}  [options.compensate=true]
 */
function HevcScreenRenderer(options) {
  this.onFrame = options.onFrame
  this.onFirstFrame = options.onFirstFrame || function() {}
  this.onError = options.onError || function() {}
  this.onRecoveryNeeded = options.onRecoveryNeeded || function() {}
  this.compensate = options.compensate !== false
  this.lastRecoveryRequest = 0

  this.decoder = null
  this.decoderConfig = null
  this.needsResync = false
  this.gotKey = false
  this.timestamp = 0
  this.sawFirstFrame = false
  this.destroyed = false

  // rAF coalescing: decode output can outpace the display refresh, and
  // painting frames nobody sees is pure GPU cost.
  this.pendingFrame = null
  this.rafScheduled = false

  // Scratch canvas for collapse detection (see detectContentCrop).
  this.detectionCanvas = document.createElement('canvas')
  this.detectionContext = this.detectionCanvas.getContext('2d', {willReadFrequently: true})
  this.cropWidth = 0
  this.cropHeight = 0
}

/**
 * Feed a raw WebSocket payload. Returns true if this module consumed it, so
 * the caller can fall through to its own handling when it did not.
 */
HevcScreenRenderer.prototype.handleMessage = function(data) {
  if (this.destroyed) {
    return false
  }
  if (typeof data === 'string') {
    if (!isCodecMessage(data)) {
      return false
    }
    this.configure(JSON.parse(data))
    return true
  }
  if (data instanceof ArrayBuffer) {
    this.decodeChunk(new Uint8Array(data))
    return true
  }
  return false
}

HevcScreenRenderer.prototype.configure = function(info) {
  this.decoderConfig = {
    codec: info.codec,
    description: base64ToBytes(info.description),
    hardwareAcceleration: 'prefer-hardware',
    optimizeForLatency: true,
  }
  this.buildDecoder()
}

HevcScreenRenderer.prototype.buildDecoder = function() {
  const self = this

  if (this.decoder) {
    try {
      this.decoder.close()
    }
    catch (err) { /* already closed */ }
  }

  this.decoder = new VideoDecoder({
    output: function(frame) {
      self.handleDecodedFrame(frame)
    },
    error: function(err) {
      // Don't tear down: the next keyframe re-anchors us. But do ask for that
      // keyframe — the stream is long-GOP, so "the next one" can be a long way
      // off, and the agent cannot see a decode failure that happened in the
      // browser. Waiting passively for it is what turns a one-frame decode
      // error into a multi-second freeze.
      self.needsResync = true
      self.requestRecovery()
      console.warn('[hevc] decoder error', err && err.message)
    },
  })
  this.decoder.configure(this.decoderConfig)
  this.needsResync = false
}

HevcScreenRenderer.prototype.decodeChunk = function(bytes) {
  if (!this.decoder || !this.decoderConfig || bytes.length < 1) {
    return
  }

  const type = bytes[0]
  const data = bytes.subarray(1)

  if (type === 2) {
    this.buildDecoder()
    this.gotKey = true
  }
  else if (type === 0) {
    this.gotKey = true
    if (this.needsResync) {
      this.buildDecoder()
    }
  }

  // A delta before the first key would decode against nothing.
  if (!this.gotKey || this.needsResync) {
    if (this.needsResync) {
      // Still holding out for an anchor. Keep nudging (rate-limited) rather
      // than waiting for the stream to produce one on its own.
      this.requestRecovery()
    }
    return
  }

  if (this.decoder.state !== 'configured') {
    this.buildDecoder()
    this.needsResync = true
    this.requestRecovery()
    return
  }

  try {
    this.decoder.decode(new EncodedVideoChunk({
      type: (type === 0 || type === 2) ? 'key' : 'delta',
      timestamp: this.timestamp,
      data: data,
    }))
    // Nominal 60fps spacing. The stream is not CFR, but WebCodecs only uses
    // this for ordering and monotonic is all that is required.
    this.timestamp += 16666
  }
  catch (err) {
    this.needsResync = true
    this.requestRecovery()
  }
}

/**
 * Note that access units were dropped before reaching the decoder.
 *
 * The directive skips decoding while the screen is not being looked at (hidden
 * tab, screen toggled off). Those dropped deltas are references the decoder
 * will never have, so resuming mid-GOP paints mispredicted blocks —
 * VideoToolbox does not raise on a missing reference, it just renders the
 * smear. Refuse to decode until the stream re-anchors, and ask for that anchor.
 */
HevcScreenRenderer.prototype.markStale = function() {
  if (this.destroyed || !this.gotKey) {
    return
  }
  this.needsResync = true
}

/**
 * Ask the agent (which asks the device) for an immediate keyframe.
 *
 * Rate-limited rather than debounced: the first request should go out
 * immediately, since every frame we spend waiting is a frame the user sees
 * frozen or torn. Subsequent ones are suppressed until the interval elapses.
 */
HevcScreenRenderer.prototype.requestRecovery = function() {
  const now = Date.now()

  if (now - this.lastRecoveryRequest < RECOVERY_INTERVAL_MS) {
    return
  }
  this.lastRecoveryRequest = now

  try {
    this.onRecoveryNeeded()
  }
  catch (err) { /* the socket may already be closing */ }
}

HevcScreenRenderer.prototype.handleDecodedFrame = function(frame) {
  const self = this

  if (this.destroyed) {
    frame.close()
    return
  }
  if (this.pendingFrame) {
    this.pendingFrame.close()
  }
  this.pendingFrame = frame

  if (!this.rafScheduled) {
    this.rafScheduled = true
    requestAnimationFrame(function() {
      self.drawPending()
    })
  }
}

HevcScreenRenderer.prototype.drawPending = function() {
  this.rafScheduled = false

  const frame = this.pendingFrame
  this.pendingFrame = null

  if (!frame) {
    return
  }
  if (this.destroyed) {
    frame.close()
    return
  }

  try {
    if (this.compensate) {
      this.detectContentCrop(frame)
    }
    else {
      this.cropWidth = 0
      this.cropHeight = 0
    }

    this.onFrame(frame, {
      width: this.cropWidth || frame.displayWidth,
      height: this.cropHeight || frame.displayHeight,
    })

    if (!this.sawFirstFrame) {
      this.sawFirstFrame = true
      this.onFirstFrame(frame)
    }
  }
  catch (err) {
    this.onError(err)
  }
  finally {
    frame.close()
  }
}

/**
 * Undo iOS's motion resolution-collapse.
 *
 * Under sustained motion the device drops to a smaller capture resolution
 * rendered into the TOP-LEFT of the fixed buffer, the rest flat gray
 * (Y=Cb=Cr=128) — the "screen shrinks into a corner while swiping" artifact.
 * It is a device-side encoder decision under the bitrate cap and cannot be
 * prevented from our side.
 *
 * But the shrunk region is the whole screen, just in fewer pixels. So we find
 * that content rectangle and let the caller stretch it back to fill the
 * canvas: the collapse then reads as a momentary softness dip instead of a
 * jarring corner shrink.
 *
 * Runs on the RAW decoded frame, never the already-compensated canvas —
 * feeding output back in would oscillate. And per-frame rather than
 * throttled+cached, because the stream alternates between collapsed and
 * full-res faster than any throttle; applying a stale crop to a full frame
 * zooms it into its own top-left corner.
 */
HevcScreenRenderer.prototype.detectContentCrop = function(frame) {
  const frameWidth = frame.displayWidth
  const frameHeight = frame.displayHeight

  if (!frameWidth || !frameHeight) {
    return
  }

  const detectionWidth = Math.max(8, Math.round(DETECTION_HEIGHT * frameWidth / frameHeight))
  this.detectionCanvas.width = detectionWidth
  this.detectionCanvas.height = DETECTION_HEIGHT

  try {
    this.detectionContext.drawImage(frame, 0, 0, detectionWidth, DETECTION_HEIGHT)

    const pixels = this.detectionContext
      .getImageData(0, 0, detectionWidth, DETECTION_HEIGHT).data

    const isGray = function(x, y) {
      const i = (y * detectionWidth + x) * 4
      return Math.abs(pixels[i] - 128) < 6
        && Math.abs(pixels[i + 1] - 128) < 6
        && Math.abs(pixels[i + 2] - 128) < 6
    }

    // Last column / row still holding content (< 60% gray padding).
    let lastContentColumn = 0
    for (let x = 0; x < detectionWidth; x++) {
      let gray = 0
      let total = 0
      for (let y = 0; y < DETECTION_HEIGHT; y += 4) {
        total++
        if (isGray(x, y)) {
          gray++
        }
      }
      if (gray / total < 0.6) {
        lastContentColumn = x
      }
    }

    let lastContentRow = 0
    for (let y = 0; y < DETECTION_HEIGHT; y++) {
      let gray = 0
      let total = 0
      for (let x = 0; x < detectionWidth; x += 4) {
        total++
        if (isGray(x, y)) {
          gray++
        }
      }
      if (gray / total < 0.6) {
        lastContentRow = y
      }
    }

    const contentWidth = Math.round((lastContentColumn / detectionWidth) * frameWidth)
    const contentHeight = Math.round((lastContentRow / DETECTION_HEIGHT) * frameHeight)

    // Compensate only on a clear collapse in both dimensions; anything else is
    // a normal frame and must be drawn untouched.
    if (contentWidth > frameWidth * 0.2 && contentWidth < frameWidth * 0.92
      && contentHeight > frameHeight * 0.2 && contentHeight < frameHeight * 0.92) {
      this.cropWidth = contentWidth
      this.cropHeight = contentHeight
    }
    else {
      this.cropWidth = 0
      this.cropHeight = 0
    }
  }
  catch (err) {
    // Transient readback failure — keep the previous crop.
  }
}

HevcScreenRenderer.prototype.destroy = function() {
  this.destroyed = true

  if (this.pendingFrame) {
    this.pendingFrame.close()
    this.pendingFrame = null
  }
  if (this.decoder) {
    try {
      this.decoder.close()
    }
    catch (err) { /* already closed */ }
    this.decoder = null
  }
}

module.exports = HevcScreenRenderer
module.exports.isCodecMessage = isCodecMessage
