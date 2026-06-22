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

    async function startStreaming(cfg, ch) {
      stopStreams()
      if (destroyed) return
      report('connecting')

      try {
        const audioConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        const [s1, s2] = await Promise.all([
          navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: cfg.vbCableInputDeviceId }, ...audioConstraints } }),
          navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: cfg.vbCableOutputDeviceId }, ...audioConstraints } })
        ])

        if (destroyed) { [s1, s2].forEach(s => s.getTracks().forEach(t => t.stop())); return }
        streamsRef.current = [s1, s2]

        const pc = new RTCPeerConnection({
          iceServers: buildIceServers(cfg),
          iceCandidatePoolSize: 10,
          bundlePolicy: 'max-bundle',
          rtcpMuxPolicy: 'require'
        })
        pcRef.current = pc

        s1.getAudioTracks().forEach(t => pc.addTrack(t, s1))
        s2.getAudioTracks().forEach(t => pc.addTrack(t, s2))

        pc.onicecandidate = ({ candidate }) => {
          if (candidate && ch) {
            ch.send({ type: 'broadcast', event: 'ice-candidate-laptop', payload: { candidate: candidate.toJSON() } })
          }
        }

        pc.onconnectionstatechange = () => {
          if (destroyed) return
          const state = pc.connectionState
          if (state === 'connected') report('streaming')
          else if (state === 'failed' || state === 'closed') {
            report('error')
            reconnectRef.current = setTimeout(() => { if (!destroyed) startStreaming(cfg, ch) }, 3000)
          } else if (state === 'connecting') report('connecting')
        }

        const offer = await pc.createOffer()
        if (destroyed) { pc.close(); return }
        await pc.setLocalDescription(offer)

        await ch.send({
          type: 'broadcast',
          event: 'webrtc-offer',
          payload: { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }
        })
      } catch (e) {
        console.error('[AudioStreamer] start failed:', e)
        if (!destroyed) report('error')
      }
    }

    async function init() {
      const [audioCfg, settings] = await Promise.all([
        window.api.getAudioConfig(),
        window.api.getSettings()
      ])
      if (destroyed) return

      if (!audioCfg.enabled || !audioCfg.vbCableInputDeviceId || !audioCfg.vbCableOutputDeviceId) {
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
        .subscribe(async (status) => {
          if (status === 'SUBSCRIBED' && !destroyed) {
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
