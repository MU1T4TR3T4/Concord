package app.concord.android

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

/**
 * O app Android é uma janela (WebView) com a mesma interface web do Concord, mais o que o
 * navegador do celular não deixa fazer: capturar a tela e manter a chamada em segundo plano.
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private var pendingMic: PermissionRequest? = null
    private var pendingShare: ScreenShare.Params? = null

    private val micPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            pendingMic?.let { if (granted) it.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else it.deny() }
            pendingMic = null
            // Agora que o microfone foi liberado, o serviço em segundo plano pode assumir a chamada.
            CallService.sync(this)
        }

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    /** Resposta do aviso "Começar a gravar ou transmitir?" do Android. */
    private val projection =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val params = pendingShare
            pendingShare = null
            val data = result.data
            if (result.resultCode != RESULT_OK || data == null || params == null) {
                callJs("onShareError", "Transmissão cancelada.")
                return@registerForActivityResult
            }
            // O Android exige o serviço em primeiro plano ANTES de começar a capturar.
            CallService.sharing = true
            CallService.whenForeground = { ScreenShare.start(applicationContext, data, params) }
            CallService.sync(this)
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        web = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#120E1D"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.userAgentString += " ConcordAndroid/${BuildConfig.VERSION_NAME}"
            addJavascriptInterface(Bridge(), "ConcordNative")
            webViewClient = Client()
            webChromeClient = Chrome()
        }

        // A partir do Android 15 o app desenha atrás das barras do sistema; este recuo evita que a
        // interface fique embaixo da barra de status, da barra de navegação ou do teclado.
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#120E1D"))
            addView(web, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)

        // Botão "voltar": primeiro a página decide (voltar do chat para a lista); senão, minimiza.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("(window.__concordNative && window.__concordNative.back()) === true") { handled ->
                    if (handled != "true") moveTaskToBack(true)
                }
            }
        })

        ScreenShare.listener = object : ScreenShare.Listener {
            override fun onOffer(sdp: String, mid: String) = callJs("onOffer", sdp, mid)
            override fun onError(message: String) = callJs("onShareError", message)
            override fun onStopped() = callJs("onShareStopped")
        }

        web.loadUrl(urlFor(intent))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Um link de convite aberto com o app já rodando.
        if (intent.data?.scheme == "concord") web.loadUrl(urlFor(intent))
    }

    override fun onDestroy() {
        // Sem a página não há chamada nem para onde avisar: encerra tudo junto.
        ScreenShare.listener = null
        ScreenShare.stop(notify = false)
        CallService.inCall = false
        CallService.sharing = false
        CallService.sync(this)
        web.destroy()
        super.onDestroy()
    }

    /** concord://convite/CODIGO vira a página do convite; qualquer outra coisa abre o início. */
    private fun urlFor(intent: Intent?): String {
        val data = intent?.data
        val code = if (data?.scheme == "concord") data.lastPathSegment?.filter { it.isLetterOrDigit() } else null
        return if (code.isNullOrEmpty()) BASE_URL else "$BASE_URL/?convite=$code"
    }

    private fun callJs(function: String, vararg args: String) {
        val list = args.joinToString(",") { JSONObject.quote(it) }
        runOnUiThread {
            if (!isDestroyed) web.evaluateJavascript("window.__concordNative && window.__concordNative.$function($list)", null)
        }
    }

    private fun hasPermission(name: String) =
        ContextCompat.checkSelfPermission(this, name) == PackageManager.PERMISSION_GRANTED

    private fun requestShare(params: ScreenShare.Params) {
        if (ScreenShare.active) return
        pendingShare = params
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projection.launch(manager.createScreenCaptureIntent())
    }

    /** Funções que a página chama: window.ConcordNative.algumaCoisa(...). */
    private inner class Bridge {
        @JavascriptInterface
        fun startShare(width: Int, height: Int, fps: Int, bitrate: Int) = runOnUiThread {
            requestShare(ScreenShare.Params(width, height, fps, bitrate))
        }

        @JavascriptInterface
        fun setAnswer(sdp: String) = runOnUiThread { ScreenShare.setAnswer(sdp) }

        @JavascriptInterface
        fun stopShare() = runOnUiThread { ScreenShare.stop(notify = false) }

        @JavascriptInterface
        fun setInCall(inCall: Boolean) = runOnUiThread {
            CallService.inCall = inCall
            if (inCall && Build.VERSION.SDK_INT >= 33 && !hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
            CallService.sync(this@MainActivity)
        }
    }

    private inner class Client : WebViewClient() {
        // Só o Concord roda aqui dentro (é onde a ponte nativa fica exposta); o resto abre no navegador.
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            if (url.host == Uri.parse(BASE_URL).host) return false
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) = runOnUiThread {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE !in request.resources) return@runOnUiThread request.deny()
            if (hasPermission(Manifest.permission.RECORD_AUDIO)) {
                request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
            } else {
                pendingMic = request
                micPermission.launch(Manifest.permission.RECORD_AUDIO)
            }
        }
    }

    companion object {
        const val BASE_URL = "https://concord-server.concord-server.workers.dev"
    }
}
