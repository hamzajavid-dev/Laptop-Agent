import { useEffect, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'

const SAMPLE_RATE = 16000  // 16kHz — standard for voice
const BUFFER_SIZE = 2048   // ~128ms per chunk at 16kHz

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

    function report(s) { if (!destroyed) cbRef.current(s) }

    function stopAll() {
      capturedStreams.forEach(s => s.getTracks().forEach(t => t.stop()))
      capturedStreams = []
      if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null }
    }

    async function captureDevice(deviceId) {
      if (!deviceId) return null
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { ideal: deviceId },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        })
        console.log('[AudioStreamer] captured device:', deviceId)
        return stream
      } catch (e) {
        console.error('[AudioStreamer] getUserMedia failed for', deviceId, '-', e.name, e.message)
        return null
      }
    }

    async function startStreaming(cfg, ch) {
      stopAll()
      if (destroyed) return
      report('connecting')

      const s1 = await captureDevice(cfg.channel1DeviceId)
      const s2 = await captureDevice(cfg.channel2DeviceId)
      const streams = [s1, s2].filter(Boolean)

      if (streams.length === 0) {
        console.error('[AudioStreamer] No devices captured — check Settings > Audio Streaming > Scan Devices')
        report('error')
        return
      }
      if (destroyed) { streams.forEach(s => s.getTracks().forEach(t => t.stop())); return }

      capturedStreams = streams
      audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE })

      // Silent gain node — keeps audio graph alive without local playback
      const sink = audioCtx.createGain()
      sink.gain.value = 0
      sink.connect(audioCtx.destination)

      streams.forEach((stream, chIndex) => {
        const source = audioCtx.createMediaStreamSource(stream)
        const processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1)

        processor.onaudioprocess = (e) => {
          if (destroyed) return
          const samples = new Float32Array(e.inputBuffer.getChannelData(0))
          ch.send({
            type: 'broadcast',
            event: 'audio-chunk',
            payload: { ch: chIndex, d: encodeChunk(samples), sr: SAMPLE_RATE }
          }).catch(() => {})
        }

        source.connect(processor)
        processor.connect(sink)
      })

      report('streaming')
      console.log('[AudioStreamer] streaming', streams.length, 'channel(s) via Supabase Broadcast')
    }

    async function init() {
      const [audioCfg, settings] = await Promise.all([
        window.api.getAudioConfig(),
        window.api.getSettings()
      ])
      if (destroyed) return

      console.log('[AudioStreamer] config:', JSON.stringify({ enabled: audioCfg.enabled, ch1: audioCfg.channel1DeviceId?.slice(0,12), ch2: audioCfg.channel2DeviceId?.slice(0,12) }))

      if (!audioCfg.enabled || (!audioCfg.channel1DeviceId && !audioCfg.channel2DeviceId)) {
        report('idle'); return
      }
      if (!settings.supabaseUrl || !settings.supabaseKey || !settings.agentId) {
        console.error('[AudioStreamer] Missing Supabase settings')
        report('idle'); return
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
          if (!destroyed) report('error')
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
