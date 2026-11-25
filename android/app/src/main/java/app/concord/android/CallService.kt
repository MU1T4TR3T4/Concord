package app.concord.android

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Serviço em primeiro plano (com notificação fixa). É o que o Android exige para um app continuar
 * usando o microfone e capturando a tela enquanto o usuário está em outro app, por exemplo no jogo.
 */
class CallService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP_SHARE) {
            ScreenShare.stop(notify = true)
            return START_NOT_STICKY
        }

        var type = 0
        if (sharing) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        if (inCall && hasMic(this)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        if (type == 0) {
            stopSelf()
            return START_NOT_STICKY
        }

        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), type)
        } catch (e: Exception) {
            // O Android recusou (por exemplo, app fora da tela ao pedir o microfone).
            whenForeground = null
            if (sharing) ScreenShare.fail("O Android não permitiu iniciar a transmissão.")
            stopSelf()
            return START_NOT_STICKY
        }

        if (wakeLock == null) {
            val power = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "concord:call").apply { acquire() }
        }

        whenForeground?.let {
            whenForeground = null
            it()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    private fun notification(): Notification {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Chamada em andamento", NotificationManager.IMPORTANCE_LOW),
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle("Concord")
            .setContentText(if (sharing) "Transmitindo a sua tela" else "Você está em uma sala de voz")
            .setContentIntent(open)
            .setOngoing(true)
        if (sharing) {
            val stop = PendingIntent.getService(
                this, 1, Intent(this, CallService::class.java).setAction(ACTION_STOP_SHARE), PendingIntent.FLAG_IMMUTABLE,
            )
            builder.addAction(0, "Parar transmissão", stop)
        }
        return builder.build()
    }

    companion object {
        private const val CHANNEL = "call"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_STOP_SHARE = "app.concord.android.STOP_SHARE"

        /** Estou em uma sala de voz (informado pela página). */
        var inCall = false

        /** Estou transmitindo a tela. */
        var sharing = false

        /** Roda uma vez, assim que o serviço estiver de fato em primeiro plano. */
        var whenForeground: (() -> Unit)? = null

        private fun hasMic(context: Context) =
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

        /** Liga, atualiza ou desliga o serviço conforme o estado atual. */
        fun sync(context: Context) {
            val intent = Intent(context, CallService::class.java)
            // O tipo "microfone" só pode ser usado depois que a permissão existe.
            val needed = sharing || (inCall && hasMic(context))
            if (!needed) {
                context.stopService(intent)
                return
            }
            try {
                ContextCompat.startForegroundService(context, intent)
            } catch (e: Exception) {
                // Android 12+ bloqueia iniciar serviço com o app em segundo plano; a chamada segue sem ele.
                if (Build.VERSION.SDK_INT >= 31) whenForeground = null
            }
        }
    }
}
