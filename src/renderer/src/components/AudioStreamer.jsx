import { useEffect, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'

const SAMPLE_RATE = 16000  // 16kHz — standard for voice
const BUFFER_SIZE = 1024   // ~64ms per chunk at 16kHz (low latency; ~16 msgs/s per channel)

function encodeChunk(float32) {
  const int16 = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768))
  }
  const bytes = new Uint8Array(int16.buffer)
  let s = ''
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

export default function AudioStreamer({ onStatusChange }) {
  const cbRef = useRef(onStatusChange)
  cbRef.current = onStatusChange

  useEffect(() => {
    let destroyed = false
    let supabaseClient = null
    let channel = null
    let audioCtx = null
    let capturedStreams = []

    function report(s, detail = '') { if (!destroyed) cbRef.current(s, detail) }

    function stopAll() {
      capturedStreams.forEach(s => s.getTracks().forEach(t => t.stop()))
      capturedStreams = []
      if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null }
    }

    let lastCaptureError = ''

    async function captureDevice(deviceId) {
      if (!deviceId) return null
      if (!navigator.mediaDevices?.getUserMedia) {
        lastCaptureError = 'navigator.mediaDevices unavailable (check Electron secure context)'
        console.error('[AudioStreamer]', lastCaptureError)
        return null
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: deviceId },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        })
        console.log('[AudioStreamer] captured device:', deviceId)
        return stream
      } catch (e) {
        lastCaptureError = `${e.name}: ${e.message}`
        console.error('[AudioStreamer] getUserMedia failed for', deviceId, '-', lastCaptureError)
        return null
      }
    }

    async function startStreaming(cfg, ch) {
      stopAll()
      if (destroyed) return
      report('connecting')
      lastCaptureError = ''

      const s1 = await captureDevice(cfg.channel1DeviceId)
      const s2 = await captureDevice(cfg.channel2DeviceId)
      const streams = [s1, s2].filter(Boolean)

      if (streams.length === 0) {
        const detail = lastCaptureError || 'No audio devices could be captured'
        console.error('[AudioStreamer]', detail)
        report('error', detail)
        return
      }
      if (destroyed) { streams.forEach(s => s.getTracks().forEach(t => t.stop())); return }

      capturedStreams = streams
      audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE })
      // Electron may start AudioContext suspended (autoplay policy); resume explicitly
      // so onaudioprocess fires immediately without needing a user gesture.
      await audioCtx.resume()

      // Silent gain node — keeps audio graph alive without local playback
      const sink = audioCtx.createGain()
      sink.gain.value = 0
      sink.connect(audioCtx.destination)

      let sentCount = 0
      let peak = 0
      streams.forEach((stream, chIndex) => {
        const source = audioCtx.createMediaStreamSource(stream)
        const processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1)

        processor.onaudioprocess = (e) => {
          if (destroyed) return
          const samples = new Float32Array(e.inputBuffer.getChannelData(0))
          for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a }
          sentCount++
          ch.send({
            type: 'broadcast',
            event: 'audio-chunk',
            payload: { ch: chIndex, d: encodeChunk(samples), sr: SAMPLE_RATE }
          }).catch(() => {})
        }

        source.connect(processor)
        processor.connect(sink)
      })

      // Diagnostic: confirms chunks are being produced AND whether they carry signal.
      // peak ~0 for several seconds = correct device captured but it's silent (no audio on VB-Cable).
      const diag = setInterval(() => {
        if (destroyed) { clearInterval(diag); return }
        console.log(`[AudioStreamer] sent ${sentCount} chunks, peak level ${peak.toFixed(3)} ${peak < 0.001 ? '(SILENT — check the selected device is receiving audio)' : ''}`)
        sentCount = 0; peak = 0
      }, 3000)

      report('streaming')
      console.log('[AudioStreamer] streaming', streams.length, 'channel(s) via Supabase Broadcast on', ch.topic)
    }

    async function init() {
      const [audioCfg, settings] = await Promise.all([
        window.api.getAudioConfig(),
        window.api.getSettings()
      ])
      if (destroyed) return

      console.log('[AudioStreamer] config:', JSON.stringify({ enabled: audioCfg.enabled, ch1: audioCfg.channel1DeviceId?.slice(0,12), ch2: audioCfg.channel2DeviceId?.slice(0,12) }))

      if (!audioCfg.enabled) {
        report('idle', 'Turn the toggle ON, then Save'); return
      }
      if (!audioCfg.channel1DeviceId && !audioCfg.channel2DeviceId) {
        report('idle', 'No device selected — pick CABLE Output for Channel 1'); return
      }
      if (!settings.supabaseUrl || !settings.supabaseKey || !settings.agentId) {
        console.error('[AudioStreamer] Missing Supabase settings')
        report('idle', 'Missing Supabase URL / Key / Agent ID'); return
      }

      supabaseClient = createClient(settings.supabaseUrl, settings.supabaseKey)
      const ch = supabaseClient.channel(`audio-stream-${settings.agentId}`, {
        config: { broadcast: { self: false } }
      })
      channel = ch

      ch.subscribe(async (status, err) => {
        console.log('[AudioStreamer] Supabase channel:', status, err || '')
        if (status === 'SUBSCRIBED' && !destroyed) {
          await startStreaming(audioCfg, ch)
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          if (!destroyed) report('error', `Supabase channel ${status.toLowerCase().replace('_', ' ')}`)
        }
      })
    }

    init()

    return () => {
      destroyed = true
      stopAll()
      if (supabaseClient && channel) supabaseClient.removeChannel(channel)
    }
  }, [])

  return null
}
