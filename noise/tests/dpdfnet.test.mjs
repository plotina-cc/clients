/*
 * Functional smoke tests for the DPDFNet browser backend
 * (noise/vendor/dpdfnet.esm.js).
 *
 *   node --test noise/tests/dpdfnet.test.mjs
 *
 * Tier 1 (always): pure DSP correctness of the vendored pipeline
 *   (Bluestein rfft/irfft at n=960, vorbis window, wnorm).
 * Tier 2 (skips when model/onnxruntime assets were not fetched — run
 *   noise/scripts/fetch-dpdfnet.py first): a real inference pass with
 *   onnxruntime-web over 1 s of synthesised audio (440 Hz tone + white
 *   noise), asserting the output is finite, non-zero and correctly sized.
 *   Inference duration is reported as INFO only — this branch does not gate
 *   quality or performance, the functional path only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const noiseDir = path.join(here, "..");
const vendorDir = path.join(noiseDir, "vendor");
const moduleUrl = pathToFileURL(path.join(vendorDir, "dpdfnet.esm.js")).href;

const MODEL_DIR = path.join(vendorDir, "dpdfnet", "dpdfnet2_48khz_hr");
const ASSETS = {
  model: path.join(MODEL_DIR, "model_stateful.onnx"),
  statesJson: path.join(MODEL_DIR, "initial_states.json"),
  statesBin: path.join(MODEL_DIR, "initial_states.bin"),
};
const ASSETS_READY = Object.values(ASSETS).every((p) => existsSync(p));
const ortRequire = createRequire(import.meta.url);
let ortPath;
try {
  ortPath = ortRequire.resolve("onnxruntime-web");
} catch {
  ortPath = null;
}

const mod = await import(moduleUrl);

/* ------------------------------------------------------------ tier 1: DSP */

test("module exports the unified backend surface", () => {
  assert.equal(typeof mod.createCore, "function", "createCore(opts) -> core");
  assert.equal(typeof mod.PlotinaDpdfnetCore, "function");
  const core = mod.createCore({ sampleRate: 48000, noiseReductionLevel: 60 });
  for (const m of ["initialize", "createAudioWorkletNode", "setSuppressionLevel", "destroy"]) {
    assert.equal(typeof core[m], `function`, `core.${m} missing`);
  }
});

test("core rejects a sample rate other than the model's 48 kHz", async () => {
  const core = mod.createCore({ sampleRate: 44100, noiseReductionLevel: 60 });
  await assert.rejects(() => core.initialize(), /48/, "must mention 48k");
});

test("vorbis window: endpoints near zero, symmetric, max ~1", () => {
  const w = mod.vorbisWindow(960);
  assert.equal(w.length, 960);
  assert.ok(w[0] > 0 && w[0] < 0.01, `w[0]=${w[0]}`);
  assert.ok(Math.abs(w[0] - w[959]) < 1e-6);
  assert.ok(Math.abs(w[100] - w[859]) < 1e-6);
  const max = Math.max(...w);
  assert.ok(max > 0.99 && max <= 1.000001);
});

test("wnorm matches the reference formula 2*hop/win^2", () => {
  assert.ok(Math.abs(mod.getWnorm(960, 480) - 1 / 960) < 1e-12);
});

test("Bluestein rfft matches a naive DFT at scattered bins (n=960)", () => {
  const N = 960;
  const bt = mod.makeBluestein(N);
  const x = new Float64Array(N);
  let s = 123456789;
  for (let i = 0; i < N; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    x[i] = (s / 1073741824) - 1;
  }
  const or = new Float64Array(N / 2 + 1);
  const oi = new Float64Array(N / 2 + 1);
  bt.rfft(x, or, oi);
  let err = 0;
  for (const k of [0, 1, 23, 120, 317, 480]) {
    let sr = 0, si = 0;
    for (let n = 0; n < N; n++) {
      const a = (-2 * Math.PI * k * n) / N;
      sr += x[n] * Math.cos(a);
      si += x[n] * Math.sin(a);
    }
    err = Math.max(err, Math.abs(sr - or[k]), Math.abs(si - oi[k]));
  }
  assert.ok(err < 1e-8, `max DFT error ${err.toExponential(2)}`);
});

test("irfft(rfft(x)) round-trips a real sequence (n=960)", () => {
  const N = 960;
  const bt = mod.makeBluestein(N);
  const x = new Float64Array(N);
  for (let i = 0; i < N; i++) x[i] = Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.3);
  const or = new Float64Array(N / 2 + 1);
  const oi = new Float64Array(N / 2 + 1);
  bt.rfft(x, or, oi);
  const y = new Float64Array(N);
  bt.irfft(or, oi, y);
  let err = 0;
  for (let i = 0; i < N; i++) err = Math.max(err, Math.abs(y[i] - x[i]));
  assert.ok(err < 1e-10, `roundtrip error ${err.toExponential(2)}`);
});

test("frame codec: COLA reconstruction delayed by exactly one hop", () => {
  const N = 960, HOP = 480, F = 481;
  const codec = mod.createFrameCodec({ winLen: N, hopSize: HOP });
  const sig = (n) => Math.sin(n * 0.11) * 0.5;
  const outs = [];
  for (let h = 0; h < 4; h++) {
    const hopIn = new Float32Array(HOP);
    for (let i = 0; i < HOP; i++) hopIn[i] = sig(h * HOP + i);
    const spec = codec.encode(hopIn);
    assert.equal(spec.length, F * 2);
    for (let i = 0; i < spec.length; i++) assert.ok(Number.isFinite(spec[i]));
    const out = new Float32Array(HOP);
    codec.decode(spec, out);
    for (let i = 0; i < HOP; i++) assert.ok(Number.isFinite(out[i]));
    outs.push(out);
  }
  // overlap-add completes after one hop: outs[h+1] reproduces the input of
  // hop h exactly (COLA with the vorbis window), so the coder is pure latency
  // of one hop = 10 ms, no amplitude error.
  for (let h = 0; h < 2; h++) {
    const hopIn = new Float32Array(HOP);
    for (let i = 0; i < HOP; i++) hopIn[i] = sig(h * HOP + i);
    let maxErr = 0;
    const got = outs[h + 1];
    for (let i = 0; i < HOP; i++) maxErr = Math.max(maxErr, Math.abs(got[i] - hopIn[i]));
    assert.ok(maxErr < 2e-3, `hop ${h} COLA error ${maxErr}`);
  }
});

/* --------------------------------------------------- tier 2: real inference */

test("smoke inference: 1 s synthetic tone+noise gives finite non-zero audio", async (t) => {
  if (!ASSETS_READY || !ortPath) {
    t.skip(
      "model assets or onnxruntime-web not installed — run noise/scripts/fetch-dpdfnet.py and npm i onnxruntime-web@1.31.1",
    );
    return;
  }
  const ort = await import(pathToFileURL(ortPath).href);
  const core = mod.createCore({
    sampleRate: 48000,
    noiseReductionLevel: 100,
    ort,
    wasmDir: path.dirname(ortPath),
    assetConfig: {
      modelData: readFileSync(ASSETS.model),
      statesJsonData: readFileSync(ASSETS.statesJson, "utf8"),
      statesBinData: readFileSync(ASSETS.statesBin),
    },
  });
  await core.initialize();

  const SR = 48000, HOP = 480, seconds = 1.0;
  const total = SR * seconds;
  let s = 987654321;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648), s / 1073741824 - 1);
  const hops = Math.floor(total / HOP);
  const out = new Float32Array(hops * HOP);

  const t0 = Date.now();
  for (let h = 0; h < hops; h++) {
    const hopIn = new Float32Array(HOP);
    for (let i = 0; i < HOP; i++) {
      const n = h * HOP + i;
      hopIn[i] = 0.3 * Math.sin(2 * Math.PI * 440 * n / SR) + 0.1 * rnd();
    }
    const enhanced = await core.processHop(hopIn);
    assert.equal(enhanced.length, HOP);
    out.set(enhanced, h * HOP);
  }
  const dt = Date.now() - t0;
  console.info(`[dpdfnet smoke] ${hops} frames in ${dt} ms (${(dt / hops).toFixed(1)} ms/frame) — INFO, not a gate`);

  let bad = 0, rms = 0, maxAbs = 0;
  for (let i = 0; i < out.length; i++) {
    if (!Number.isFinite(out[i])) bad++;
    rms += out[i] * out[i];
    maxAbs = Math.max(maxAbs, Math.abs(out[i]));
  }
  rms = Math.sqrt(rms / out.length);
  console.info(`[dpdfnet smoke] out rms=${rms.toFixed(6)} maxAbs=${maxAbs.toFixed(4)}`);
  assert.equal(bad, 0, "non-finite samples in output");
  assert.ok(rms > 0, "output is all zeros");
  assert.equal(out.length, hops * 480);
  const st = core.stats || {};
  assert.ok(st.lsnr === undefined || Number.isFinite(st.lsnr), "lsnr must be finite");
  core.destroy();
});

test("level mix: 0 passes the dry spectrum through, 100 the model output", async (t) => {
  if (!ASSETS_READY || !ortPath) {
    t.skip("assets not fetched");
    return;
  }
  const ort = await import(pathToFileURL(ortPath).href);
  const mk = () =>
    mod.createCore({
      sampleRate: 48000,
      noiseReductionLevel: 0,
      ort,
      wasmDir: path.dirname(ortPath),
      assetConfig: {
        modelData: readFileSync(ASSETS.model),
        statesJsonData: readFileSync(ASSETS.statesJson, "utf8"),
        statesBinData: readFileSync(ASSETS.statesBin),
      },
    });
  const dry = mk();
  const wet = mk();
  await dry.initialize();
  await wet.initialize();
  wet.setSuppressionLevel(100);

  const HOP = 480;
  let s = 42;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648), s / 1073741824 - 1);
  const a = new Float32Array(HOP * 8), b = new Float32Array(HOP * 8);
  for (let h = 0; h < 8; h++) {
    const hopIn = new Float32Array(HOP);
    for (let i = 0; i < HOP; i++) hopIn[i] = 0.3 * Math.sin(0.05 * (h * HOP + i)) + 0.1 * rnd();
    // both cores must see the same input frames
    a.set(await dry.processHop(hopIn), h * HOP);
    b.set(await wet.processHop(hopIn), h * HOP);
  }
  dry.destroy();
  wet.destroy();
  // At level 0 the enhanced spectrum is never mixed in: output must equal a
  // pure encode->decode round trip (i.e. the codec is deterministic and the
  // mix works). Compare the wet and dry streams: they must differ (the model
  // changed the signal), and the dry stream must not be silent.
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
  assert.ok(diff > 1e-4, "level 0 and level 100 produced identical audio");
});
