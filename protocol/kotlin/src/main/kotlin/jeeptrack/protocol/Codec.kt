package jeeptrack.protocol

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** JeepTrack wire protocol v1 — see protocol/SPEC.md. Units are the raw wire units. */
data class Report(
    val version: Int,
    val jeepId: Int,
    val seq: Long,
    val ts: Long,
    val latE7: Int,
    val lonE7: Int,
    val speedCms: Int,
    val headingCdeg: Int,
    val accuracyDm: Int,
    val flags: Int,
)

class ProtocolError(val code: String, message: String = code) : Exception(message)

object Codec {
    const val REPORT_LEN = 28
    private val b64enc = Base64.getUrlEncoder().withoutPadding()
    private val b64dec = Base64.getUrlDecoder()
    private val b64chars = Regex("^[A-Za-z0-9_-]+$")

    fun crc16(b: ByteArray, len: Int = b.size): Int {
        var crc = 0xFFFF
        for (i in 0 until len) {
            crc = crc xor ((b[i].toInt() and 0xFF) shl 8)
            repeat(8) { crc = if (crc and 0x8000 != 0) ((crc shl 1) xor 0x1021) and 0xFFFF else (crc shl 1) and 0xFFFF }
        }
        return crc
    }

    private fun check(name: String, v: Long, min: Long, max: Long) {
        if (v < min || v > max) throw ProtocolError("range", "$name out of range: $v")
    }

    fun encode(r: Report): ByteArray {
        check("version", r.version.toLong(), 0, 0xFF)
        check("jeepId", r.jeepId.toLong(), 0, 0xFFFF)
        check("seq", r.seq, 0, 0xFFFFFFFFL)
        check("ts", r.ts, 0, 0xFFFFFFFFL)
        check("latE7", r.latE7.toLong(), -900000000, 900000000)
        check("lonE7", r.lonE7.toLong(), -1800000000, 1800000000)
        check("speedCms", r.speedCms.toLong(), 0, 0xFFFF)
        check("headingCdeg", r.headingCdeg.toLong(), 0, 35999)
        check("accuracyDm", r.accuracyDm.toLong(), 0, Long.MAX_VALUE)
        check("flags", r.flags.toLong(), 0, 0xFF)
        val buf = ByteBuffer.allocate(REPORT_LEN).order(ByteOrder.BIG_ENDIAN)
            .put(r.version.toByte())
            .putShort(r.jeepId.toShort())
            .putInt(r.seq.toInt())
            .putInt(r.ts.toInt())
            .putInt(r.latE7)
            .putInt(r.lonE7)
            .putShort(r.speedCms.toShort())
            .putShort(r.headingCdeg.toShort())
            .putShort(minOf(r.accuracyDm, 0xFFFF).toShort())
            .put(r.flags.toByte())
        val bytes = buf.array()
        buf.putShort(26, crc16(bytes, 26).toShort())
        return bytes
    }

    fun decode(b: ByteArray): Report {
        if (b.size != REPORT_LEN) throw ProtocolError("length", "expected $REPORT_LEN bytes, got ${b.size}")
        val buf = ByteBuffer.wrap(b).order(ByteOrder.BIG_ENDIAN)
        val version = buf.get(0).toInt() and 0xFF
        if (version != 1) throw ProtocolError("version", "unsupported version $version")
        if (crc16(b, 26) != (buf.getShort(26).toInt() and 0xFFFF)) throw ProtocolError("crc")
        return Report(
            version = version,
            jeepId = buf.getShort(1).toInt() and 0xFFFF,
            seq = buf.getInt(3).toLong() and 0xFFFFFFFFL,
            ts = buf.getInt(7).toLong() and 0xFFFFFFFFL,
            latE7 = buf.getInt(11),
            lonE7 = buf.getInt(15),
            speedCms = buf.getShort(19).toInt() and 0xFFFF,
            headingCdeg = buf.getShort(21).toInt() and 0xFFFF,
            accuracyDm = buf.getShort(23).toInt() and 0xFFFF,
            flags = buf.get(25).toInt() and 0xFF,
        )
    }

    private fun hmac8(key: ByteArray, data: ByteArray): ByteArray =
        Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }.doFinal(data).copyOf(8)

    fun smsEncode(r: Report, key: ByteArray): String {
        val data = encode(r)
        return "JT1:${b64enc.encodeToString(data)}:${b64enc.encodeToString(hmac8(key, data))}"
    }

    fun smsDecode(text: String, keyFor: (Int) -> ByteArray?): Report {
        if (!text.startsWith("JT1:")) throw ProtocolError("prefix")
        val parts = text.trim().split(":")
        if (parts.size != 3 || parts[1].length != 38 || parts[2].length != 11 ||
            !b64chars.matches(parts[1]) || !b64chars.matches(parts[2])
        ) throw ProtocolError("format")
        val data = b64dec.decode(parts[1])
        val r = decode(data)
        val key = keyFor(r.jeepId) ?: throw ProtocolError("unknown_jeep", "unknown jeep ${r.jeepId}")
        if (!MessageDigest.isEqual(hmac8(key, data), b64dec.decode(parts[2]))) throw ProtocolError("hmac")
        return r
    }
}
