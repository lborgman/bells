/**
 * @fileoverview Bell synthesis engine — Data, Audio Engine, Patterns.
 *
 * Intended use: breathing-exercise PWA.
 *   - Inhale cue: strike a bell at its natural pitch.
 *   - Exhale cue: strike the same bell via an engine with pitchShift < 1
 *                 (slightly lower pitch signals the transition to exhale).
 *   - Sound duration is controlled per-strike via stopAtSec (2–8 s).
 *     Without it the bell rings freely to its natural T60 (tens of seconds).
 *   - stopAtSec provides a hard cut (with 300 ms ramp) at a precise time,
 *     used by the square breathing cycle to silence sound at phase boundaries.
 *
 * Breathing-exercise usage example:
 * @example
 * const inhale = createInternalSyntheticBell(BELLS[0]);
 * const exhale = createInternalSyntheticBell(BELLS[0], { pitchShift: 0.92 });
 * strikeBell(inhale, { stopAtSec: 4 });  // bell in  → 4 s inhale
 * strikeBell(exhale, { stopAtSec: 6 });  // bell out → 6 s exhale
 */


// ---------------------------------------------------------------------------
// SECTION 1 — DATA
// ---------------------------------------------------------------------------

/**
 * Maps human-readable bell names to their original source recording filenames.
 * @type {Object.<string, string>}
 */
const SOURCES = {
  'Bowl 1': null,   // synthetic — no source recording
  'Bowl 2': null,
};

/**
 * One spectral component of a bell, measured from a recording by
 * log-linear regression over the full file duration.
 *
 * @typedef {Object} Partial
 * @property {string}      label
 *   Campanology name. One of:
 *   'Prime' | 'Nominal' | 'Quint'
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
 * @property {string}    name     - Display name, e.g. 'Bowl 1 · 432 Hz'.
 * @property {string}    source   - Original recording filename, or null if synthetic.
 * @property {Partial[]} partials - Spectral components, ordered low → high frequency.
 */

/**
 * Synthetic Tibetan singing bowl definitions.
 *
 * Partial ratios follow measured singing bowl acoustics:
 *   Prime    1.00×  — strike note, gentle swell, slow doublet shimmer (~1 Hz)
 *   Nominal  2.00×  — strong octave, warm sustain, core of the "singing" tone
 *   Quint    2.75×  — softer fifth above octave, adds gentle brightness
 *
 * All T60 values are long enough to ring freely but controlled via stopAtSec
 * in the breathing-exercise PWA. No harsh high partials (no Superquint or
 * Oct·Nominal). Doublet beats are slow (0.8–1.2 Hz) — calming rather than agitating.
 *
 * The first entry is the reference bowl for blending.
 * @type {BellDef[]}
 */
const BELLS = [
  {
    // Bowl 1 — warmer, more fundamental weight
    // Reference pitch 432 Hz (common for meditation contexts).
    // Adjust via pitchShift on createInternalSyntheticBell() as needed.
    name: 'Bowl 1 · 432 Hz',
    source: SOURCES['Bowl 1'],
    partials: [
      // Prime — gentle 30 ms swell, 0.8 Hz doublet shimmer
      { label:'Prime',    f1:432.0,  f2:432.8,  gain:1.00, t60:20, atkMs:30,  enabled:true },
      // Nominal — swell over 80 ms, strong and warm, very slow 1.0 Hz shimmer
      { label:'Nominal',  f1:864.0,  f2:865.0,  gain:0.90, t60:25, atkMs:80,  enabled:true },
      // Quint — soft, swells over 60 ms, fades faster
      { label:'Quint',    f1:1188.0, f2:null,   gain:0.25, t60:12, atkMs:60,  enabled:true },
    ],
  },
  {
    // Bowl 2 — slightly brighter, more Nominal presence
    // Same reference pitch, different spectral balance and beat rates.
    name: 'Bowl 2 · 432 Hz',
    source: SOURCES['Bowl 2'],
    partials: [
      // Prime — slightly faster 1.2 Hz shimmer
      { label:'Prime',    f1:432.0,  f2:433.2,  gain:1.00, t60:18, atkMs:25,  enabled:true },
      // Nominal — louder relative to Prime, 0.6 Hz very slow shimmer
      { label:'Nominal',  f1:864.0,  f2:864.6,  gain:1.10, t60:28, atkMs:90,  enabled:true },
      // Quint — a touch brighter
      { label:'Quint',    f1:1188.0, f2:null,   gain:0.30, t60:10, atkMs:50,  enabled:true },
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
 * Per-partial amplitude scale factor.
 * Prevents clipping when multiple partials sum at the output.
 * With 3 partials at gain ≈ 1.0 each, the unscaled peak sum would approach 3.0.
 * Dividing by the expected partial count (here 3) keeps the headroom comfortable.
 * Adjust if bells with significantly more or fewer partials are added.
 * @constant {number}
 */
const PARTIAL_SCALE = 1 / 3;

/**
 * Schedules a sine oscillator with an exponential decay envelope.
 * Private — called only from within strike().
 *
 * @param {number}   freq    - Frequency in Hz.
 * @param {number}   gain    - Peak amplitude (linear).
 * @param {number}   t60     - Natural decay time in seconds.
 * @param {number}   atkSec  - Attack ramp in seconds (0 = instant).
 * @param {number}   t0      - AudioContext time to begin playback.
 * @param {GainNode} busNode - Destination node in the audio graph.
 * @returns {number} AudioContext time when the oscillator node stops.
 */
function _addOscillator(freq, gain, t60, atkSec, t0, busNode) {
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

  osc.connect(env);
  env.connect(busNode);
  osc.start(t0);
  osc.stop(stopAt);
  return stopAt;
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
 * Options passed to strikeBell().
 *
 * @typedef {Object} StrikeOptions
 * @property {number} [masterGain=1.0]
 *   Overall amplitude scalar (0–1).
 * @property {number} [noiseAmt=0.15]
 *   Strike-noise amplitude (0–0.5). Set to 0 to silence the transient click.
 * @property {number} [offsetSec=0]
 *   Delay before the sound starts, in seconds. Useful for pre-scheduling
 *   a sequence of strikes relative to a shared reference time.
 * @property {number} [stopAtSec=0]
 *   Scheduled stop time in seconds after the strike. The bus gain is ramped
 *   to zero over msFade ms, ending at t0 + stopAtSec.
 *   0 → bell rings freely to its natural T60.
 *   For an interactive stop at any time, use the StrikeHandle returned by strikeBell().
 * @property {number} [msFade=300]
 *   Fade duration in milliseconds used by both stopAtSec and handle.stop().
 *   300 ms is clearly audible but not abrupt.
 */

/**
 * A bell ready to be struck, returned by createInternalSyntheticBell()
 * or createExternalBellFromFile(). Pass to strikeBell() or strikeBreath().
 *
 * @typedef {Object} Bell
 * @property {'synthetic'|'file'} type  - How the bell was created.
 * @property {AnalyserNode}   analyser  - Web Audio AnalyserNode on the bell output.
 *                                        Connect to a waveform or spectrum visualiser.
 * @property {function(StrikeOptions=): StrikeHandle} _strike
 *   Internal strike function. Use strikeBell() rather than calling this directly.
 */

/**
 * Handle returned by strikeBell(), allowing the caller to stop a strike
 * before it has finished ringing naturally.
 *
 * @typedef {Object} StrikeHandle
 * @property {function(number=): void} stop
 *   Fades out and silences this strike.
 *   @param {number} [msFade=300] - Fade duration in milliseconds.
 */

// ── Shared lazy AudioContext ──────────────────────────────────────────────────
// Created on first call to createInternalSyntheticBell or createExternalBellFromFile.
// Must be triggered by a user gesture to satisfy browser autoplay policy.
function _getActx() {
  if (!_getActx._actx) {
    _getActx._actx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return _getActx._actx;
}

// ── Private engine ────────────────────────────────────────────────────────────

function _createEngine(destination, { pitchShift = 1.0, suppressDoublets = false } = {}) {
  const actx     = destination.context;
  const analyser = actx.createAnalyser();
  analyser.fftSize = 1024;
  const masterBus = actx.createGain();
  masterBus.connect(analyser);
  analyser.connect(destination);

  function strike(bellDef, {
    masterGain  = 1.0,
    noiseAmt    = 0.15,
    offsetSec   = 0,
    stopAtSec   = 0,
    msFade      = 300,
  } = {}) {
    if (actx.state === 'suspended') actx.resume();

    const t0  = actx.currentTime + 0.005 + offsetSec;
    const bus = actx.createGain();
    bus.gain.value = 1;
    bus.connect(masterBus);

    // Scheduled stop: ramp bus gain to zero over msFade ms ending at t0 + stopAtSec.
    if (stopAtSec > 0) {
      const cutAt    = t0 + stopAtSec;
      const fadesSec = Math.max(0.005, msFade / 1000);
      bus.gain.setValueAtTime(1, cutAt - fadesSec);
      bus.gain.linearRampToValueAtTime(0, cutAt);
    }

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
        const g    = p.gain * frac * masterGain * PARTIAL_SCALE;
        const stop = _addOscillator(freq, g, p.t60, atkSec, t0, bus);
        maxStop = Math.max(maxStop, stop);
      });
    });

    if (noiseAmt > 0.001) {
      const primef1 = bellDef.partials.find(p => p.label === 'Prime')?.f1 ?? 700;
      _addNoise(primef1 * pitchShift, noiseAmt, masterGain, t0, bus);
    }

    setTimeout(() => { try { bus.disconnect(); } catch (_) {} },
      (maxStop - actx.currentTime + 2) * 1000);

    function stop(ms = 300) {
      const now      = actx.currentTime;
      const fadeSecs = Math.max(0.005, ms / 1000);
      bus.gain.cancelScheduledValues(now);
      bus.gain.setValueAtTime(bus.gain.value, now);
      bus.gain.linearRampToValueAtTime(0, now + fadeSecs);
    }

    return { stop };
  }

  return { strike, analyser };
}

function _createMixedEngine(destination, entries) {
  const blended               = blendBells(entries);
  const { strike: _s, analyser } = _createEngine(destination);
  function strike(params = {}) { return _s(blended, params); }
  return { strike, analyser };
}

// ── Public Bell API ───────────────────────────────────────────────────────────

// ── Validation helpers ────────────────────────────────────────────────────────
function _assertBellDef(bellDef, fnName) {
  if (!bellDef || !Array.isArray(bellDef.partials) || bellDef.partials.length === 0) {
    throw new TypeError(
      `${fnName}: bellDef must be an object with a non-empty partials array ` +
      `(got ${JSON.stringify(bellDef)})`
    );
  }
}

function _assertPitchShift(pitchShift, fnName) {
  if (typeof pitchShift !== 'number' || pitchShift <= 0) {
    throw new RangeError(
      `${fnName}: pitchShift must be a positive number (got ${pitchShift})`
    );
  }
}

function _assertBell(bell, fnName) {
  if (bell !== null && (typeof bell !== 'object' || typeof bell._strike !== 'function')) {
    throw new TypeError(
      `${fnName}: bell must be a Bell object returned by createInternalSyntheticBell ` +
      `or createExternalBellFromFile, or null (got ${JSON.stringify(bell)})`
    );
  }
}

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
 *   Bells to blend. Must contain at least one entry.
 *   First entry is the reference (supplies all frequencies).
 *   weight: 0.0–1.0, the bell's contribution to the spectral blend.
 * @returns {BellDef} A new BellDef named 'Mixed' with blended gain/T60 values.
 * @throws {TypeError}  If entries is not a non-empty array, or any entry is malformed.
 * @throws {RangeError} If any weight is not a finite number.
 */
function blendBells(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError(
      `blendBells: entries must be a non-empty array (got ${JSON.stringify(entries)})`
    );
  }
  entries.forEach((e, i) => {
    if (!e || typeof e !== 'object') {
      throw new TypeError(`blendBells: entries[${i}] must be an object`);
    }
    _assertBellDef(e.bellDef, `blendBells entries[${i}].bellDef`);
    if (typeof e.weight !== 'number' || !isFinite(e.weight)) {
      throw new RangeError(
        `blendBells: entries[${i}].weight must be a finite number (got ${e.weight})`
      );
    }
  });

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
 * Creates a synthetic bell from a BellDef, ready to be struck.
 *
 * @example
 * const inhale = createInternalSyntheticBell(BELLS[0]);
 * const exhale = createInternalSyntheticBell(BELLS[0], { pitchShift: 0.9 });
 * const handle = strikeBell(inhale, { stopAtSec: 4, msFade: 300 });
 * setTimeout(() => handle.stop(300), 2000);
 *
 * @param {BellDef} bellDef    - Bell definition from BELLS, or from blendBells().
 * @param {Object}  [options]
 * @param {number}  [options.pitchShift=1.0]
 *   Frequency multiplier (0.5–2.0). Use ~0.85–0.95 for an exhale bell.
 * @returns {Bell}
 */
function createInternalSyntheticBell(bellDef, { pitchShift = 1.0 } = {}) {
  _assertBellDef(bellDef, 'createInternalSyntheticBell');
  _assertPitchShift(pitchShift, 'createInternalSyntheticBell');
  const actx    = _getActx();
  const engine  = _createEngine(actx.destination, { pitchShift });
  return {
    type:     'synthetic',
    analyser: engine.analyser,
    _bellDef: bellDef,
    _strike:  (opts) => engine.strike(bellDef, opts),
  };
}

/**
 * Creates a bell from an audio file, ready to be struck.
 * The file is fetched and decoded once at creation time.
 * Only the requested excerpt is kept in memory — the full decoded buffer
 * is discarded after trimming.
 *
 * Supported formats: mp3, wav, ogg/vorbis, aac, flac, opus.
 * Exact support varies by browser/OS but all of the above work reliably
 * on iOS Safari, Android Chrome, and desktop browsers.
 *
 * Pitch is adjusted via AudioBufferSourceNode.playbackRate, so the timbre
 * changes naturally with pitch (as on a real instrument).
 *
 * @example
 * // Use a URL
 * const bowl = await createExternalBellFromFile('sounds/bowl.mp3', { startOffset: 0.5, duration: 6 });
 *
 * // Use a pre-fetched Response (e.g. from a service worker or cache)
 * const res  = await caches.match('sounds/bowl.mp3');
 * const bowl = await createExternalBellFromFile(res, { startOffset: 0.5, duration: 6 });
 *
 * const handle = strikeBell(bowl, { stopAtSec: 4, msFade: 300 });
 *
 * @param {string|Response} urlOrResponse
 *   URL string, or a pre-fetched Response object.
 *   Accepting a Response allows the caller to handle caching, auth headers,
 *   or service worker interception before passing the result in.
 * @param {Object} [options]
 * @param {number} [options.pitchShift=1.0]
 *   Playback rate multiplier (0.5–2.0). 1.0 = original pitch.
 * @param {number} [options.startOffset=0]
 *   Where in the file to begin the excerpt, in seconds.
 * @param {number} [options.duration=null]
 *   How many seconds of audio to keep. null → keep from startOffset to end.
 *   The trimmed excerpt is copied into a new AudioBuffer; the rest is discarded.
 * @returns {Promise<Bell>}
 * @throws {Error} If the fetch fails, the response is not OK, the format is
 *   unsupported, or the trim parameters fall outside the file duration.
 */
async function createExternalBellFromFile(urlOrResponse, {
  pitchShift  = 1.0,
  startOffset = 0,
  duration    = null,
} = {}) {
  _assertPitchShift(pitchShift, 'createExternalBellFromFile');
  if (typeof startOffset !== 'number' || startOffset < 0) {
    throw new RangeError(
      `createExternalBellFromFile: startOffset must be a non-negative number (got ${startOffset})`
    );
  }
  if (duration !== null && (typeof duration !== 'number' || duration <= 0)) {
    throw new RangeError(
      `createExternalBellFromFile: duration must be a positive number or null (got ${duration})`
    );
  }
  const actx = _getActx();

  // ── Fetch ─────────────────────────────────────────────────────────────────
  let response;
  if (urlOrResponse instanceof Response) {
    response = urlOrResponse;
  } else {
    try {
      response = await fetch(urlOrResponse);
    } catch (err) {
      throw new Error(
        `createExternalBellFromFile: network error fetching "${urlOrResponse}": ${err.message}`
      );
    }
  }

  if (!response.ok) {
    throw new Error(
      `createExternalBellFromFile: fetch failed for "${response.url}" ` +
      `(HTTP ${response.status} ${response.statusText})`
    );
  }

  const arrayBuf = await response.arrayBuffer();

  // ── Decode ────────────────────────────────────────────────────────────────
  let fullBuf;
  try {
    fullBuf = await actx.decodeAudioData(arrayBuf);
  } catch (err) {
    const src = urlOrResponse instanceof Response ? response.url : urlOrResponse;
    throw new Error(
      `createExternalBellFromFile: could not decode "${src}" — ` +
      `unsupported or corrupted file. ` +
      `Supported formats: mp3, wav, ogg/vorbis, aac, flac, opus.`
    );
  }

  // ── Validate trim parameters ──────────────────────────────────────────────
  const fileDuration = fullBuf.duration;

  if (startOffset < 0 || startOffset >= fileDuration) {
    throw new Error(
      `createExternalBellFromFile: startOffset ${startOffset}s is out of range ` +
      `(file duration is ${fileDuration.toFixed(2)}s)`
    );
  }

  const maxDuration  = fileDuration - startOffset;
  const trimDuration = duration === null ? maxDuration : Math.min(duration, maxDuration);

  // ── Trim: copy excerpt into a new AudioBuffer ─────────────────────────────
  // Only the excerpt is kept in memory; the full decoded buffer is discarded.
  const sampleRate   = fullBuf.sampleRate;
  const startSample  = Math.floor(startOffset  * sampleRate);
  const trimSamples  = Math.ceil (trimDuration * sampleRate);
  const nChannels    = fullBuf.numberOfChannels;

  const trimBuf = actx.createBuffer(nChannels, trimSamples, sampleRate);
  for (let ch = 0; ch < nChannels; ch++) {
    trimBuf.copyToChannel(
      fullBuf.getChannelData(ch).subarray(startSample, startSample + trimSamples),
      ch
    );
  }
  // fullBuf goes out of scope here and will be garbage collected.

  // ── Build Bell ────────────────────────────────────────────────────────────
  const analyser  = actx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.connect(actx.destination);

  function _strike({ masterGain = 1.0, stopAtSec = 0, msFade = 300, offsetSec = 0 } = {}) {
    if (actx.state === 'suspended') actx.resume();

    const t0  = actx.currentTime + 0.005 + offsetSec;
    const bus = actx.createGain();
    bus.gain.value = masterGain;
    bus.connect(analyser);

    if (stopAtSec > 0) {
      const cutAt    = t0 + stopAtSec;
      const fadesSec = Math.max(0.005, msFade / 1000);
      bus.gain.setValueAtTime(masterGain, cutAt - fadesSec);
      bus.gain.linearRampToValueAtTime(0, cutAt);
    }

    const src              = actx.createBufferSource();
    src.buffer             = trimBuf;
    src.playbackRate.value = pitchShift;
    src.connect(bus);
    src.start(t0);

    const naturalEnd = t0 + trimBuf.duration / pitchShift;
    setTimeout(() => { try { bus.disconnect(); } catch (_) {} },
      (naturalEnd - actx.currentTime + 1) * 1000);

    function stop(ms = 300) {
      const now      = actx.currentTime;
      const fadeSecs = Math.max(0.005, ms / 1000);
      bus.gain.cancelScheduledValues(now);
      bus.gain.setValueAtTime(bus.gain.value, now);
      bus.gain.linearRampToValueAtTime(0, now + fadeSecs);
      setTimeout(() => { try { src.stop(); bus.disconnect(); } catch (_) {} },
        (fadeSecs + 0.1) * 1000);
    }

    return { stop };
  }

  return { type: 'file', analyser, _strike };
}

/**
 * Strikes a bell and returns a handle to stop it early.
 *
 * Works identically with synthetic and file-based bells.
 *
 * @example
 * const handle = strikeBell(myBell, { stopAtSec: 7, msFade: 300 });
 * setTimeout(() => handle.stop(300), 2000);
 *
 * @param {Bell}          bell    - Bell created by createInternalSyntheticBell or createExternalBellFromFile.
 * @param {StrikeOptions} [opts]
 * @returns {StrikeHandle}
 */
function strikeBell(bell, opts = {}) {
  _assertBell(bell, 'strikeBell');
  if (bell === null) return { stop: () => {} }; // no-op handle for silent call
  return bell._strike(opts);
}


// ---------------------------------------------------------------------------
// SECTION 3 — PATTERNS
// Named timing patterns kept as reference. createSequencer has been removed
// as the breathing-exercise PWA drives its own timing loop.
// ---------------------------------------------------------------------------

/**
 * Named timing patterns: arrays of millisecond offsets from the first strike.
 * Kept as reference for future use; not consumed by the current UI.
 * @type {Object.<string, number[]>}
 */
const PATTERNS = {
  slow:     [0, 3000, 6000, 9000, 12000, 15000],
  carillon: [0, 130, 260, 390, 520, 780, 910, 1040, 1300, 1560, 1820, 2080],
};


// ---------------------------------------------------------------------------
// SECTION 4 — BREATHING API
// ---------------------------------------------------------------------------

/**
 * Strikes a bell for one inhale or exhale phase of a breathing cycle,
 * then resolves when the phase is complete.
 *
 * Works with both synthetic and file-based bells.
 *
 * @example
 * const inhale = createInternalSyntheticBell(BELLS[0]);
 * const exhale = createInternalSyntheticBell(BELLS[0], { pitchShift: 0.9 });
 *
 * while (running) {
 *   await strikeBreath(inhale, { stopAtSec: 4, phaseDuration: 4 });  // inhale
 *   await strikeBreath(null,   { phaseDuration: 4 });                 // hold (silent)
 *   await strikeBreath(exhale, { stopAtSec: 4, phaseDuration: 4 });  // exhale
 *   await strikeBreath(null,   { phaseDuration: 4 });                 // hold (silent)
 * }
 *
 * @param {Bell|null} bell
 *   Bell to strike. Pass null for a silent hold phase.
 * @param {Object} options
 * @param {number} [options.masterGain=1.0]
 *   Overall loudness (0.0–1.5). Defaults to 1.0 — use device volume to
 *   control loudness. Values above 1.0 may distort on phone speakers.
 * @param {number} [options.noiseAmt=0.15]
 *   Strike-noise amplitude (0–0.5). Set to 0 to silence the transient click.
 * @param {number} [options.stopAtSec=0]
 *   Scheduled stop time in seconds. Use 0 for a free-ringing bell.
 * @param {number} options.phaseDuration
 *   Total length of this breath phase in seconds. The returned Promise
 *   resolves exactly when phaseDuration has elapsed.
 * @param {number} [options.msFade=300]
 *   Fade duration in milliseconds at the stopAtSec cutoff.
 * @returns {Promise<void>} Resolves when phaseDuration has elapsed.
 */
function strikeBreath(bell, {
  masterGain    = 1.0,
  noiseAmt      = 0.15,
  stopAtSec     = 0,
  phaseDuration,
  msFade        = 300,
} = {}) {
  _assertBell(bell, 'strikeBreath');
  if (typeof phaseDuration !== 'number' || phaseDuration <= 0) {
    throw new RangeError(
      `strikeBreath: phaseDuration must be a positive number (got ${phaseDuration})`
    );
  }
  if (bell) {
    bell._strike({ masterGain, noiseAmt, stopAtSec, msFade });
  }
  return new Promise(resolve => setTimeout(resolve, phaseDuration * 1000));
}

export { createInternalSyntheticBell, createExternalBellFromFile, strikeBell, strikeBreath, blendBells, BELLS };
