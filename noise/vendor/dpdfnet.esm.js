/*
 * Plotina noise suppression — experimental DPDFNet backend.
 *
 * Wraps the official DPDFNet stateful 48 kHz ONNX model (Apache-2.0,
 * https://github.com/ceva-ip/DPDFNet; browser-oriented single-frame export
 * from the model zoo of the same project's author fork, commit
 * 2e6a8aac54e8d431d632b2e04947ffdc7af4641c — pinned with SHA-256 in
 * noise/dpdfnet.lock.json) behind the same core interface DeepFilterNet3
 * already exposes to boot.js:
 *
 *   createCore(opts) -> { initialize(), createAudioWorkletNode(ctx),
 *                         processHop(Float32Array) -> Promise<Float32Array>,
 *                         setSuppressionLevel(v), destroy(), stats }
 *
 * Inference runs on the main thread through onnxruntime-web (wasm, vendored
 * under vendor/ort/); the AudioWorklet only handles sample buffering, so no
 * wasm loading inside AudioWorkletGlobalScope and no cross-thread tensor
 * lifetime games. Latency is a fixed ~10-30 ms ring (2-3 hops of 480 samples).
 *
 * DSP mirrors the model's reference streaming driver exactly (vorbis window
 * over a 960-sample buffer, hop 480, rfft with wnorm = 2*hop/win^2 applied to
 * the spectrum, spec_real interface [1,1,1,481,2], overlap-add synthesis with
 * the same window; all model normalisation lives inside the ONNX graph as
 * state tensors). FFT for n=960 uses Bluestein's algorithm; both directions
 * are validated against a naive DFT in noise/tests/dpdfnet.test.mjs.
 *
 * Deliberate limits:
 *   - The model is 48 kHz only: initialize() rejects anything else. The
 *     16 kHz dpdfnet4/dpdfnet8 family would need resampling, which this
 *     backend does not do on purpose (the audio path already runs at 48k).
 *   - noiseReductionLevel is realised as a linear dry/wet mix in the spectral
 *     domain, not as a dB knob inside the model (DPDFNet has none).
 *   - Anything that goes wrong here must end in DFN3 or raw audio; that
 *     decision logic is pure and lives in logic.js (backendPlan), used by
 *     boot.js. This file just throws early and often.
 */

const MODEL_NAME = "dpdfnet2_48khz_hr";
const MODEL_SR = 48000;
const WIN_LEN = 960;
const HOP_SIZE = 480;
const FREQ_BINS = 481;

/* ------------------------------------------------------------ pure DSP -- */

export function vorbisWindow(n) {
  const w = new Float32Array(n);
  const half = n / 2;
  for (let i = 0; i < n; i++) {
    const s = Math.sin((0.5 * Math.PI * (i + 0.5)) / half);
    w[i] = Math.sin(0.5 * Math.PI * s * s);
  }
  return w;
}

export function getWnorm(windowLen, hopSize) {
  return 1.0 / (windowLen * windowLen / (2 * hopSize));
}

/* Iterative radix-2 complex FFT, unnormalised in both directions. */
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const ur = re[a], ui = im[a];
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[a] = ur + vr; im[a] = ui + vi;
        re[b] = ur - vr; im[b] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/**
 * Bluestein chirp-z DFT for an arbitrary length n (here: 960).
 * rfft: real x[n] -> outRe/outIm [n/2+1]; irfft: Hermitian spectrum
 * [n/2+1] -> real y[n]. float64 internally; numpy-identical bin layout.
 */
export function makeBluestein(n) {
  const m = 1 << Math.ceil(Math.log2(2 * n - 1));
  const cRe = new Float64Array(n), cIm = new Float64Array(n);
  const hRe = new Float64Array(m), hIm = new Float64Array(m);
  for (let k = 0; k < n; k++) {
    const a = (-Math.PI * k * k) / n;
    cRe[k] = Math.cos(a); cIm[k] = Math.sin(a);
  }
  for (let j = 0; j < n; j++) {
    const a = (Math.PI * j * j) / n;
    const r = Math.cos(a), s = Math.sin(a);
    hRe[j] = r; hIm[j] = s;
    if (j > 0) { hRe[m - j] = r; hIm[m - j] = s; }
  }
  fft(hRe, hIm, false);

  const workA = new Float64Array(m), workB = new Float64Array(m);
  const convA = new Float64Array(m), convB = new Float64Array(m);

  // Y = ifft( fft(a) .* fft(h) ), a length-m buffer already filled.
  function cyclic(conv_re, conv_im) {
    fft(conv_re, conv_im, false);
    for (let i = 0; i < m; i++) {
      const r = conv_re[i] * hRe[i] - conv_im[i] * hIm[i];
      const s = conv_re[i] * hIm[i] + conv_im[i] * hRe[i];
      conv_re[i] = r; conv_im[i] = s;
    }
    fft(conv_re, conv_im, true);
    for (let i = 0; i < m; i++) { conv_re[i] /= m; conv_im[i] /= m; }
  }

  return {
    rfft(x, outRe, outIm) {
      workA.fill(0); workB.fill(0);
      for (let i = 0; i < n; i++) { workA[i] = x[i] * cRe[i]; workB[i] = x[i] * cIm[i]; }
      cyclic(workA, workB);
      for (let k = 0; k <= n / 2; k++) {
        outRe[k] = cRe[k] * workA[k] - cIm[k] * workB[k];
        outIm[k] = cRe[k] * workB[k] + cIm[k] * workA[k];
      }
    },
    // y[t] = (1/n) * conj( DFT_n(conj(Xfull))[t] ) — Xfull is X hermitian-extended.
    irfft(specRe, specIm, y) {
      convA.fill(0); convB.fill(0);
      const half = n / 2;
      for (let t = 0; t < n; t++) {
        let zr, zi;
        if (t <= half) { zr = specRe[t]; zi = -specIm[t]; }
        else { const j = n - t; zr = specRe[j]; zi = specIm[j]; }
        convA[t] = zr * cRe[t] - zi * cIm[t];
        convB[t] = zr * cIm[t] + zi * cRe[t];
      }
      fft(convA, convB, false);
      for (let i = 0; i < m; i++) {
        const r = convA[i] * hRe[i] - convB[i] * hIm[i];
        const s = convA[i] * hIm[i] + convB[i] * hRe[i];
        convA[i] = r; convB[i] = s;
      }
      fft(convA, convB, true);
      for (let i = 0; i < m; i++) { convA[i] /= m; convB[i] /= m; }
      for (let t = 0; t < n; t++) {
        const p = cRe[t] * convA[t] - cIm[t] * convB[t];
        y[t] = p / n;
      }
    },
  };
}

/**
 * Streaming STFT hop coder with the exact normalisation of the model's
 * reference driver: analysis buffer of winLen samples, hop of hopSize,
 * spectrum multiplied by wnorm, interleaved [re, im] float32 output of
 * length FREQ_BINS*2; decode() runs iSTFT * wnorm^-1 * window + OLA.
 */
export function createFrameCodec(config) {
  const winLen = (config && config.winLen) || WIN_LEN;
  const hop = (config && config.hopSize) || HOP_SIZE;
  const bins = winLen / 2 + 1;
  const window = (config && config.window) || vorbisWindow(winLen);
  const wnorm = (config && config.wnorm) || getWnorm(winLen, hop);
  const bt = makeBluestein(winLen);
  const td = new Float64Array(winLen);
  const buf = new Float32Array(winLen);
  const ola = new Float32Array(winLen);
  const specRe = new Float64Array(bins);
  const specIm = new Float64Array(bins);

  return {
    hopSize: hop,
    freqBins: bins,
    reset() { buf.fill(0); ola.fill(0); },
    /** hop Float32Array[hop] -> interleaved spectrum Float32Array[bins*2] */
    encode(hopIn, into) {
      buf.copyWithin(0, hop);
      buf.set(hopIn, winLen - hop);
      for (let i = 0; i < winLen; i++) td[i] = buf[i] * window[i];
      bt.rfft(td, specRe, specIm);
      const out = into && into.length === bins * 2 ? into : new Float32Array(bins * 2);
      for (let k = 0; k < bins; k++) {
        out[2 * k] = specRe[k] * wnorm;
        out[2 * k + 1] = specIm[k] * wnorm;
      }
      return out;
    },
    /** interleaved spectrum -> hop Float32Array[hop] (written into `dest`) */
    decode(specInterleaved, dest) {
      for (let k = 0; k < bins; k++) {
        specRe[k] = specInterleaved[2 * k];
        specIm[k] = specInterleaved[2 * k + 1];
      }
      bt.irfft(specRe, specIm, td);
      for (let i = 0; i < winLen; i++) td[i] = (td[i] * window[i]) / wnorm;
      ola.copyWithin(0, hop);
      ola.fill(0, winLen - hop);
      for (let i = 0; i < winLen; i++) ola[i] += td[i];
      dest.set(ola.subarray(0, hop));
      return dest;
    },
  };
}

/* -------------------------------------------------------------- wiring -- */

const WORKLET_SRC = `
class DpdfnetProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const hop = options.processorOptions.hopSize;
    this.hop = hop;
    this.ringCap = hop * 8;
    this.ring = new Float32Array(this.ringCap);
    this.write = 0; this.read = 0; this.count = 0;
    this.inBuf = new Float32Array(hop); this.inLen = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'hop') {
        const h = new Float32Array(m.buffer);
        for (let i = 0; i < h.length; i++) {
          if (this.count === this.ringCap) {
            this.read = (this.read + 1) % this.ringCap;
            this.count--; // overflow: drop the oldest sample
          }
          this.ring[this.write] = h[i];
          this.write = (this.write + 1) % this.ringCap;
          this.count++;
        }
      } else if (m.type === 'reset') {
        this.write = 0; this.read = 0; this.count = 0; this.inLen = 0;
        this.ring.fill(0);
      }
    };
  }
  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0];
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    out.fill(0);
    if (inp) {
      for (let i = 0; i < inp.length; i++) {
        this.inBuf[this.inLen] = inp[i];
        this.inLen++;
        if (this.inLen === this.hop) {
          const copy = this.inBuf.slice();
          this.port.postMessage({ type: 'in', buffer: copy.buffer }, [copy.buffer]);
          this.inLen = 0;
        }
      }
      const take = Math.min(out.length, this.count);
      for (let i = 0; i < take; i++) {
        out[i] = this.ring[this.read];
        this.read = (this.read + 1) % this.ringCap;
        this.count--;
      }
    }
    return true;
  }
}
registerProcessor('plotina-dpdfnet', DpdfnetProcessor);
`;

function clamp01_100(v) {
  var n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

async function loadBinary(url, asText) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("dpdfnet asset fetch failed " + resp.status + ": " + url);
  return asText ? resp.text() : new Uint8Array(await resp.arrayBuffer());
}

class PlotinaDpdfnetCore {
  /**
   * opts: { sampleRate, noiseReductionLevel,
   *         ort,                 // preloaded onnxruntime-web namespace (node tests)
   *         ortUrl,              // ESM URL of ort.wasm.bundle.min.mjs (browser)
   *         wasmUrl,             // URL/path of ort-wasm-simd-threaded.wasm
   *         wasmDir,             // alternative to wasmUrl: directory
   *         assetConfig: { modelUrl|modelData, statesJsonUrl|statesJsonData,
   *                        statesBinUrl|statesBinData } }
   */
  constructor(opts) {
    opts = opts || {};
    var ac = opts.assetConfig || {};
    this.sampleRate = opts.sampleRate || MODEL_SR;
    this.level = clamp01_100(opts.noiseReductionLevel === undefined ? 100 : opts.noiseReductionLevel);
    this.ortUrl = opts.ortUrl;
    this.wasmUrl = opts.wasmUrl;
    this.wasmDir = opts.wasmDir;
    this.ort = opts.ort || null;
    this.modelData = ac.modelData || null;
    this.modelUrl = ac.modelUrl;
    this.statesJsonData = ac.statesJsonData || null;
    this.statesJsonUrl = ac.statesJsonUrl;
    this.statesBinData = ac.statesBinData || null;
    this.statesBinUrl = ac.statesBinUrl;
    this.hopSize = HOP_SIZE;
    this.stats = { backend: "dpdfnet4", model: MODEL_NAME, frames: 0, queueDrops: 0, lastInferMs: 0, lsnr: null, error: null };
    this._states = new Map();
    this._stateShapes = new Map();
    this._destroyed = false;
    this._lock = Promise.resolve();
    this._pending = [];
    this._draining = false;
    this._node = null;
  }

  async initialize() {
    if (this.sampleRate !== MODEL_SR) {
      throw new Error(
        "DPDFNet " + MODEL_NAME + " expects the 48 kHz sample rate it was trained at; got " +
          this.sampleRate + " Hz. This backend deliberately does not resample."
      );
    }
    if (!this.ort) {
      var ortUrl = this.ortUrl || new URL("./ort/ort.wasm.bundle.min.mjs", import.meta.url).href;
      this.ort = await import(ortUrl);
    }
    var wasmDir = this.wasmDir;
    if (!wasmDir && this.wasmUrl) {
      wasmDir = this.wasmUrl.slice(0, this.wasmUrl.lastIndexOf("/") + 1);
    }
    if (!wasmDir) {
      wasmDir = new URL("./ort/", import.meta.url).href;
    }
    if (wasmDir.charAt(wasmDir.length - 1) !== "/") wasmDir += "/";
    try {
      this.ort.env.wasm.wasmPaths = wasmDir;
      this.ort.env.wasm.numThreads = 1;
      this.ort.env.wasm.proxy = false;
    } catch (e) {
      throw new Error("could not configure onnxruntime-web: " + (e && e.message ? e.message : e));
    }

    var json = this.statesJsonData
      ? (typeof this.statesJsonData === "string" ? this.statesJsonData : new TextDecoder().decode(this.statesJsonData))
      : await loadBinary(this.statesJsonUrl || this._defaultUrl("initial_states.json"), true);
    var layout = JSON.parse(json);
    var bin = this.statesBinData
      ? this.statesBinData
      : await loadBinary(this.statesBinUrl || this._defaultUrl("initial_states.bin"), false);
    var floats = new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
    var total = layout.reduce(function (a, s) { return a + s.num_elements; }, 0);
    if (floats.length !== total) {
      throw new Error("dpdfnet states bin/json mismatch: " + floats.length + " != " + total);
    }
    for (var i = 0; i < layout.length; i++) {
      var s = layout[i];
      this._states.set(s.name, floats.slice(s.offset, s.offset + s.num_elements));
      this._stateShapes.set(s.name, s.shape);
    }

    var model = this.modelData
      ? this.modelData
      : await loadBinary(this.modelUrl || this._defaultUrl("model_stateful.onnx"), false);
    this.session = await this.ort.InferenceSession.create(model, { logSeverityLevel: 3 });

    var expectedOut = ["spec_enhanced", "lsnr"];
    for (var name of this._states.keys()) expectedOut.push(name + "_out");
    var haveOut = this.session.outputNames;
    for (var e of expectedOut) {
      if (haveOut.indexOf(e) === -1) throw new Error("dpdfnet model is missing output '" + e + "'");
    }
    if (this.session.inputNames[0] !== "spec" || this.session.inputNames.length !== this._states.size + 1) {
      throw new Error("dpdfnet model input signature is not spec + states");
    }

    this.codec = createFrameCodec({});
    this._specFeed = new Float32Array(FREQ_BINS * 2);
    this.stats.initialized = true;
    return this;
  }

  _defaultUrl(file) {
    return new URL("./dpdfnet/" + MODEL_NAME + "/" + file, import.meta.url).href;
  }

  setSuppressionLevel(value) {
    this.level = clamp01_100(value);
  }

  /**
   * One 480-sample hop in, one 480-sample hop out (Promise). The model is
   * stateful and single-stream, so calls are serialised on an internal lock
   * chain regardless of who drives them (worklet bridge or tests).
   */
  processHop(hopIn) {
    var self = this;
    var run = this._lock.then(function () {
      return self._processHopLocked(hopIn);
    });
    // keep the chain alive even when a hop fails
    this._lock = run.catch(function () {});
    return run;
  }

  async _processHopLocked(hopIn) {
    if (this._destroyed) throw new Error("dpdfnet core is destroyed");
    if (!this.session) throw new Error("dpdfnet core not initialized");
    if (hopIn.length !== HOP_SIZE) throw new Error("hop must be " + HOP_SIZE + " samples, got " + hopIn.length);

    var spec = this.codec.encode(hopIn, this._specFeed);
    var feed = new Float32Array(spec); // copy: ort keeps the reference until run() resolves
    var feeds = { spec: this.ort.Tensor ? new this.ort.Tensor("float32", feed, [1, 1, 1, FREQ_BINS, 2]) : null };
    if (!feeds.spec) throw new Error("onnxruntime-web namespace has no Tensor export");
    for (var pair of this._states) {
      feeds[pair[0]] = new this.ort.Tensor("float32", pair[1], this._stateShapes.get(pair[0]));
    }

    var t0 = Date.now();
    var res = await this.session.run(feeds);
    this.stats.lastInferMs = Date.now() - t0;
    this.stats.frames++;
    this.stats.lsnr = res.lsnr ? res.lsnr.data[0] : null;

    for (var pair of this._states) {
      var out = res[pair[0] + "_out"];
      if (!out) throw new Error("model did not return updated state " + pair[0]);
      pair[1].set(out.data.subarray(0, pair[1].length));
    }

    var enh = res.spec_enhanced.data;
    var m = this.level / 100;
    var mixed = new Float32Array(FREQ_BINS * 2);
    if (m >= 1) mixed.set(enh.subarray(0, mixed.length));
    else if (m <= 0) mixed.set(spec);
    else {
      for (var i = 0; i < mixed.length; i++) mixed[i] = (1 - m) * spec[i] + m * enh[i];
    }
    var outHop = new Float32Array(HOP_SIZE);
    this.codec.decode(mixed, outHop);
    return outHop;
  }

  /**
   * Registers the buffering worklet and returns a connected-to-nothing
   * AudioWorkletNode; boot.js wires source -> node -> destination exactly like
   * for the DFN3 core. Hops travel main-thread <-> worklet via MessagePort.
   */
  async createAudioWorkletNode(ctx) {
    if (!this.session) throw new Error("dpdfnet core not initialized");
    var self = this;
    var url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    var node = new AudioWorkletNode(ctx, "plotina-dpdfnet", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: { hopSize: HOP_SIZE },
    });
    this._node = node;

    node.port.onmessage = function (e) {
      var msg = e.data;
      if (!msg || msg.type !== "in") return;
      var hop = new Float32Array(msg.buffer);
      // Backpressure: if inference is behind by more than 4 hops, skip the
      // oldest input instead of growing latency forever. Audio keeps flowing,
      // the model just loses a frame (acceptable for an experimental path).
      if (self._pending.length > 4) {
        self._pending.shift();
        self.stats.queueDrops++;
      }
      self._pending.push(hop);
      if (!self._draining) self._drain(node);
    };
    return node;
  }

  async _drain(node) {
    this._draining = true;
    while (this._pending.length && !this._destroyed) {
      var hop = this._pending.shift();
      try {
        var out = await this.processHop(hop);
        if (node.port) node.port.postMessage({ type: "hop", buffer: out.buffer }, [out.buffer]);
      } catch (err) {
        this.stats.error = (err && err.message) || String(err);
        if (node.port) node.port.postMessage({ type: "hop", buffer: new Float32Array(HOP_SIZE).buffer });
      }
    }
    this._draining = false;
  }

  destroy() {
    this._destroyed = true;
    this._pending.length = 0;
    var node = this._node;
    this._node = null;
    if (node) {
      try { node.port.onmessage = null; } catch (e) {}
      try { node.disconnect(); } catch (e) {}
    }
    var session = this.session;
    this.session = null;
    if (session && session.release) {
      try { session.release(); } catch (e) {}
    }
  }
}

/* Unified-backend factory used by boot.js; mirrors DeepFilterNet3Core's role
   as the single constructor a backend has to offer. */
export function createCore(opts) {
  return new PlotinaDpdfnetCore(opts);
}

export { PlotinaDpdfnetCore, MODEL_NAME as MODEL, HOP_SIZE, WIN_LEN, FREQ_BINS };
export default { createCore: createCore, PlotinaDpdfnetCore: PlotinaDpdfnetCore };
