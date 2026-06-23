import { useEffect, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'

// WebRTC offerer: captures the selected audio device(s) and sends them to the
// web dashboard over a peer connection. Supabase Broadcast is used only for the
// tiny signaling handshake (offer/answer/ICE) — the audio itself flows P2P, or
// via the configured TURN relay when the phone is on a different network.

function iceServers(turn) {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }]
  if (turn?.url) {
    // Accept several comma/space/newline-separated URLs sharing one credential —
    // mobile networks often need the TCP/443 + turns: variants to get through.
    const urls = turn.url.split(/[\s,]+/).filter(Boolean)
    if (urls.length) servers.push({ urls, username: turn.username || '', credential: turn.credential || '' })
  }
  return servers
}

export default function AudioStreamer({ onStatusChange }) {
  const cbRef = useRef(onStatusChange)
  cbRef.current = onStatusChange

  useEffect(() => {
    let destroyed = false
    let supabaseClient = null
    let channel = null
    let pc = null
    let localStream = null
    let lastCaptureError = ''
    let captureWarnings = []

    function report(s, detail = '') { if (!destroyed) cbRef.current(s, detail) }

    function closePc() {
      if (pc) {
        pc.onicecandidate = null
        pc.onconnectionstatechange = null
        try { pc.close() } catch (_) {}
        pc = null
      }
    }

    function stopAll() {
      closePc()
      if (localStream) {
        localStream.getTracks().forEach(t => t.stop())
        localStream = null
      }
    }

    // Special sentinel: capture the PC's audio output (loopback) instead of a
    // recording device — used to grab the caller's voice with no extra software.
    const SYSTEM_AUDIO = '__system__'

    async function captureSystemAudio() {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        lastCaptureError = 'getDisplayMedia unavailable (system audio capture not supported)'
        console.error('[AudioStreamer]', lastCaptureError)
        return null
      }
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        // We only want the loopback audio — drop the video track immediately.
        stream.getVideoTracks().forEach(t => { t.stop(); stream.removeTrack(t) })
        if (stream.getAudioTracks().length === 0) {
          lastCaptureError = 'System audio capture returned no audio track'
          console.error('[AudioStreamer]', lastCaptureError)
          return null
        }
        console.log('[AudioStreamer] captured system audio (loopback)')
        return stream
      } catch (e) {
        lastCaptureError = `${e.name}: ${e.message}`
        console.error('[AudioStreamer] getDisplayMedia failed -', lastCaptureError)
        return null
      }
    }

    function captureChannel(deviceId) {
      if (!deviceId) return null
      if (deviceId === SYSTEM_AUDIO) return captureSystemAudio()
      return captureDevice(deviceId)
    }

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

    // Builds (or rebuilds) the local capture stream once; reused across renegotiations.
    // Tracks per-channel failures so a partial failure (e.g. soundboard OK but
    // System Audio failed) is reported instead of silently streaming one channel.
    async function ensureLocalStream(cfg) {
      if (localStream) return localStream
      captureWarnings = []
      const combined = new MediaStream()

      for (const [key, label] of [['channel1DeviceId', 'Channel 1'], ['channel2DeviceId', 'Channel 2']]) {
        const id = cfg[key]
        if (!id) continue
        lastCaptureError = ''
        const s = await captureChannel(id)
        if (s) {
          s.getAudioTracks().forEach(t => combined.addTrack(t))
        } else {
          captureWarnings.push(`${label} (${id === '__system__' ? 'System Audio' : 'device'}) failed: ${lastCaptureError || 'no audio'}`)
        }
      }

      if (combined.getAudioTracks().length === 0) return null
      console.log('[AudioStreamer] capturing', combined.getAudioTracks().length, 'track(s);', captureWarnings.length, 'warning(s)')
      localStream = combined
      return combined
    }

    // (Re)create the peer connection and send a fresh offer. Called whenever a
    // viewer announces it is ready (initial connect or phone reload/reconnect).
    async function makeOffer(cfg, turn, ch) {
      if (destroyed) return
      closePc()

      const stream = await ensureLocalStream(cfg)
      if (!stream) {
        report('error', lastCaptureError || 'No audio devices could be captured')
        return
      }

      report('connecting')
      pc = new RTCPeerConnection({
        iceServers: iceServers(turn),
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
      })

      stream.getTracks().forEach(t => pc.addTrack(t, stream))

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          ch.send({ type: 'broadcast', event: 'ice', payload: { from: 'laptop', candidate: e.candidate } }).catch(() => {})
        }
      }

      pc.onconnectionstatechange = () => {
        if (destroyed || !pc) return
        const st = pc.connectionState
        console.log('[AudioStreamer] pc state:', st)
        const warn = captureWarnings.join(' | ')
        if (st === 'connected') report('streaming', warn)
        else if (st === 'connecting' || st === 'new') report('connecting', warn)
        else if (st === 'failed') report('error', 'WebRTC connection failed (check TURN server)')
        else if (st === 'disconnected') report('connecting', 'Reconnecting…')
      }

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      ch.send({ type: 'broadcast', event: 'offer', payload: { sdp: pc.localDescription } }).catch(() => {})
      console.log('[AudioStreamer] sent offer with', stream.getTracks().length, 'track(s)')
    }

    async function init() {
      const [audioCfg, settings] = await Promise.all([
        window.api.getAudioConfig(),
        window.api.getSettings()
      ])
      if (destroyed) return

      console.log('[AudioStreamer] config:', JSON.stringify({
        enabled: audioCfg.enabled,
        ch1: audioCfg.channel1DeviceId?.slice(0, 12),
        ch2: audioCfg.channel2DeviceId?.slice(0, 12),
        turn: audioCfg.turnServer?.url ? 'set' : 'none'
      }))

      if (!audioCfg.enabled) {
        report('idle', 'Turn the toggle ON, then Save'); return
      }
      if (!audioCfg.channel1DeviceId && !audioCfg.channel2DeviceId) {
        report('idle', 'No device selected — pick CABLE Output for Channel 1'); return
      }
      if (!settings.supabaseUrl || !settings.supabaseKey || !settings.agentId) {
        report('idle', 'Missing Supabase URL / Key / Agent ID'); return
      }

      const turn = audioCfg.turnServer
      supabaseClient = createClient(settings.supabaseUrl, settings.supabaseKey)
      const ch = supabaseClient.channel(`audio-rtc-${settings.agentId}`, {
        config: { broadcast: { self: false } }
      })
      channel = ch

      // A viewer (phone) joined or reloaded → start a fresh negotiation.
      ch.on('broadcast', { event: 'viewer-ready' }, () => {
        console.log('[AudioStreamer] viewer-ready → creating offer')
        makeOffer(audioCfg, turn, ch)
      })

      ch.on('broadcast', { event: 'answer' }, async ({ payload }) => {
        if (!pc) return
        try {
          await pc.setRemoteDescription(payload.sdp)
          console.log('[AudioStreamer] applied answer')
        } catch (e) {
          console.error('[AudioStreamer] setRemoteDescription(answer) failed', e)
        }
      })

      ch.on('broadcast', { event: 'ice' }, async ({ payload }) => {
        if (payload.from !== 'viewer' || !pc) return
        try { await pc.addIceCandidate(payload.candidate) } catch (e) { console.warn('[AudioStreamer] addIceCandidate failed', e) }
      })

      ch.subscribe(async (status, err) => {
        console.log('[AudioStreamer] signaling channel:', status, err || '')
        if (status === 'SUBSCRIBED' && !destroyed) {
          // Pre-capture so the device error (if any) surfaces immediately, and
          // invite any viewer already waiting to (re)announce itself.
          const stream = await ensureLocalStream(audioCfg)
          if (!stream) { report('error', lastCaptureError || 'No audio devices could be captured'); return }
          report('connecting', captureWarnings.length ? captureWarnings.join(' | ') : 'Waiting for dashboard…')
          ch.send({ type: 'broadcast', event: 'streamer-ready', payload: {} }).catch(() => {})
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          report('error', `Supabase channel ${status.toLowerCase().replace('_', ' ')}`)
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
