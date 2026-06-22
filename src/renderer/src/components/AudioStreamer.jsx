import { useEffect, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'

export default function AudioStreamer({ onStatusChange }) {
  const statusCbRef = useRef(onStatusChange)
  statusCbRef.current = onStatusChange

  useEffect(() => {
    let destroyed = false
    let supabaseClient = null
    let supabaseChannel = null
    const pcRef = { current: null }
    const streamsRef = { current: [] }
    const reconnectRef = { current: null }
    // Keep the last-used cfg + ch so we can re-offer on request
    let lastCfg = null
    let lastCh = null

    function report(s) { if (!destroyed) statusCbRef.current(s) }

    function buildIceServers(cfg) {
      const servers = [{ urls: 'stun:stun.l.google.com:19302' }]
      if (cfg.mode === 'remote' && cfg.turnServer?.url) {
        servers.push({
          urls: cfg.turnServer.url,
          username: cfg.turnServer.username,
          credential: cfg.turnServer.credential
        })
      }
      return servers
    }

    function stopStreams() {
      if (reconnectRef.current) { clearTimeout(reconnectRef.current); reconnectRef.current = null }
      streamsRef.current.forEach(s => s.getTracks().forEach(t => t.stop()))
      streamsRef.current = []
      if (pcRef.current) { pcRef.current.close(); pcRef.current = null }
    }

    async function captureDevice(deviceId) {
      if (!deviceId) return null
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: deviceId },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        })
      } catch (e) {
        console.warn('[AudioStreamer] getUserMedia failed for device', deviceId, e.message)
        return null
      }
    }

    async function startStreaming(cfg, ch) {
      stopStreams()
      if (destroyed) return
      report('connecting')

      try {
        // Capture channel 1 (e.g. CABLE Output — captures caller audio from CABLE Input)
        const s1 = await captureDevice(cfg.channel1DeviceId)
        // Capture channel 2 (e.g. microphone — CSR voice). Optional.
        const s2 = await captureDevice(cfg.channel2DeviceId)

        const streams = [s1, s2].filter(Boolean)
        if (streams.length === 0) {
          console.error('[AudioStreamer] No audio devices could be captured')
          report('error')
          return
        }
        if (destroyed) { streams.forEach(s => s.getTracks().forEach(t => t.stop())); return }
        streamsRef.current = streams

        const pc = new RTCPeerConnection({
          iceServers: buildIceServers(cfg),
          iceCandidatePoolSize: 10,
          bundlePolicy: 'max-bundle',
          rtcpMuxPolicy: 'require'
        })
        pcRef.current = pc

        streams.forEach(s => s.getAudioTracks().forEach(t => pc.addTrack(t, s)))

        pc.onicecandidate = ({ candidate }) => {
          if (candidate && ch) {
            ch.send({ type: 'broadcast', event: 'ice-candidate-laptop', payload: { candidate: candidate.toJSON() } })
          }
        }

        pc.onconnectionstatechange = () => {
          if (destroyed) return
          const state = pc.connectionState
          console.log('[AudioStreamer] connection state:', state)
          if (state === 'connected') report('streaming')
          else if (state === 'failed' || state === 'closed') {
            report('error')
            reconnectRef.current = setTimeout(() => { if (!destroyed) startStreaming(cfg, ch) }, 3000)
          } else if (state === 'connecting') report('connecting')
        }

        const offer = await pc.createOffer()
        if (destroyed) { pc.close(); return }
        await pc.setLocalDescription(offer)

        const result = await ch.send({
          type: 'broadcast',
          event: 'webrtc-offer',
          payload: { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }
        })
        console.log('[AudioStreamer] offer sent, result:', result)
      } catch (e) {
        console.error('[AudioStreamer] startStreaming failed:', e)
        if (!destroyed) report('error')
      }
    }

    async function reoffer(ch) {
      // Resend existing offer or create a new one — for late-joining web clients
      if (!pcRef.current || !pcRef.current.localDescription) {
        if (lastCfg && lastCh) await startStreaming(lastCfg, lastCh)
        return
      }
      console.log('[AudioStreamer] re-sending offer on request')
      await ch.send({
        type: 'broadcast',
        event: 'webrtc-offer',
        payload: { sdp: { type: pcRef.current.localDescription.type, sdp: pcRef.current.localDescription.sdp } }
      })
    }

    async function init() {
      const [audioCfg, settings] = await Promise.all([
        window.api.getAudioConfig(),
        window.api.getSettings()
      ])
      if (destroyed) return

      // Need at least one device configured
      if (!audioCfg.enabled || (!audioCfg.channel1DeviceId && !audioCfg.channel2DeviceId)) {
        report('idle'); return
      }
      if (!settings.supabaseUrl || !settings.supabaseKey || !settings.agentId) {
        report('idle'); return
      }

      supabaseClient = createClient(settings.supabaseUrl, settings.supabaseKey)
      const ch = supabaseClient.channel(`webrtc-audio-${settings.agentId}`)
      supabaseChannel = ch

      ch
        .on('broadcast', { event: 'webrtc-answer' }, ({ payload }) => {
          if (pcRef.current && payload.sdp) {
            pcRef.current.setRemoteDescription(new RTCSessionDescription(payload.sdp))
              .catch(e => console.warn('[AudioStreamer] setRemoteDesc error:', e))
          }
        })
        .on('broadcast', { event: 'ice-candidate-web' }, ({ payload }) => {
          if (pcRef.current && payload.candidate) {
            pcRef.current.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(() => {})
          }
        })
        .on('broadcast', { event: 'request-offer' }, () => {
          // Web app opened or refreshed — resend the offer so they can connect
          reoffer(ch)
        })
        .subscribe(async (status) => {
          console.log('[AudioStreamer] channel status:', status)
          if (status === 'SUBSCRIBED' && !destroyed) {
            lastCfg = audioCfg
            lastCh = ch
            await startStreaming(audioCfg, ch)
          }
        })
    }

    init()

    return () => {
      destroyed = true
      stopStreams()
      if (supabaseClient && supabaseChannel) {
        supabaseClient.removeChannel(supabaseChannel)
      }
    }
  }, [])

  return null
}
