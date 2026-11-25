package app.concord.android

import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.media.projection.MediaProjection
import android.os.Handler
import android.os.Looper
import android.util.DisplayMetrics
import android.view.Display
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack

/**
 * Captura a tela do celular e envia o vídeo por uma conexão WebRTC própria até o SFU da Cloudflare.
 * A negociação passa pela página: daqui sai a "oferta" (onOffer) e volta a "resposta" (setAnswer).
 */
object ScreenShare {

    data class Params(val width: Int, val height: Int, val fps: Int, val bitrate: Int)

    interface Listener {
        fun onOffer(sdp: String, mid: String)
        fun onError(message: String)
        fun onStopped()
    }

    var listener: Listener? = null
    val active: Boolean get() = pc != null || starting

    private val main = Handler(Looper.getMainLooper())
    private var initialized = false
    private var starting = false
    private var appContext: Context? = null
    private var params: Params? = null

    private var egl: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    private var pc: PeerConnection? = null
    private var capturer: ScreenCapturerAndroid? = null
    private var helper: SurfaceTextureHelper? = null
    private var source: VideoSource? = null
    private var track: VideoTrack? = null
    private var transceiver: RtpTransceiver? = null
    private var offerSent = false
    private var lastSize: Pair<Int, Int>? = null

    /** Precisa ser chamado com o serviço em primeiro plano já ativo (exigência do Android 14+). */
    fun start(context: Context, permission: Intent, p: Params) {
        if (pc != null) return
        starting = true
        appContext = context
        params = p
        offerSent = false
        try {
            if (!initialized) {
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions(),
                )
                initialized = true
            }
            val eglBase = EglBase.create().also { egl = it }
            val f = PeerConnectionFactory.builder()
                // Codificador de vídeo do próprio aparelho (H.264/VP8 por hardware), leve durante o jogo.
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
                .createPeerConnectionFactory()
                .also { factory = it }

            val cap = ScreenCapturerAndroid(permission, object : MediaProjection.Callback() {
                // O usuário parou pelo aviso do sistema (ou o Android encerrou a captura).
                override fun onStop() {
                    main.post { stop(notify = true) }
                }
            }).also { capturer = it }

            val h = SurfaceTextureHelper.create("ConcordScreen", eglBase.eglBaseContext).also { helper = it }
            val src = f.createVideoSource(true).also { source = it }
            cap.initialize(h, context, src.capturerObserver)
            val (w, h2) = captureSize(context, p)
            lastSize = w to h2
            cap.startCapture(w, h2, p.fps)
            val video = f.createVideoTrack("concord-screen", src).also { track = it }

            val config = PeerConnection.RTCConfiguration(
                listOf(PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer()),
            ).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
                continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
            }
            val conn = f.createPeerConnection(config, Observer()) ?: throw IllegalStateException("sem conexão")
            pc = conn
            transceiver = conn.addTransceiver(
                video, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY),
            )

            conn.createOffer(object : SimpleSdpObserver() {
                override fun onCreateSuccess(desc: SessionDescription) {
                    main.post {
                        pc?.setLocalDescription(object : SimpleSdpObserver() {
                            // Dá um tempo para a coleta de endereços; se demorar, manda o que tiver.
                            override fun onSetSuccess() {
                                main.postDelayed({ sendOffer() }, 3000)
                            }
                            override fun onSetFailure(error: String?) = main.post { fail("Falha ao preparar a transmissão.") }.let { }
                        }, desc)
                    }
                }
                override fun onCreateFailure(error: String?) = main.post { fail("Falha ao preparar a transmissão.") }.let { }
            }, MediaConstraints())

            // Girar o celular (jogo em paisagem) muda o formato da tela; a captura acompanha.
            val displays = context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
            displays.registerDisplayListener(displayListener, main)
            starting = false
        } catch (e: Exception) {
            starting = false
            fail("Não foi possível capturar a tela: ${e.message ?: "erro desconhecido"}")
        }
    }

    fun setAnswer(sdp: String) {
        val conn = pc ?: return
        conn.setRemoteDescription(object : SimpleSdpObserver() {
            override fun onSetSuccess() {
                main.post { applyBitrate() }
            }
            override fun onSetFailure(error: String?) = main.post { fail("O servidor recusou a transmissão.") }.let { }
        }, SessionDescription(SessionDescription.Type.ANSWER, sdp))
    }

    /** Encerra a captura. Com notify, avisa a página (quando quem parou não foi ela). */
    fun stop(notify: Boolean) {
        val wasActive = pc != null || capturer != null || CallService.sharing
        release()
        if (notify && wasActive) listener?.onStopped()
    }

    fun fail(message: String) {
        release()
        listener?.onError(message)
    }

    private fun release() {
        val context = appContext
        starting = false
        runCatching {
            (context?.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager)?.unregisterDisplayListener(displayListener)
        }
        runCatching { capturer?.stopCapture() }
        runCatching { capturer?.dispose() }
        runCatching { pc?.dispose() }
        runCatching { track?.dispose() }
        runCatching { source?.dispose() }
        runCatching { helper?.dispose() }
        runCatching { factory?.dispose() }
        runCatching { egl?.release() }
        capturer = null; pc = null; track = null; source = null; helper = null; factory = null; egl = null
        transceiver = null; lastSize = null; params = null

        CallService.sharing = false
        CallService.whenForeground = null
        if (context != null) CallService.sync(context)
    }

    private fun sendOffer() {
        val conn = pc ?: return
        if (offerSent) return
        val desc = conn.localDescription ?: return
        val mid = transceiver?.mid ?: return
        offerSent = true
        listener?.onOffer(desc.description, mid)
    }

    private fun applyBitrate() {
        val p = params ?: return
        val sender = transceiver?.sender ?: return
        val parameters = sender.parameters
        parameters.encodings.firstOrNull()?.let {
            it.maxBitrateBps = p.bitrate
            it.maxFramerate = p.fps
        }
        sender.parameters = parameters
    }

    /** Tamanho da captura: o formato real da tela, reduzido para caber na qualidade escolhida. */
    private fun captureSize(context: Context, p: Params): Pair<Int, Int> {
        val displays = context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        displays.getDisplay(Display.DEFAULT_DISPLAY).getRealMetrics(metrics)
        val w = metrics.widthPixels.toDouble()
        val h = metrics.heightPixels.toDouble()
        val long = maxOf(p.width, p.height).toDouble()
        val short = minOf(p.width, p.height).toDouble()
        val scale = minOf(1.0, long / maxOf(w, h), short / minOf(w, h))
        // Codificadores de vídeo pedem dimensões pares.
        fun even(v: Double) = (v * scale).toInt().let { it - it % 2 }.coerceAtLeast(2)
        return even(w) to even(h)
    }

    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) {}
        override fun onDisplayRemoved(displayId: Int) {}
        override fun onDisplayChanged(displayId: Int) {
            val context = appContext ?: return
            val p = params ?: return
            val cap = capturer ?: return
            if (displayId != Display.DEFAULT_DISPLAY) return
            val size = captureSize(context, p)
            if (size == lastSize) return
            lastSize = size
            runCatching { cap.changeCaptureFormat(size.first, size.second, p.fps) }
        }
    }

    private class Observer : PeerConnection.Observer {
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
            if (state == PeerConnection.IceGatheringState.COMPLETE) main.post { sendOffer() }
        }
        override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
            if (state == PeerConnection.PeerConnectionState.FAILED) main.post { stop(notify = true) }
        }
        override fun onSignalingChange(state: PeerConnection.SignalingState) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {}
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceCandidate(candidate: IceCandidate) {}
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
        override fun onAddStream(stream: MediaStream) {}
        override fun onRemoveStream(stream: MediaStream) {}
        override fun onDataChannel(channel: org.webrtc.DataChannel) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {}
        override fun onTrack(transceiver: RtpTransceiver) {}
    }

    private open class SimpleSdpObserver : SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String?) {}
        override fun onSetFailure(error: String?) {}
    }

    @Suppress("unused")
    private val keepTypes: Class<*> = MediaStreamTrack::class.java
}
