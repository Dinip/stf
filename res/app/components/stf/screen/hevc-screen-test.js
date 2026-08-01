/* eslint no-console: 0 */
//
// Standalone test for the HEVC renderer's protocol logic. Same style as
// rotator-test.js — plain node, no karma:
//
//     node res/app/components/stf/screen/hevc-screen-test.js
//
// Karma would need a browser with HEVC WebCodecs support, which is exactly the
// dependency worth avoiding for a unit test. The browser globals the module
// touches are stubbed below, so this covers everything except actual decoding:
// message discrimination, the key/delta/reset state machine, payload framing,
// and teardown.
//
var assertions = 0
var failures = 0

function check(label, condition) {
  assertions++
  if (condition) {
    console.log('PASS  ' + label)
  }
  else {
    failures++
    console.log('FAIL  ' + label)
  }
}

// ---------------------------------------------------------------- browser stubs

var decoded = []
var decoderBuilds = 0

global.atob = function(b64) {
  return Buffer.from(b64, 'base64').toString('binary')
}
global.requestAnimationFrame = function(fn) {
  fn()
}
global.document = {
  createElement: function() {
    return {
      getContext: function() {
        return {
          drawImage: function() {},
          getImageData: function() {
            // Force the readback-failure path; crop detection is a rendering
            // heuristic and not what this file is testing.
            throw new Error('no readback in node')
          },
        }
      },
    }
  },
}
global.VideoDecoder = function(handlers) {
  this.handlers = handlers
  this.state = 'unconfigured'
  decoderBuilds++
}
global.VideoDecoder.prototype.configure = function() {
  this.state = 'configured'
}
global.VideoDecoder.prototype.decode = function(chunk) {
  decoded.push(chunk)
}
global.VideoDecoder.prototype.close = function() {
  this.state = 'closed'
}
global.EncodedVideoChunk = function(init) {
  this.type = init.type
  this.timestamp = init.timestamp
  this.data = init.data
}

var HevcScreenRenderer = require('./hevc-screen')

// ------------------------------------------------------------- isCodecMessage
//
// This discriminator has to be exact: the same socket carries STF's own text
// frames, and a substring test would misfire on any of them.

var codecCases = [
  ['{"type":"codec","codec":"hev1.1.6.L120.90","description":""}', true],
  ['{"type":"swiping","message":"Swiping detected"}', false],
  ['secure_on', false],
  ['start {"quirks":{}}', false],
  ['not json at all', false],
  ['', false],
]

codecCases.forEach(function(testCase) {
  var input = testCase[0]
  var expected = testCase[1]
  check(
    'isCodecMessage(' + JSON.stringify(input).slice(0, 40) + ') === ' + expected,
    HevcScreenRenderer.isCodecMessage(input) === expected
  )
})

// ------------------------------------------------------------- decode dispatch

function accessUnit(type, payload) {
  return new Uint8Array([type].concat(payload)).buffer
}

var renderer = new HevcScreenRenderer({
  onFrame: function() {},
  onFirstFrame: function() {},
})

renderer.handleMessage('{"type":"codec","codec":"hev1.1.6.L120.90","description":"AQ=="}')
check('codec handshake builds a decoder', decoderBuilds === 1)

renderer.handleMessage(accessUnit(1, [9, 9]))
check('delta before the first key is dropped', decoded.length === 0)

renderer.handleMessage(accessUnit(0, [1, 2, 3]))
renderer.handleMessage(accessUnit(1, [4, 5]))
check('key then delta both decode', decoded.length === 2)
check('chunk types map correctly', decoded[0].type === 'key' && decoded[1].type === 'delta')
check('timestamps are monotonic', decoded[0].timestamp < decoded[1].timestamp)
check('type byte is stripped from the payload', decoded[0].data.length === 3)

var buildsBeforeReset = decoderBuilds
renderer.handleMessage(accessUnit(2, [7]))
check('type=2 rebuilds the decoder', decoderBuilds === buildsBeforeReset + 1)
check('type=2 still decodes as a key', decoded[decoded.length - 1].type === 'key')

check("unrelated text falls through to STF's handling",
  renderer.handleMessage('secure_on') === false)

renderer.destroy()
check('a destroyed renderer ignores further frames',
  renderer.handleMessage(accessUnit(0, [1])) === false)

// -------------------------------------------------------------------- summary

console.log('\n' + assertions + ' assertion(s), ' + failures + ' failure(s)')
process.exit(failures ? 1 : 0)
