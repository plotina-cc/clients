/**
 * Objective check of the denoiser itself, without an account and without a
 * real microphone.
 *
 * In the page, a synthetic white-noise MediaStreamTrack is fed to the very
 * same processor module the app loads (`/noise/vendor/dfn.esm.js`, the same
 * WASM and model under `/noise/dfn`). The spectral energy of the input track
 * and of `processor.processedTrack` is then measured with AnalyserNodes in the
 * 300–3400 Hz band, and the difference is asserted.
 *
 * Why this shape: the production wrapper exposes only `{status, level, error,
 * track}` in `window.__plotinaDfn`, where `track` is a string, and the app
 * keeps the LiveKit room private. Measuring the published track from the test
 * would therefore need a production change (`processedTrack` on
 * `window.__plotinaDfn`); README.md describes that change. Until then this
 * test proves the processor and its assets work in a real browser and that
 * the model actually attenuates noise, which is the part that can silently
 * regress when the WASM, the model or the worklet breaks.
 */
import { expect, test } from "@playwright/test";

interface EffectResult {
  ok: boolean;
  error?: string;
  sampleRate: number;
  ctxState: string;
  initMs: number;
  measureMs: number;
  level: number;
  inputBandDb: number;
  outputBandDb: number;
  reductionDb: number;
  inputRms: number;
  outputRms: number;
  samples: number;
}

test.describe("DeepFilterNet3 in the browser", () => {
  test("synthetic noise in 300–3400 Hz is attenuated by the processor", async ({
    page,
  }, testInfo) => {
    // 24 MB of assets on a cold edge cache, then a 2 s measurement window.
    test.setTimeout(300_000);

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto("/login", { waitUntil: "domcontentloaded" });

    const result: EffectResult = await page.evaluate(async () => {
      const started = performance.now();

      const ctx = new AudioContext({
        sampleRate: 48_000,
        latencyHint: "interactive",
      });
      await ctx.resume().catch(() => {});
      const sampleRate = ctx.sampleRate;

      // Deterministic white noise, 2 s looped. 0.12 amplitude is a normal
      // microphone level and leaves headroom.
      const seconds = 2;
      const noiseBuffer = ctx.createBuffer(1, sampleRate * seconds, sampleRate);
      const samples = noiseBuffer.getChannelData(0);
      let seed = 0x12345678;
      for (let i = 0; i < samples.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        samples[i] = ((seed / 0x100000000) * 2 - 1) * 0.12;
      }

      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;
      noise.loop = true;
      const inputDest = ctx.createMediaStreamDestination();
      noise.connect(inputDest);
      noise.start();

      const inputTrack = inputDest.stream.getAudioTracks()[0];
      if (!inputTrack) throw new Error("could not create the input track");

      const moduleUrl = "/noise/vendor/dfn.esm.js";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import(moduleUrl);
      const Processor = mod.DeepFilterNoiseFilterProcessor;
      if (!Processor) {
        throw new Error(
          "DeepFilterNoiseFilterProcessor is not exported by " + moduleUrl,
        );
      }

      const level = 70; // DEFAULT_LEVEL of noise/plotina-dfn.js
      const processor = new Processor({
        sampleRate,
        noiseReductionLevel: level,
        enabled: true,
        assetConfig: { cdnUrl: "/noise/dfn" },
      });
      await processor.init({ track: inputTrack });

      const processed: MediaStreamTrack | undefined = processor.processedTrack;
      if (!processed) {
        throw new Error("the processor did not expose processedTrack");
      }
      const initMs = performance.now() - started;

      const fftSize = 2048;
      const analyserIn = ctx.createAnalyser();
      analyserIn.fftSize = fftSize;
      analyserIn.smoothingTimeConstant = 0;
      ctx
        .createMediaStreamSource(new MediaStream([inputTrack]))
        .connect(analyserIn);

      const analyserOut = ctx.createAnalyser();
      analyserOut.fftSize = fftSize;
      analyserOut.smoothingTimeConstant = 0;
      ctx
        .createMediaStreamSource(new MediaStream([processed]))
        .connect(analyserOut);

      // Keep both analysers in a rendered graph: an AnalyserNode alone is not
      // a sink, and a muted gain costs nothing.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      analyserIn.connect(mute);
      analyserOut.connect(mute);
      mute.connect(ctx.destination);

      const bandDb = (analyser: AnalyserNode): number => {
        const spectrum = new Float32Array(analyser.frequencyBinCount);
        analyser.getFloatFrequencyData(spectrum);
        const hzPerBin = ctx.sampleRate / analyser.fftSize;
        const first = Math.max(0, Math.ceil(300 / hzPerBin));
        const last = Math.min(
          spectrum.length - 1,
          Math.floor(3400 / hzPerBin),
        );
        let power = 0;
        let count = 0;
        for (let i = first; i <= last; i++) {
          const db = spectrum[i];
          power += Number.isFinite(db) ? Math.pow(10, db / 10) : 0;
          count++;
        }
        return count ? 10 * Math.log10(power / count) : Number.NEGATIVE_INFINITY;
      };
      const rms = (analyser: AnalyserNode): number => {
        const time = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(time);
        let sum = 0;
        for (let i = 0; i < time.length; i++) sum += time[i] * time[i];
        return Math.sqrt(sum / time.length);
      };
      const toPowerMeanDb = (values: number[]): number => {
        const power =
          values.reduce((sum, db) => sum + Math.pow(10, db / 10), 0) /
          values.length;
        return 10 * Math.log10(power);
      };

      // Let the model settle (it starts by emitting silence).
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const measuredFrom = performance.now();
      const inputReadings: number[] = [];
      const outputReadings: number[] = [];
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        inputReadings.push(bandDb(analyserIn));
        outputReadings.push(bandDb(analyserOut));
      }
      const measureMs = performance.now() - measuredFrom;

      const inputBandDb = toPowerMeanDb(inputReadings);
      const outputBandDb = toPowerMeanDb(outputReadings);

      return {
        ok: true,
        sampleRate,
        ctxState: ctx.state,
        initMs,
        measureMs,
        level,
        inputBandDb,
        outputBandDb,
        reductionDb: inputBandDb - outputBandDb,
        inputRms: rms(analyserIn),
        outputRms: rms(analyserOut),
        samples: inputReadings.length,
      };
    });

    console.log(
      "[e2e] DFN band energy 300–3400 Hz:",
      JSON.stringify({
        inputDb: Number(result.inputBandDb?.toFixed(2)),
        outputDb: Number(result.outputBandDb?.toFixed(2)),
        reductionDb: Number(result.reductionDb?.toFixed(2)),
        inputRms: Number(result.inputRms?.toFixed(4)),
        outputRms: Number(result.outputRms?.toFixed(4)),
        initMs: Math.round(result.initMs ?? 0),
        sampleRate: result.sampleRate,
        ctxState: result.ctxState,
      }),
    );

    await testInfo.attach("dfn-effect.json", {
      body: JSON.stringify({ ...result, consoleErrors }, null, 2),
      contentType: "application/json",
    });

    expect(result.ok, result.error).toBe(true);
    expect(
      result.ctxState,
      "the AudioContext must be running for the measurement to mean anything",
    ).toBe("running");
    expect(
      result.inputBandDb,
      "the input must carry audible noise in the measured band",
    ).toBeGreaterThan(-80);
    expect(
      result.reductionDb,
      `DeepFilterNet3 must attenuate 300–3400 Hz (in ${result.inputBandDb.toFixed(
        1,
      )} dB, out ${result.outputBandDb.toFixed(1)} dB)`,
    ).toBeGreaterThanOrEqual(3);
  });
});
