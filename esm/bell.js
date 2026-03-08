/**
 * @fileoverview Bell synthesis engine — Data, Audio Engine, Sequencer.
 *
 * Intended use: breathing-exercise PWA.
 *   - Inhale cue: strike a bell at its natural pitch.
 *   - Exhale cue: strike the same bell via an engine with pitchShift < 1
 *                 (slightly lower pitch signals the transition to exhale).
 *   - Sound duration is controlled per-strike via durationSec (2–8 s).
 *     Without it the bell rings freely to its natural T60 (tens of seconds).
 *
 * Breathing-exercise usage example:
 * @example
 * const actx        = new AudioContext();
 * const inhale      = createEngine(actx.destination);
 * const exhale      = createEngine(actx.destination, { pitchShift: 0.92 });
 * inhale.strike(BELLS[0], { durationSec: 4 });  // bell in  → 4 s inhale
 * exhale.strike(BELLS[0], { durationSec: 6 });  // bell out → 6 s exhale
 */


// ---------------------------------------------------------------------------
// SECTION 1 — DATA
// ---------------------------------------------------------------------------

/**
 * Maps human-readable bell names to their original source recording filenames.
 * @type {Object.<string, string>}
 */
const SOURCES = {
  'Bell 1': 'Bell2.mp3',
  'Bell 2': 'sBell2.mp3',
};

/**
 * One spectral component of a bell, measured from a recording by
 * log-linear regression over the full file duration.
 *
 * @typedef {Object} Partial
 * @property {string}      label
 *   Campanology name. One of:
 *   'Prime' | 'Nominal' | 'Superquint' | 'Oct·Nominal' | 'Sub' | 'Mains hum'
 * @property {number}      f1
 *   Frequency in Hz. Always present.
 * @property {number|null} f2
 *   Second frequency of a doublet pair in Hz, or null for a single tone.
 *   Beat frequency = |f1 − f2|.
 * @property {number}      gain
 *   Relative amplitude. Normalised so the Prime partial = 1.0.
 * @property {number}      t60
 *   Natural decay time in seconds (time for the partial to fall 60 dB).
 *   Fitted from the full recording via log-linear regression.
 * @property {number}      atkMs
 *   Attack ramp duration in milliseconds.
 *   ≤ 5 ms  → instant onset (percussive partials such as Prime).
 *   > 5 ms  → linear swell (models resonance build-up, e.g. Nominal at 70 ms).
 * @property {boolean}     enabled
 *   Whether this partial is active by default.
 */

/**
 * Complete spectral definition of one bell.
 *
 * @typedef {Object} BellDef
 * @property {string}    name     - Display name, e.g. 'Bell 1 · 621 Hz'.
 * @property {string}    source   - Original recording filename (see SOURCES).
 * @property {Partial[]} partials - Spectral components, ordered low → high frequency.
 */

/**
 * Bell definitions fitted from original recordings.
 * The first entry is the reference bell for blending (see blendBells).
 * @type {BellDef[]}
 */
const BELLS = [
  {
    name: 'Bell 1 · 621 Hz',
    source: SOURCES['Bell 1'],
    partials: [
      // Sub — anomalous low doublet, 2.25 Hz beat, fast single-strike transient only
      { label:'Sub',         f1:222.45, f2:220.20, gain:0.50, t60:0.4,  atkMs:4,  enabled:true },
      // Prime — dominant at onset, 8.2 Hz doublet beat
      { label:'Prime',       f1:621.00, f2:612.80, gain:1.00, t60:48,   atkMs:4,  enabled:true },
      // Nominal — swells over 70 ms, dominates sustain, 6 Hz doublet beat
      { label:'Nominal',     f1:1153.6, f2:1147.6, gain:1.55, t60:59,   atkMs:70, enabled:true },
      // Superquint — brief transient, gone by ~150 ms
      { label:'Superquint',  f1:1796.0, f2:null,   gain:0.20, t60:0.15, atkMs:4,  enabled:true },
      // Oct·Nominal — bright clang, very long decay
      { label:'Oct·Nominal', f1:3382.0, f2:null,   gain:0.70, t60:145,  atkMs:4,  enabled:true },
    ],
  },
  {
    name: 'Bell 2 · 694 Hz',
    source: SOURCES['Bell 2'],
    partials: [
      // Prime — dominant at onset, 2.02 Hz doublet beat
      { label:'Prime',       f1:694.22, f2:696.25, gain:1.00, t60:48,   atkMs:4,  enabled:true },
      // Nominal — swells over 50 ms, dominates sustain
      { label:'Nominal',     f1:1924.8, f2:null,   gain:1.40, t60:29,   atkMs:50, enabled:true },
      // Superquint
      { label:'Superquint',  f1:3580.4, f2:null,   gain:0.35, t60:23,   atkMs:4,  enabled:true },
      // Mains hum — 60 Hz recording artefact, not a bell partial; disabled by default
      { label:'Mains hum',   f1:60.0,   f2:null,   gain:0.15, t60:200,  atkMs:4,  enabled:false },
    ],
  },
];


// ---------------------------------------------------------------------------
// SECTION 2 — AUDIO ENGINE
// Pure Web Audio API. No DOM references.
// ---------------------------------------------------------------------------

/** @constant {number} ln(1000) — converts T60 to RC time constant: τ = T60 / LN1000 */
const LN1000 = 6.9078;

/**
 * Schedules a sine oscillator with an exponential decay envelope.
 * Private — called only from within strike().
 *
 * @param {number}   freq    - Frequency in Hz.
 * @param {number}   gain    - Peak amplitude (linear).
 * @param {number}   t60     - Natural decay time in seconds.
 * @param {number}   atkSec  - Attack ramp in seconds (0 = instant).
 * @param {number}   fadeSec - If > 0, overrides natural decay with a short
 *                             fade-out starting at t0 + fadeSec. Used to
 *                             enforce durationSec on each partial.
 * @param {number}   t0      - AudioContext time to begin playback.
 * @param {GainNode} busNode - Destination node in the audio graph.
 * @returns {number} AudioContext time when the oscillator node stops.
 */
function _addOscillator(freq, gain, t60, atkSec, fadeSec, t0, busNode) {
  const actx   = busNode.context;
  const tau    = t60 / LN1000;
  const stopAt = t0 + Math.min(t60 * 2.0, 90);

  const osc = actx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = freq;

  const env = actx.createGain();
  if (atkSec <= 0.005) {
    env.gain.setValueAtTime(gain, t0);
  } else {
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(gain, t0 + atkSec);
  }
  env.gain.setTargetAtTime(0.0001, t0 + Math.max(atkSec, 0.001), tau);

  if (fadeSec > 0) {
    // Controlled fade-out: cancel the natural decay at durationSec and replace
    // it with a short exponential fade (≤ 500 ms, 10% of durationSec).
    const fadeStart = t0 + fadeSec;
    const fadeDur   = Math.min(0.5, fadeSec * 0.1);
    env.gain.cancelScheduledValues(fadeStart);
    env.gain.setTargetAtTime(0.0001, fadeStart, fadeDur / 3);
  }

  osc.connect(env);
  env.connect(busNode);
  osc.start(t0);
  osc.stop(fadeSec > 0 ? t0 + fadeSec + 2 : stopAt);
  return      fadeSec > 0 ? t0 + fadeSec + 2 : stopAt;
}

/**
 * Schedules a bandpass-filtered noise burst modelling the strike transient.
 * Private — called only from within strike().
 *
 * @param {number}   primef1    - Bandpass centre frequency in Hz (tracks pitchShift).
 * @param {number}   noiseAmt   - Noise amplitude scalar (0–0.5).
 * @param {number}   masterGain - Master amplitude scalar.
 * @param {number}   t0         - AudioContext start time.
 * @param {GainNode} busNode    - Destination node in the audio graph.
 */
function _addNoise(primef1, noiseAmt, masterGain, t0, busNode) {
  const actx   = busNode.context;
  const bufLen = Math.ceil(actx.sampleRate * 0.08);
  const nb     = actx.createBuffer(1, bufLen, actx.sampleRate);
  const nd     = nb.getChannelData(0);
  for (let i = 0; i < bufLen; i++) nd[i] = Math.random() * 2 - 1;

  const ns  = actx.createBufferSource(); ns.buffer = nb;
  const nbp = actx.createBiquadFilter();
  nbp.type = 'bandpass';
  nbp.frequency.value = primef1;
  nbp.Q.value = 1.0;

  const ng = actx.createGain();
  ng.gain.setValueAtTime(noiseAmt * masterGain, t0);
  ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.025);

  ns.connect(nbp); nbp.connect(ng); ng.connect(busNode);
  ns.start(t0); ns.stop(t0 + 0.09);
}

/**
 * Options passed to engine.strike().
 *
 * @typedef {Object} StrikeOptions
 * @property {number} [masterGain=0.55]
 *   Overall amplitude scalar (0–1).
 * @property {number} [noiseAmt=0.15]
 *   Strike-noise amplitude (0–0.5). Set to 0 to silence the transient click.
 * @property {number} [offsetSec=0]
 *   Delay before the sound starts, in seconds. Useful for pre-scheduling
 *   a sequence of strikes relative to a shared reference time.
 * @property {number} [durationSec=0]
 *   Controlled fade-out time in seconds after the strike.
 *   0     → bell rings freely to its natural T60 (tens of seconds).
 *   2–8   → recommended range for breathing-exercise inhale/exhale cues.
 *   The bell sounds naturally from the strike onset, then fades smoothly
 *   over ≤ 500 ms beginning at durationSec.
 */

/**
 * A running synthesis engine returned by createEngine or createMixedEngine.
 *
 * @typedef {Object} Engine
 * @property {function(BellDef, StrikeOptions=): void} strike
 *   Synthesises and schedules one bell strike.
 *   Safe to call while a previous strike is still ringing —
 *   strikes accumulate naturally, as on a real bell.
 * @property {AnalyserNode} analyser
 *   Web Audio AnalyserNode on the engine output.
 *   Connect to a waveform or spectrum visualiser.
 */

/**
 * Creates a bell synthesis engine connected to a given audio destination.
 *
 * Each call produces an independent engine with its own internal audio
 * sub-graph. Multiple engines can share the same AudioContext.
 *
 * @param {AudioNode} destination - Web Audio node to connect output to.
 * @param {Object}    [options]
 * @param {number}    [options.pitchShift=1.0]
 *   Frequency multiplier applied uniformly to every partial and to the
 *   strike-noise bandpass centre. Supported range: 0.5–2.0.
 *   The doublet beat frequencies scale proportionally (physically correct).
 *   Breathing-exercise usage: use ~0.85–0.95 for the exhale engine so the
 *   lower pitch cues the transition from inhale to exhale.
 * @param {boolean}   [options.suppressDoublets=false]
 *   When true, only f1 is synthesised for each partial (f2 is ignored).
 *   Set automatically by createMixedEngine() for pitch-shifted constituent
 *   bells, preventing artefact beating between unrelated doublet asymmetries.
 * @returns {Engine}
 */
function createEngine(destination, { pitchShift = 1.0, suppressDoublets = false } = {}) {
  const actx     = destination.context;
  const analyser = actx.createAnalyser();
  analyser.fftSize = 1024;
  const masterBus = actx.createGain();
  masterBus.connect(analyser);
  analyser.connect(destination);

  function strike(bellDef, {
    masterGain  = 0.55,
    noiseAmt    = 0.15,
    offsetSec   = 0,
    durationSec = 0,
  } = {}) {
    if (actx.state === 'suspended') actx.resume();

    const t0      = actx.currentTime + 0.005 + offsetSec;
    const fadeSec = durationSec > 0 ? durationSec : 0;
    const bus     = actx.createGain();
    bus.gain.value = 1;
    bus.connect(masterBus);

    let maxStop = t0 + 1;

    bellDef.partials.forEach(p => {
      if (!p.enabled || p.gain < 0.001) return;
      const atkSec = p.atkMs / 1000;

      // Doublet: two oscillators at f1 (full gain) and f2 (88% gain).
      // suppressDoublets: use only f1 — avoids artefact beating when mixing
      // bells whose doublet asymmetries are physically unrelated.
      const tones = (p.f2 && !suppressDoublets)
        ? [[p.f1 * pitchShift, 1.00], [p.f2 * pitchShift, 0.88]]
        : [[p.f1 * pitchShift, 1.00]];

      tones.forEach(([freq, frac]) => {
        const g    = p.gain * frac * masterGain * 0.3;
        const stop = _addOscillator(freq, g, p.t60, atkSec, fadeSec, t0, bus);
        maxStop = Math.max(maxStop, stop);
      });
    });

    if (noiseAmt > 0.001) {
      const primef1 = bellDef.partials.find(p => p.label === 'Prime')?.f1 ?? 700;
      _addNoise(primef1 * pitchShift, noiseAmt, masterGain, t0, bus);
    }

    setTimeout(() => { try { bus.disconnect(); } catch (_) {} },
      (maxStop - actx.currentTime + 2) * 1000);
  }

  return { strike, analyser };
}


// ---------------------------------------------------------------------------
// SECTION 2b — MIXED ENGINE
// ---------------------------------------------------------------------------

/**
 * Blends the spectral character of multiple BellDefs into one new BellDef.
 *
 * All frequencies (f1, f2, atkMs) come from the first (reference) entry
 * unchanged. For each partial label present in the reference bell, gain
 * and T60 are computed as weighted averages across all entries that carry
 * that label. Each bell's gains are first normalised relative to its own
 * Prime so that bells with different absolute levels contribute proportionally.
 * Partials unique to non-reference bells are silently ignored — they have no
 * corresponding frequency in the reference.
 *
 * @param {Array<{bellDef: BellDef, weight: number}>} entries
 *   Bells to blend. First entry is the reference (supplies all frequencies).
 *   weight: 0.0–1.0, the bell's contribution to the spectral blend.
 * @returns {BellDef} A new BellDef named 'Mixed' with blended gain/T60 values.
 */
function blendBells(entries) {
  const reference = entries[0].bellDef;

  const blendedPartials = reference.partials.map(refPartial => {
    let gainSum = 0, t60Sum = 0, wSum = 0;

    entries.forEach(({ bellDef, weight }) => {
      const match = bellDef.partials.find(p => p.label === refPartial.label);
      if (match && match.enabled) {
        // Normalise each bell's gain relative to its own Prime before averaging,
        // so bells with different absolute levels contribute proportionally.
        const ownPrime = bellDef.partials.find(p => p.label === 'Prime');
        const normGain = ownPrime ? match.gain / ownPrime.gain : match.gain;
        gainSum += normGain * weight;
        t60Sum  += match.t60 * weight;
        wSum    += weight;
      }
    });

    if (wSum === 0) return { ...refPartial }; // unique to reference — keep as-is

    // Re-scale blended gain back relative to reference Prime gain
    const refPrime     = reference.partials.find(p => p.label === 'Prime');
    const refPrimeGain = refPrime ? refPrime.gain : 1.0;

    return {
      ...refPartial,
      gain: (gainSum / wSum) * refPrimeGain,
      t60:   t60Sum  / wSum,
      // atkMs kept from reference: attack shape reflects reference bell geometry
    };
  });

  return { ...reference, name: 'Mixed', partials: blendedPartials };
}

/**
 * Creates an engine that plays a spectral blend of multiple bells.
 *
 * Internally uses a single createEngine() instance — no frequency duplication,
 * no artefact beating between unrelated doublet asymmetries. All frequencies
 * remain those of the first (reference) entry in entries.
 *
 * @param {AudioNode} destination - Web Audio node to connect output to.
 * @param {Array<{bellDef: BellDef, weight: number}>} entries
 *   Bells to blend. First entry is the reference (supplies all frequencies).
 * @returns {Engine}
 */
function createMixedEngine(destination, entries) {
  const blended            = blendBells(entries);
  const { strike: _strike, analyser } = createEngine(destination);

  /**
   * Plays the blended bell. The bellDef argument is intentionally ignored —
   * the spectral blend is fixed at construction time via blendBells().
   * @param {BellDef}       _ignored
   * @param {StrikeOptions} [params]
   */
  function strike(_ignored, params = {}) {
    _strike(blended, params);
  }

  return { strike, analyser };
}


// ---------------------------------------------------------------------------
// SECTION 3 — SEQUENCER
// ---------------------------------------------------------------------------

/**
 * Named timing patterns: arrays of millisecond offsets from the first strike.
 * @type {Object.<string, number[]>}
 */
const PATTERNS = {
  slow:     [0, 3000, 6000, 9000, 12000, 15000],
  carillon: [0, 130, 260, 390, 520, 780, 910, 1040, 1300, 1560, 1820, 2080],
};

/**
 * A running sequencer returned by createSequencer().
 *
 * @typedef {Object} Sequencer
 * @property {function(number[]): void} play
 *   Schedule a pattern of strikes. Any currently running pattern is cancelled first.
 * @property {function(): void}         stop
 *   Cancel all pending strikes immediately.
 * @property {typeof PATTERNS}          PATTERNS
 *   Reference to the named pattern library.
 */

/**
 * Creates a sequencer that calls a strike function on a millisecond-offset pattern.
 * No knowledge of audio or the DOM — depends only on setTimeout / clearTimeout.
 *
 * @param {function(): void} strikeFn
 *   Called once per scheduled strike. Typically a closure:
 *   () => engine.strike(bellDef, { durationSec: 4 })
 * @returns {Sequencer}
 */
function createSequencer(strikeFn) {
  let _ids = [];

  /** @param {number[]} pattern - Array of millisecond offsets from now. */
  function play(pattern) {
    stop();
    pattern.forEach(ms => { _ids.push(setTimeout(strikeFn, ms)); });
  }

  function stop() {
    _ids.forEach(clearTimeout);
    _ids = [];
  }

  return { play, stop, PATTERNS };
}

export { createEngine, createMixedEngine, blendBells, createSequencer, PATTERNS, SOURCES, BELLS };
